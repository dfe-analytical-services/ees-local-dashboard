import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ProcessStatus } from './processManager';
import { ServiceName } from './services';
import createWebAppProber, {
  DEV_SERVER_GRACE_MS,
  FAILURES_BEFORE_FLAGGING,
} from './webAppProbe';

/**
 * The log lines are real ones, from the incident that prompted the probe: an
 * admin whose dev server crashed on startup (fork-ts-checker-webpack-plugin
 * against a TypeScript it can't patch), leaving admin 'running' and every
 * page request hanging until the browser gave up - with nothing in the log
 * that the webAppHealth patterns knew to match.
 */
const crashedDevServerLogs = [
  'info: Microsoft.AspNetCore.SpaServices[0]',
  '      Starting the development server...',
  'fail: Microsoft.AspNetCore.SpaServices[0]',
  '      TypeError: Cannot set property mark of #<Object> which has only a getter',
];

const compiledDevServerLogs = [
  'info: Microsoft.AspNetCore.SpaServices[0]',
  '      Starting the development server...',
  'info: Microsoft.AspNetCore.SpaServices[0]',
  '      Compiled successfully!',
];

function createHarness() {
  const statuses = new Map<ServiceName, ProcessStatus>();
  const logs = new Map<ServiceName, string[]>();
  const probed: string[] = [];
  let answers = true;
  let time = 0;

  const prober = createWebAppProber({
    getStatus: service => statuses.get(service) ?? 'stopped',
    getLogs: service => logs.get(service) ?? [],
    probe: async url => {
      probed.push(url);
      return answers;
    },
    now: () => time,
  });

  return {
    prober,
    probed,
    setStatus: (service: ServiceName, status: ProcessStatus) =>
      statuses.set(service, status),
    setLogs: (service: ServiceName, lines: string[]) =>
      logs.set(service, lines),
    setAnswers: (value: boolean) => {
      answers = value;
    },
    advance: (ms: number) => {
      time += ms;
    },
    checkTimes: async (count: number) => {
      // eslint-disable-next-line no-restricted-syntax
      for (let i = 0; i < count; i += 1) {
        // Sequential on purpose - each tick's result feeds the next.
        // eslint-disable-next-line no-await-in-loop
        await prober.checkNow();
      }
    },
  };
}

