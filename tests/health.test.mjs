import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkHealth, parseArguments, runOnce } from '../scripts/check-health.mjs';

const GOOD_HEALTH = { status: 'ok', database: 'ok', authConfigured: true, version: '0.1.0' };
const GOOD_PAGE = '<!doctype html><html><body data-app="yourgame">yourga.me</body></html>';
const SCRIPT_PATH = new URL('../scripts/check-health.mjs', import.meta.url);
const FIRST_TEST_PORT = 49152;
const LAST_TEST_PORT = 65535;
const MAX_BIND_ATTEMPTS = 16;

async function listenForFixture(server, choosePort = () => randomInt(FIRST_TEST_PORT, LAST_TEST_PORT + 1)) {
  // listen(0) follows the host's configurable dynamic range, which can include
  // ports rejected by Fetch before a request reaches this server. Keep test
  // listeners in an allowed range without changing host/network configuration.
  for (let attempt = 0; attempt < MAX_BIND_ATTEMPTS; attempt += 1) {
    const port = choosePort(attempt);
    assert.ok(Number.isInteger(port) && port >= FIRST_TEST_PORT && port <= LAST_TEST_PORT);
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          server.off('error', onError);
          server.off('listening', onListening);
        };
        const onError = error => { cleanup(); reject(error); };
        const onListening = () => { cleanup(); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        try { server.listen(port, '127.0.0.1'); } catch (error) { onError(error); }
      });
      return;
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code) || attempt + 1 === MAX_BIND_ATTEMPTS) throw error;
    }
  }
}

async function fixture(t, responder, { choosePort } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yourgame-health-'));
  const calls = { api: 0, page: 0 };
  const server = createServer((request, response) => {
    const check = request.url === '/api/health' ? 'api' : 'page';
    calls[check] += 1;
    if (responder?.(request, response, check, calls)) return;
    response.writeHead(200, { 'Content-Type': check === 'api' ? 'application/json' : 'text/html' });
    response.end(check === 'api' ? JSON.stringify(GOOD_HEALTH) : GOOD_PAGE);
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise((done) => server.close(done));
    const absoluteDirectory = resolve(directory);
    assert.equal(dirname(absoluteDirectory), resolve(tmpdir()));
    assert.ok(basename(absoluteDirectory).startsWith('yourgame-health-'));
    await rm(absoluteDirectory, { recursive: true, force: true });
  });
  await listenForFixture(server, choosePort);
  return {
    calls, directory,
    options: {
      url: `http://127.0.0.1:${server.address().port}`,
      statePath: join(directory, 'state.json'), logPath: join(directory, 'incidents.jsonl'),
      timeoutMs: 500, retryDelayMs: 5,
    },
  };
}

