import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeHostsEntriesIssue } from './hostsEntries';

describe('describeHostsEntriesIssue', () => {
  it('is quiet when both hostnames resolve to loopback', () => {
    assert.equal(
      describeHostsEntriesIssue([
        { hostname: 'db', addresses: ['127.0.0.1'] },
        { hostname: 'data-storage', addresses: ['::1', '127.0.0.1'] },
      ]),
      undefined,
    );
  });

  it('reports an unresolvable hostname as an error naming the fix', () => {
    const issue = describeHostsEntriesIssue([
      { hostname: 'db', addresses: [] },
      { hostname: 'data-storage', addresses: ['127.0.0.1'] },
    ]);

    assert.equal(issue?.severity, 'error');
    assert.match(issue.message, /'db' doesn't resolve/);
    assert.match(issue.message, /'127\.0\.0\.1 db'/);
    // The still-working hostname shouldn't be dragged into the message.
    assert.doesNotMatch(issue.message, /'127\.0\.0\.1 data-storage'/);
  });

  it('names both hostnames when neither resolves', () => {
    const issue = describeHostsEntriesIssue([
      { hostname: 'db', addresses: [] },
      { hostname: 'data-storage', addresses: [] },
    ]);

    assert.equal(issue?.severity, 'error');
    assert.match(issue.message, /'db' and 'data-storage' don't resolve/);
    assert.match(issue.message, /'127\.0\.0\.1 db'/);
    assert.match(issue.message, /'127\.0\.0\.1 data-storage'/);
  });

  it('only warns when a hostname resolves somewhere other than loopback', () => {
    // e.g. a corporate DNS answering for `db` - probably wrong, but possibly
    // a deliberate remote setup, so not the red banner treatment.
    const issue = describeHostsEntriesIssue([
      { hostname: 'db', addresses: ['10.1.2.3'] },
      { hostname: 'data-storage', addresses: ['127.0.0.1'] },
    ]);

    assert.equal(issue?.severity, 'warning');
    assert.match(issue.message, /'db' resolves to 10\.1\.2\.3/);
  });

  it('prefers the missing-entirely error over a non-loopback warning', () => {
    const issue = describeHostsEntriesIssue([
      { hostname: 'db', addresses: [] },
      { hostname: 'data-storage', addresses: ['10.1.2.3'] },
    ]);

    assert.equal(issue?.severity, 'error');
  });

  it('accepts any 127.0.0.0/8 address as loopback', () => {
    assert.equal(
      describeHostsEntriesIssue([
        { hostname: 'db', addresses: ['127.1.2.3'] },
        { hostname: 'data-storage', addresses: ['127.0.0.1'] },
      ]),
      undefined,
    );
  });
});
