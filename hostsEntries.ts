import dns from 'node:dns/promises';
import process from 'node:process';
import { ToolIssue } from './toolVersions';

/**
 * Hostnames the services resolve from this machine to reach the Docker
 * containers - `Server=db`/`Host=db` in connection strings, and the
 * `http://data-storage:1000x` Azurite endpoints. The project README's
 * "Set up the database and storage emulator hosts" step maps both to
 * 127.0.0.1 in the hosts file; without that, admin dies on startup with a
 * misleading SqlClient error ("Named Pipes Provider, error: 40") and the
 * function hosts' storage checks time out.
 */
export const REQUIRED_HOSTNAMES = ['db', 'data-storage'] as const;

const HOSTS_FILE_PATH =
  process.platform === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/hosts';

function isLoopback(address: string): boolean {
  return address.startsWith('127.') || address === '::1';
}

/** How a required hostname resolved, in the shape the message cares about. */
export interface HostnameResolution {
  hostname: string;
  /** Every address it resolved to; empty when it didn't resolve at all. */
  addresses: string[];
}

/**
 * What to say about how the required hostnames resolved, if anything.
 *
 * Unresolvable names are an error - nothing that talks to SQL Server or
 * Azurite can work, and the failures the services themselves report (a
 * named-pipes SqlException, a Functions host storage timeout) don't mention
 * hostnames at all. A name that resolves somewhere other than loopback only
 * gets a warning: that's likely a corporate DNS answering for `db`, but it
 * could also be a deliberate remote setup.
 */
export function describeHostsEntriesIssue(
  resolutions: HostnameResolution[],
): ToolIssue | undefined {
  const missing = resolutions.filter(r => r.addresses.length === 0);

  if (missing.length > 0) {
    const names = missing.map(r => `'${r.hostname}'`).join(' and ');

    return {
      id: 'hosts-entries',
      severity: 'error',
      message:
        `${names} ${missing.length > 1 ? "don't" : "doesn't"} resolve on ` +
        `this machine, but the services reach SQL Server and Azurite ` +
        `through ${missing.length > 1 ? 'those hostnames' : 'that hostname'} ` +
        `- add the missing ${missing.length > 1 ? 'lines' : 'line'} ` +
        `(${missing.map(r => `'127.0.0.1 ${r.hostname}'`).join(', ')}) to ` +
        `${HOSTS_FILE_PATH}, per the project README's "Set up the database ` +
        `and storage emulator hosts" step.`,
    };
  }

  const elsewhere = resolutions.filter(
    r => !r.addresses.some(isLoopback),
  );

  if (elsewhere.length > 0) {
    const detail = elsewhere
      .map(r => `'${r.hostname}' resolves to ${r.addresses.join(', ')}`)
      .join(' and ');

    return {
      id: 'hosts-entries',
      severity: 'warning',
      message:
        `${detail} rather than 127.0.0.1, so the services will look for ` +
        `SQL Server/Azurite there instead of the local Docker containers - ` +
        `if that's not deliberate, add the README's hosts entries to ` +
        `${HOSTS_FILE_PATH} (they take precedence over DNS).`,
    };
  }

  return undefined;
}

/**
 * Resolve a hostname exactly the way the services will - `dns.lookup` is
 * getaddrinfo, so the hosts file is consulted the same as .NET's SqlClient
 * or the storage SDK would. Not resolving is a result here, not a failure.
 */
async function resolveHostname(hostname: string): Promise<HostnameResolution> {
  try {
    const results = await dns.lookup(hostname, { all: true, verbatim: true });
    return { hostname, addresses: results.map(r => r.address) };
  } catch {
    return { hostname, addresses: [] };
  }
}

/**
 * The hosts-entries issue as it stands right now, freshly resolved -
 * see {@link describeHostsEntriesIssue} for what qualifies.
 */
export default async function checkHostsEntries(): Promise<
  ToolIssue | undefined
> {
  const resolutions = await Promise.all(
    REQUIRED_HOSTNAMES.map(resolveHostname),
  );

  return describeHostsEntriesIssue(resolutions);
}