function runCli(args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(SCRIPT_PATH), ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('success checks both routes and persists last success and healthy version', async (t) => {
  const { options, calls } = await fixture(t);
  const report = await runOnce(options);
  assert.equal(report.status, 'healthy');
  assert.equal(report.lastSuccess, report.timestamp);
  assert.equal(report.healthyVersion, '0.1.0');
  assert.equal(report.consecutiveFailures, 0);
  assert.deepEqual(report.newIncidents, []);
  assert.equal(report.notificationRecommended, false);
  assert.deepEqual(calls, { api: 1, page: 1 });
  const state = JSON.parse(await readFile(options.statePath, 'utf8'));
  assert.equal(state.lastSuccess, report.timestamp);
  assert.deepEqual(state.activeIncidents, []);
});

test('a busy allowed fixture port is retried without sending probes or changing endpoint request counts', async t => {
  const occupied = await fixture(t);
  const occupiedPort = Number(new URL(occupied.options.url).port);
  const tried = [];
  const { options, calls } = await fixture(t, undefined, { choosePort: attempt => {
    const port = attempt === 0 ? occupiedPort : randomInt(FIRST_TEST_PORT, LAST_TEST_PORT + 1);
    tried.push(port);
    return port;
  } });
  assert.equal(tried[0], occupiedPort);
  assert.ok(tried.length >= 2 && tried.length <= MAX_BIND_ATTEMPTS);
  assert.notEqual(new URL(options.url).port, String(occupiedPort));
  const report = await runOnce(options);
  assert.equal(report.status, 'healthy');
  assert.deepEqual(report.newIncidents, []);
  assert.deepEqual(report.checks.map(check => check.attempts), [1, 1]);
  assert.deepEqual(calls, { api: 1, page: 1 });
  assert.deepEqual(occupied.calls, { api: 0, page: 0 });
});

test('exhausted fixture binding retries fail explicitly and remain bounded', async t => {
  const occupied = await fixture(t);
  const occupiedPort = Number(new URL(occupied.options.url).port);
  let attempts = 0;
  await assert.rejects(fixture(t, undefined, { choosePort: () => { attempts += 1; return occupiedPort; } }),
    error => error.code === 'EADDRINUSE');
  assert.equal(attempts, MAX_BIND_ATTEMPTS);
  assert.deepEqual(occupied.calls, { api: 0, page: 0 });
});

test('real connection failures on allowed ports remain network errors rather than becoming timeouts', async t => {
  const { options, calls } = await fixture(t, (request, _response, check) => {
    if (check !== 'api') return false;
    request.socket.destroy();
    return true;
  });
  const report = await runOnce(options);
  assert.equal(report.status, 'degraded');
  assert.equal(report.checks[0].code, 'network_error');
  assert.equal(report.checks[0].statusCode, null);
  assert.equal(report.checks[0].attempts, 2);
  assert.equal(report.checks[1].status, 'ok');
  assert.deepEqual(calls, { api: 2, page: 1 });
});

test('intentional service closure is not mislabeled as an infrastructure outage', async t => {
  const { options } = await fixture(t, (_request, response, check) => {
    response.writeHead(200, { 'Content-Type': check === 'api' ? 'application/json' : 'text/html' });
    response.end(check === 'api' ? JSON.stringify({ ...GOOD_HEALTH,
      collectionOpen: false, service: { mode: 'ended', proposalsEnabled: false, developmentEnabled: false } })
      : GOOD_PAGE.replace('yourga.me</body>', 'yourga.me 서비스가 종료되었습니다.</body>'));
    return true;
  });
  const report = await runOnce(options);
  assert.equal(report.status, 'healthy');
  assert.equal(report.notificationRecommended, false);
  assert.deepEqual(report.newIncidents, []);
});

test('a repeated non-200 failure creates one incident and a real recovery', async (t) => {
  let failing = false;
  const { options } = await fixture(t, (_request, response, check) => {
    if (check !== 'api' || !failing) return false;
    response.writeHead(503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ...GOOD_HEALTH, status: 'degraded', database: 'unavailable' }));
    return true;
  });
  const initial = await runOnce(options);
  failing = true;
  const first = await runOnce(options);
  const second = await runOnce(options);
  assert.equal(first.status, 'degraded');
  assert.equal(first.lastSuccess, initial.timestamp);
  assert.equal(first.healthyVersion, '0.1.0');
  assert.equal(first.newIncidents.length, 1);
  assert.equal(first.newIncidents[0].statusCode, 503);
  assert.equal(first.newIncidents[0].rootCause, 'unconfirmed');
  assert.equal(first.checks.find((check) => check.check === 'api').attempts, 2);
  assert.equal(second.consecutiveFailures, 2);
  assert.deepEqual(second.newIncidents, []);
  assert.equal(second.notificationRecommended, false);
  assert.deepEqual(second.activeIncidentFingerprints, first.activeIncidentFingerprints);
  failing = false;
  const recovered = await runOnce(options);
  assert.equal(recovered.status, 'healthy');
  assert.equal(recovered.recoveries.length, 1);
  assert.equal(recovered.recoveries[0].fingerprint, first.newIncidents[0].fingerprint);
  assert.equal(recovered.notificationRecommended, true);
  assert.equal(recovered.consecutiveFailures, 0);
  assert.deepEqual((await runOnce(options)).recoveries, []);
  const events = (await readFile(options.logPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => event.type), ['incident', 'recovery']);
});

test('invalid JSON is degraded and raw response secrets never enter reports or logs', async (t) => {
  const sensitive = 'Bearer private-token C:\\internal\\trace secret=do-not-log';
  const { options } = await fixture(t, (_request, response, check) => {
    if (check !== 'api') return false;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(sensitive);
    return true;
  });
  const report = await runOnce(options);
  assert.equal(report.status, 'degraded');
  assert.equal(report.newIncidents[0].code, 'invalid_json');
  const output = JSON.stringify(report) + await readFile(options.logPath, 'utf8') + await readFile(options.statePath, 'utf8');
  assert.ok(!output.includes(sensitive));
  assert.ok(!output.includes('private-token'));
  assert.ok(!output.includes('C:\\internal'));
});

test('HTTP 200 does not hide a degraded health document or wrong root page', async (t) => {
  const { options } = await fixture(t, (_request, response, check) => {
    response.writeHead(200, { 'Content-Type': check === 'api' ? 'application/json' : 'text/html' });
    response.end(check === 'api'
      ? JSON.stringify({ ...GOOD_HEALTH, authConfigured: false })
      : '<html><body>Sign in to this hosting provider</body></html>');
    return true;
  });
  const report = await runOnce(options);
  assert.equal(report.status, 'degraded');
  assert.deepEqual(report.newIncidents.map((incident) => incident.code), ['health_not_ready', 'page_marker_missing']);
  assert.equal(report.healthyVersion, null);
});

