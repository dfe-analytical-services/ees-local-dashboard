import http from 'node:http';
import https from 'node:https';
import type { ProcessStatus } from './processManager';
import { projectRoot, ServiceName, serviceSchemas } from './services';
import { webApps, webAppServices } from './webAppHealth';

/**
 * Actively probes each running web app's homepage, so a UI that stopped
 * answering gets reported even when its logs match no known failure
 * signature.
 *
 * The log scan in webAppHealth.ts can only catch failures someone has already
 * hit and written a pattern for. The most complete failure needs neither: the
 * admin app's dev server crashing on startup leaves admin 'running', its port
 * held, its logs matching nothing - and every request to it hanging until the
 * browser gives up. Whatever a future dev server dies of, "the homepage never
 * answers" is what it will look like from a browser, so that's what this
 * checks for.
 */

/**
 * How often to probe. Frequent enough that a dead UI is reported within a
 * couple of minutes, infrequent enough that the requests (each of which a dev
 * server may answer by compiling) cost the services nothing noticeable.
 */
export const PROBE_INTERVAL_MS = 30_000;

/**
 * How long one probe waits before counting as unanswered. Deliberately far
 * beyond what any healthy page takes: the requests this exists to catch hang
 * *forever* (the incident that prompted it logged one at two hours), so a
 * generous timeout costs detection almost nothing and keeps a slow on-demand
 * compile - the frontend building a page the probe itself asked for - from
 * looking like a hang.
 */
export const PROBE_TIMEOUT_MS = 30_000;

/**
 * Unanswered probes in a row before the app is reported unresponsive. One
 * timeout can be a cold compile that ran long; two, half a minute apart with
 * the first probe having already warmed the compile, means nobody's home.
 */
export const FAILURES_BEFORE_FLAGGING = 2;

/**
 * How long a running service gets before it's probed despite its dev server
 * never having reported in (see {@link devServerUpPatterns}). Without this
 * fallback a dev server that crashed before compiling anything - the very
 * case that motivated probing - would gate the probe off forever.
 */
export const DEV_SERVER_GRACE_MS = 10 * 60_000;

/**
 * The log line that says a service's dev server is actually up and answering,
 * which is what makes an unanswered probe mean something. Probing before this
 * would time out against admin's first webpack compile, which legitimately
 * takes minutes from cold.
 *
 * For admin that's webpack's compile result - any result, because even
 * 'Failed to compile' is served (as the error overlay), so the page answers.
 * The frontend is its own server and 'running' already waits for its ready
 * line (see `checkReady` in services.ts); it's listed anyway so the gate
 * reads the same for every service rather than special-casing which ones
 * have a line to wait for.
 */
const devServerUpPatterns: Partial<Record<ServiceName, RegExp>> = {
  admin: /Compiled successfully|Compiled with warnings|Failed to compile/,
  frontend: /Server started on /,
  frontendProd: /Server started on /,
};

/**
 * Whether anything at all answers at `url`. Any response counts, whatever its
 * status: a page that loads and shows an exception is the log scan's job to
 * explain, and this only asks about pages that never load. TLS verification
 * is off because admin serves the untrusted ASP.NET dev certificate.
 */
function probeUrl(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const onResponse = (response: http.IncomingMessage): void => {
      response.resume();
      resolve(true);
    };

    const request = url.startsWith('https:')
      ? https.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, onResponse)
      : http.get(url, { timeout: timeoutMs }, onResponse);

    // 'timeout' only says the socket went quiet; destroying the request is
    // what surfaces it as the 'error' below.
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

interface ProbeState {
  /** When this run was first seen 'running', for {@link DEV_SERVER_GRACE_MS}. */
  runningSince: number;
  /**
   * Whether this run's dev server has reported in. Sticky once seen, because
   * the log buffer it's read from is capped and the line scrolls away.
   */
  devServerUp: boolean;
  consecutiveFailures: number;
}

export interface WebAppProberDeps {
  getStatus: (service: ServiceName) => ProcessStatus;
  getLogs: (service: ServiceName) => readonly string[];
  /** The probe itself, injectable so tests don't open sockets. */
  probe?: (url: string, timeoutMs: number) => Promise<boolean>;
  /** The clock, injectable so tests don't wait out the grace period. */
  now?: () => number;
}

export interface WebAppProber {
  /** Probes every running web app once. Callers own the schedule. */
  checkNow: () => Promise<void>;
  /**
   * Whether the given service's homepage has stopped answering - returning
   * the issue to report, or undefined while it's answering (or simply not
   * running). Shaped like findWebAppFailure's result so callers can prefer
   * whichever of the two has more to say.
   */
  findUnresponsiveWebApp: (
    service: ServiceName,
  ) => { cause: string; message: string } | undefined;
}

export default function createWebAppProber({
  getStatus,
  getLogs,
  probe = probeUrl,
  now = Date.now,
}: WebAppProberDeps): WebAppProber {
  const states = new Map<ServiceName, ProbeState>();

  async function checkService(service: ServiceName, url: string): Promise<void> {
    if (getStatus(service) !== 'running') {
      // Whatever was known about the last run says nothing about the next
      // one, so a stop clears the failure count with it.
      states.delete(service);
      return;
    }

    let state = states.get(service);

    if (!state) {
      state = { runningSince: now(), devServerUp: false, consecutiveFailures: 0 };
      states.set(service, state);
    }

    const pattern = devServerUpPatterns[service];

    if (!state.devServerUp) {
      state.devServerUp =
        !pattern || getLogs(service).some(line => pattern.test(line));
    }

    if (
      !state.devServerUp &&
      now() - state.runningSince < DEV_SERVER_GRACE_MS
    ) {
      return;
    }

    const answered = await probe(url, PROBE_TIMEOUT_MS);

    // The probe can outlive the service: a stop that arrived while it hung
    // is why it hung, and counting that as a failure would greet the next
    // start with a stale strike against it.
    if (getStatus(service) !== 'running') {
      states.delete(service);
      return;
    }

    state.consecutiveFailures = answered ? 0 : state.consecutiveFailures + 1;
  }

  /**
   * Guards against ticks piling up: with the timeout as long as the interval,
   * a hanging probe would otherwise have the next tick probing alongside it.
   */
  let checking = false;

  async function checkNow(): Promise<void> {
    if (checking) {
      return;
    }

    checking = true;

    try {
      await Promise.all(
        webAppServices.flatMap(service => {
          const { url } = serviceSchemas[service];
          return url ? [checkService(service, url)] : [];
        }),
      );
    } finally {
      checking = false;
    }
  }

  function findUnresponsiveWebApp(
    service: ServiceName,
  ): { cause: string; message: string } | undefined {
    // Checked live rather than waiting for the next tick, so stopping a
    // broken service takes its banner down with it.
    if (getStatus(service) !== 'running') {
      return undefined;
    }

    const state = states.get(service);

    if (!state || state.consecutiveFailures < FAILURES_BEFORE_FLAGGING) {
      return undefined;
    }

    const { url } = serviceSchemas[service];
    const app = webApps[service];
    const cause = `nothing at ${url} is answering`;

    return {
      cause,
      message:
        `${app} isn't responding: ${service} reports itself running, but ` +
        `requests to ${url} keep going unanswered. Download the full log to ` +
        `see what its dev server did - if nothing there names a cause, ` +
        `node_modules or the build output being out of date is the usual ` +
        `one: run 'pnpm clean && pnpm i' in ${projectRoot}, then stop ` +
        `${service} and start it again.`,
    };
  }

  return { checkNow, findUnresponsiveWebApp };
}
