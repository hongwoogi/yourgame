import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { classifyCliFailure, parseArguments, parseRuntimeLogs, runOnce } from '../scripts/check-runtime-errors.mjs';

const NOW = Date.parse('2026-08-31T09:00:00.000Z');
const REQUEST_ID = 'iad1::hnd1::abc12-1788166700000-a1b2c3d4';
const event = (overrides = {}) => ({
  id: REQUEST_ID, timestamp: NOW - 1000, deploymentId: 'dpl_0123456789abcdefghij',
  environment: 'production', requestPath: '/api/proposals', responseStatusCode: 503,
  ...overrides,
});
const output = records => records.map(record => JSON.stringify(record)).join('\n');
const successful = records => async () => ({ ok: true, stdout: output(records), stderr: '' });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'yourgame-runtime-'));
  const options = { statePath: join(directory, 'state.json') };
  t.after(async () => {
    for (const name of await readdir(directory)) {
      const target = resolve(directory, name);
      assert.equal(dirname(target), resolve(directory));
      await unlink(target);
    }
    await rmdir(directory);
  });
  return { directory, options };
}

test('only known production API 5xx metadata survives normalization; messages, query, domain and PII do not', () => {
  const secret = 'person@example.com SECRET_TOKEN private-stack';
  const parsed = parseRuntimeLogs(output([
    event({ requestPath: '/api/login?credential=SECRET_TOKEN#private', message: secret, logs: [{ message: secret }], domain: secret, projectId: secret, body: secret }),
    event({ requestPath: '/api/unknown/private-name', timestamp: NOW - 2000 }),
    event({ environment: 'preview', timestamp: NOW - 3000 }),
    event({ responseStatusCode: 429 }),
  ]), NOW);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.ignoredCount, 3);
  assert.equal(parsed.events[0].path, '/api/login');
  assert.equal(parsed.events[0].statusCode, 503);
  assert.equal(parsed.events[0].requestId, REQUEST_ID);
  assert.doesNotMatch(JSON.stringify(parsed), /SECRET|example\.com|private|credential|logs|message|domain|projectId/);
});

test('identifiers are strictly allowlisted and unsafe IDs are discarded before fingerprinting', () => {
  const parsed = parseRuntimeLogs(output([event({ id: 'person@example.com', deploymentId: 'private-secret/path' })]), NOW);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.events[0].requestId, undefined);
  assert.equal(parsed.events[0].deploymentId, undefined);
  assert.match(parsed.events[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(parsed), /person|secret|example/);
});

test('empty successful output means no observed errors; malformed/schema-changed output cannot claim success', () => {
  assert.deepEqual(parseRuntimeLogs('', NOW).events, []);
  assert.equal(parseRuntimeLogs('', NOW).failureCode, null);
  assert.equal(parseRuntimeLogs('private malformed text', NOW).failureCode, 'invalid_log_output');
  assert.equal(parseRuntimeLogs('{"unexpected":"private"}', NOW).failureCode, 'unsupported_log_schema');
  assert.equal(parseRuntimeLogs('null', NOW).failureCode, 'unsupported_log_schema');
  assert.equal(parseRuntimeLogs(output([event({ timestamp: 'secret' })]), NOW).failureCode, 'unsupported_log_schema');
});

test('new errors notify once across overlapping windows while a different request is new', async t => {
  const { options } = await fixture(t);
  const deps = { query: successful([event()]), now: () => NOW };
  const first = await runOnce(options, deps);
  const repeated = await runOnce(options, deps);
  assert.equal(first.status, 'errors_observed');
  assert.equal(first.newIncidents.length, 1);
  assert.equal(first.notificationRecommended, true);
  assert.equal(repeated.observedErrorCount, 1);
  assert.deepEqual(repeated.newIncidents, []);
  assert.equal(repeated.notificationRecommended, false);
  const later = await runOnce(options, { query: successful([event(), event({ id: 'iad1::hnd1::xyz12-1788166700001-f1e2d3c4' })]), now: () => NOW + 1000 });
  assert.equal(later.newIncidents.length, 1);
  const state = await readFile(options.statePath, 'utf8');
  assert.doesNotMatch(state, /requestPath|message|deploymentId|requestId|iad1/);
  assert.equal(JSON.parse(state).seen.length, 2);
});

test('public and protected API routes are covered, including rewritten admin paths', () => {
  const paths = ['/api/status', '/api/session', '/api/login', '/api/logout', '/api/proposals', '/api/health', '/api/community', '/api/locale',
    '/api/admin', '/api/admin-page', '/api/admin-redirect', '/admin', '/admin/', '/master', '/master/'];
  const parsed = parseRuntimeLogs(output(paths.map((path, index) => event({ requestPath: path, timestamp: NOW - index * 1000 }))), NOW);
  assert.deepEqual(new Set(parsed.events.map(row => row.path)), new Set(paths));
});

test('master, community and locale routes remain exact entries without query text or private descendants', () => {
  const paths = ['/master', '/master/', '/api/admin-redirect', '/api/community', '/api/locale'];
  const privatePaths = ['/master/private-person', '/masterish', '/master/%2Fprivate-person',
    '/master//', '/api/admin-redirect/private-person', '/api/admin-redirect%2Fprivate-person',
    '/api/community/private-person', '/api/community%2Fprivate-person', '/api/locale/private-person'];
  const parsed = parseRuntimeLogs(output([
    ...paths.map((path, index) => event({ requestPath: `${path}?token=SECRET_TOKEN&email=person@example.com#private-fragment`,
      timestamp: NOW - index * 1000, message: 'SECRET_TOKEN private-body', headers: { Cookie: 'private-cookie' } })),
    ...privatePaths.map(path => event({ requestPath: path })),
    event({ requestPath: '/master', responseStatusCode: 302 }),
    event({ requestPath: '/api/admin-redirect', responseStatusCode: 307 }),
    event({ requestPath: '/admin', responseStatusCode: 405 }),
  ]), NOW);
  assert.deepEqual(new Set(parsed.events.map(row => row.path)), new Set(paths));
  assert.equal(parsed.ignoredCount, privatePaths.length + 3);
  assert.equal(parsed.failureCode, null);
  assert.doesNotMatch(JSON.stringify(parsed), /SECRET|example\.com|private|token|email|headers|Cookie/);
});