describe('createWebAppProber', () => {
  it('says nothing about a web app that answers', async () => {
    const harness = createHarness();
    harness.setStatus('admin', 'running');
    harness.setLogs('admin', compiledDevServerLogs);

    await harness.checkTimes(FAILURES_BEFORE_FLAGGING + 1);

    assert.equal(harness.prober.findUnresponsiveWebApp('admin'), undefined);
    assert.ok(harness.probed.includes('https://localhost:5021'));
  });

  it('flags a running admin whose homepage never answers', async () => {
    const harness = createHarness();
    harness.setStatus('admin', 'running');
    harness.setLogs('admin', compiledDevServerLogs);
    harness.setAnswers(false);

    await harness.checkTimes(FAILURES_BEFORE_FLAGGING);

    const failure = harness.prober.findUnresponsiveWebApp('admin');

    assert.ok(failure);
    assert.match(failure.cause, /https:\/\/localhost:5021/);
    assert.match(failure.message, /admin app's dev server isn't responding/);
    assert.match(failure.message, /pnpm clean && pnpm i/);
  });

  it('is not convinced by a single unanswered probe', async () => {
    // One timeout can be a cold compile that ran long; it takes a streak.
    const harness = createHarness();
    harness.setStatus('admin', 'running');
    harness.setLogs('admin', compiledDevServerLogs);
    harness.setAnswers(false);

    await harness.checkTimes(FAILURES_BEFORE_FLAGGING - 1);

    assert.equal(harness.prober.findUnresponsiveWebApp('admin'), undefined);
  });

  it("doesn't probe admin until its dev server has reported in", async () => {
    // Before the compile result arrives, a probe would hang on a first
    // webpack compile that's merely slow - so there's nothing meaningful to
    // measure yet, and the probe should stay away entirely.
    const harness = createHarness();
    harness.setStatus('admin', 'running');
    harness.setLogs('admin', crashedDevServerLogs);
    harness.setAnswers(false);

    await harness.checkTimes(FAILURES_BEFORE_FLAGGING + 3);

    assert.equal(harness.probed.length, 0);
    assert.equal(harness.prober.findUnresponsiveWebApp('admin'), undefined);
  });

  it('probes anyway once a dev server has had long enough to report in', async () => {
    // The incident path: the dev server crashed before ever compiling, so
    // the "compiled" line this waits for is never coming - the grace period
    // running out is what gets the probe (and so the banner) there at all.
    const harness = createHarness();
    harness.setStatus('admin', 'running');
    harness.setLogs('admin', crashedDevServerLogs);
    harness.setAnswers(false);

    await harness.checkTimes(1);
    harness.advance(DEV_SERVER_GRACE_MS);
    await harness.checkTimes(FAILURES_BEFORE_FLAGGING);

    const failure = harness.prober.findUnresponsiveWebApp('admin');

    assert.ok(failure);
    assert.match(failure.message, /isn't responding/);
  });

  it('withdraws the flag as soon as the app answers again', async () => {
    const harness = createHarness();
    harness.setStatus('admin', 'running');
    harness.setLogs('admin', compiledDevServerLogs);
    harness.setAnswers(false);

    await harness.checkTimes(FAILURES_BEFORE_FLAGGING);
    assert.ok(harness.prober.findUnresponsiveWebApp('admin'));

    harness.setAnswers(true);
    await harness.checkTimes(1);

    assert.equal(harness.prober.findUnresponsiveWebApp('admin'), undefined);
  });

  it('takes the banner down the moment the service stops', async () => {
    // Live, not on the next tick: stopping a broken service is the first
    // step of fixing it, and a banner that lingers half a minute after says
    // the fix didn't take.
    const harness = createHarness();
    harness.setStatus('admin', 'running');
    harness.setLogs('admin', compiledDevServerLogs);
    harness.setAnswers(false);

    await harness.checkTimes(FAILURES_BEFORE_FLAGGING);
    harness.setStatus('admin', 'stopped');

    assert.equal(harness.prober.findUnresponsiveWebApp('admin'), undefined);
  });

  it('gives a restarted service a clean slate', async () => {
    const harness = createHarness();
    harness.setStatus('admin', 'running');
    harness.setLogs('admin', compiledDevServerLogs);
    harness.setAnswers(false);

    await harness.checkTimes(FAILURES_BEFORE_FLAGGING);

    harness.setStatus('admin', 'stopped');
    await harness.checkTimes(1);

    harness.setStatus('admin', 'running');
    harness.setAnswers(false);
    await harness.checkTimes(FAILURES_BEFORE_FLAGGING - 1);

    // The old run's strikes don't count towards the new run's total.
    assert.equal(harness.prober.findUnresponsiveWebApp('admin'), undefined);
  });

  it('leaves services that are not running alone', async () => {
    const harness = createHarness();
    harness.setStatus('admin', 'starting');
    harness.setStatus('frontend', 'stopped');

    await harness.checkTimes(3);

    assert.equal(harness.probed.length, 0);
  });

  it('covers the frontend through its own ready line', async () => {
    const harness = createHarness();
    harness.setStatus('frontend', 'running');
    harness.setLogs('frontend', ['Server started on http://localhost:3000']);
    harness.setAnswers(false);

    await harness.checkTimes(FAILURES_BEFORE_FLAGGING);

    const failure = harness.prober.findUnresponsiveWebApp('frontend');

    assert.ok(failure);
    assert.match(failure.message, /public frontend isn't responding/);
    assert.ok(harness.probed.includes('http://localhost:3000'));
  });
});