test('requests time out even if the server never sends a response and retries only once', async (t) => {
  const { options, calls } = await fixture(t, (_request, _response, check) => check === 'api');
  const started = performance.now();
  const report = await runOnce({ ...options, timeoutMs: 80 });
  assert.equal(report.status, 'degraded');
  assert.equal(report.newIncidents[0].code, 'timeout');
  assert.equal(report.newIncidents[0].statusCode, null);
  assert.equal(calls.api, 2);
  assert.ok(performance.now() - started < 2_000);
});

test('a successful retry is healthy and does not create a persistent incident', async (t) => {
  const { options, calls } = await fixture(t, (_request, response, check, count) => {
    if (check !== 'api' || count.api !== 1) return false;
    response.writeHead(502);
    response.end('upstream unavailable');
    return true;
  });
  const report = await runOnce(options);
  assert.equal(report.status, 'healthy');
  assert.equal(calls.api, 2);
  assert.deepEqual(report.newIncidents, []);
});

test('a stalled body times out and redirects are observed without following them', async (t) => {
  let redirectedRequests = 0;
  const { options } = await fixture(t, (request, response, check) => {
    if (request.url === '/login') redirectedRequests += 1;
    if (check === 'api') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
    } else {
      response.writeHead(302, { Location: '/login?token=private-secret' });
      response.end();
    }
    return true;
  });
  const report = await runOnce({ ...options, timeoutMs: 80 });
  assert.equal(report.status, 'degraded');
  assert.equal(report.checks[0].code, 'timeout');
  assert.equal(report.checks[0].statusCode, 200);
  assert.equal(report.checks[1].statusCode, 302);
  assert.equal(redirectedRequests, 0);
  assert.ok(!JSON.stringify(report).includes('private-secret'));
});

test('changed failure evidence is a new incident, not a false recovery', async (t) => {
  let statusCode = 503;
  const { options } = await fixture(t, (_request, response, check) => {
    if (check !== 'api') return false;
    response.writeHead(statusCode, { 'Content-Type': 'application/json' });
    response.end('{}');
    return true;
  });
  const first = await runOnce(options);
  statusCode = 502;
  const second = await runOnce(options);
  assert.equal(second.newIncidents.length, 1);
  assert.notEqual(second.newIncidents[0].fingerprint, first.newIncidents[0].fingerprint);
  assert.equal(second.newIncidents[0].replacesFingerprint, first.newIncidents[0].fingerprint);
  assert.deepEqual(second.recoveries, []);
});

test('health field values are allowlisted and arbitrary version text is redacted', async (t) => {
  const { options } = await fixture(t, (_request, response, check) => {
    if (check !== 'api') return false;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ...GOOD_HEALTH, database: 'password=mysecret', version: 'Bearer mysecret', stack: 'private trace' }));
    return true;
  });
  const report = await runOnce(options);
  assert.equal(report.status, 'degraded');
  assert.equal(report.checks[0].observation.database, 'unexpected');
  assert.equal(report.checks[0].observation.version, '[redacted version]');
  assert.ok(!JSON.stringify(report).includes('mysecret'));
  assert.ok(!JSON.stringify(report).includes('private trace'));
});

test('corrupt monitor state is reported separately from application health without overwriting it', async (t) => {
  const { options } = await fixture(t);
  await writeFile(options.statePath, 'secret private state');
  const report = await runOnce(options);
  assert.equal(report.status, 'degraded');
  assert.equal(report.applicationStatus, 'healthy');
  assert.deepEqual(report.monitorErrors, ['state_invalid']);
  assert.equal(await readFile(options.statePath, 'utf8'), 'secret private state');
  assert.ok(!JSON.stringify(report).includes('private state'));
});

test('CLI --once emits JSON and exits nonzero for an unhealthy service', async (t) => {
  const { options } = await fixture(t, (_request, response, check) => {
    if (check !== 'api') return false;
    response.writeHead(500);
    response.end('private traceback');
    return true;
  });
  const result = await runCli(['--once', '--url', options.url, '--state', options.statePath,
    '--log', options.logPath, '--retries', '0', '--timeout-ms', '500']);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).status, 'degraded');
  assert.ok(!result.stdout.includes('private traceback'));
});

test('CLI --once exits zero and emits no notifications for a healthy service', async (t) => {
  const { options } = await fixture(t);
  const result = await runCli(['--once', '--url', options.url, '--state', options.statePath,
    '--log', options.logPath, '--timeout-ms', '500']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).notificationRecommended, false);
});

test('CLI rejects credential-bearing URLs without printing the URL', async () => {
  const result = await runCli(['--url', 'https://user:private-secret@yourga.me']);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stdout).monitorErrors, ['invalid_url']);
  assert.ok(!result.stdout.includes('private-secret'));
});

test('CLI options cannot enable continuous runs or more than one retry', async () => {
  assert.deepEqual(parseArguments(['--once', '--timeout-ms', '100', '--retries', '0']), { timeoutMs: 100, retries: 0 });
  assert.throws(() => parseArguments(['--watch']), /invalid_arguments/);
  await assert.rejects(checkHealth({ retries: 2 }), /invalid_options/);
});