test('query failures are classified safely, deduplicated, and recovery is reported once', async t => {
  const { options } = await fixture(t);
  const query = async () => ({ ok: false, stdout: '', stderr: 'Upgrade to Pro to access private customer data SECRET_TOKEN' });
  const first = await runOnce(options, { query, now: () => NOW });
  const repeat = await runOnce(options, { query, now: () => NOW + 1000 });
  assert.equal(first.queryStatus, 'failed');
  assert.equal(first.queryFailure.code, 'plan_restricted');
  assert.equal(first.notificationRecommended, true);
  assert.equal(repeat.notificationRecommended, false);
  const recovered = await runOnce(options, { query: successful([]), now: () => NOW + 2000 });
  assert.equal(recovered.queryRecovered, true);
  assert.equal(recovered.notificationRecommended, true);
  assert.equal(recovered.status, 'clear');
  const steady = await runOnce(options, { query: successful([]), now: () => NOW + 3000 });
  assert.equal(steady.queryRecovered, false);
  assert.equal(steady.notificationRecommended, false);
  assert.doesNotMatch(JSON.stringify([first, repeat, recovered]) + await readFile(options.statePath, 'utf8'), /SECRET|customer|private/);
});

test('CLI timeouts, unavailable cache, auth, unsupported flags and network failures stay distinct', () => {
  assert.equal(classifyCliFailure({ timedOut: true, stderr: 'private' }), 'query_timeout');
  assert.equal(classifyCliFailure({ errorCode: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', timedOut: true }), 'query_output_too_large');
  assert.equal(classifyCliFailure({ errorCode: 'ENOENT' }), 'cli_unavailable');
  assert.equal(classifyCliFailure({ stderr: 'Unauthorized 401 bearer SECRET' }), 'authentication_required');
  assert.equal(classifyCliFailure({ stderr: 'Forbidden 403 private project' }), 'access_denied');
  assert.equal(classifyCliFailure({ stderr: 'Unknown or unexpected option: --json' }), 'unsupported_cli');
  assert.equal(classifyCliFailure({ stderr: 'fetch failed ENOTFOUND private-host' }), 'network_error');
});

test('partial CLI failures still report already observed safe errors without claiming a complete query', async t => {
  const { options } = await fixture(t);
  const report = await runOnce(options, {
    query: async () => ({ ok: false, stdout: output([event({ message: 'SECRET' })]), stderr: 'fetch failed private-host' }),
    now: () => NOW,
  });
  assert.equal(report.queryFailure.code, 'network_error');
  assert.equal(report.newIncidents.length, 1);
  assert.equal(report.status, 'degraded');
  assert.doesNotMatch(JSON.stringify(report), /SECRET|private-host/);
});

test('hitting the 50-record limit reports incomplete coverage and deduplicates that warning', async t => {
  const { options } = await fixture(t);
  const records = Array.from({ length: 50 }, (_, index) => event({ timestamp: NOW - index * 1000 }));
  const first = await runOnce(options, { query: successful(records), now: () => NOW });
  const repeated = await runOnce(options, { query: successful(records), now: () => NOW });
  assert.equal(first.limitReached, true);
  assert.equal(first.status, 'degraded');
  assert.equal(first.newIncidents.length, 50);
  assert.equal(repeated.notificationRecommended, false);
});

test('invalid persisted state is never echoed or overwritten with a falsely clean state', async t => {
  const { options } = await fixture(t);
  await writeFile(options.statePath, 'PRIVATE_STATE_SECRET');
  const report = await runOnce(options, { query: successful([]), now: () => NOW });
  assert.equal(report.status, 'degraded');
  assert.deepEqual(report.monitorErrors, ['state_invalid']);
  assert.equal(await readFile(options.statePath, 'utf8'), 'PRIVATE_STATE_SECRET');
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|SECRET/);
});

test('old/future records do not masquerade as current errors and duplicate rows are coalesced', () => {
  const parsed = parseRuntimeLogs(output([
    event(), event(), event({ timestamp: NOW - 11 * 60000 }), event({ timestamp: NOW + 5 * 60000 }),
  ]), NOW);
  assert.equal(parsed.events.length, 1);
  assert.equal(parsed.ignoredCount, 1);
  assert.equal(parsed.failureCode, 'unsupported_log_schema');
});

test('options allow only bounded one-shot reads and cannot inject new CLI commands or scope', async t => {
  assert.deepEqual(parseArguments(['--once', '--timeout-ms', '100']), { timeoutMs: 100 });
  for (const flag of ['--follow', '--watch', '--scope', '--yes', '--token', '--install']) assert.throws(() => parseArguments([flag, 'SECRET']), /invalid_arguments/);
  const { options } = await fixture(t);
  let calls = 0;
  await assert.rejects(runOnce({ ...options, timeoutMs: 30001 }, { query: async () => { calls += 1; }, now: () => NOW }), /invalid_options/);
  assert.equal(calls, 0);
});
