#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL = 'https://yourga.me';
const ISSUE_CODES = new Set([
  'http_status', 'timeout', 'network_error', 'response_too_large',
  'unexpected_content_type', 'invalid_json', 'health_not_ready', 'page_marker_missing',
]);
const CHECK_PATHS = { api: '/api/health', page: '/' };
const SAFE_VERSION = /^(?:v?\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|next|preview|canary|dev)(?:\.\d+)?)?(?:\+[a-f\d]{7,40})?|[a-f\d]{7,64})$/i;

function failure(code) {
  const error = new Error(code);
  error.monitorCode = code;
  return error;
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function safeVersion(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.length <= 128 && SAFE_VERSION.test(value) ? value : '[redacted version]';
}

function normalizeOptions(options = {}) {
  let url;
  try { url = new URL(options.url ?? DEFAULT_URL); } catch { throw failure('invalid_url'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || url.search || url.hash
    || !['/', '/api/health'].includes(url.pathname)) throw failure('invalid_url');

  const timeoutMs = options.timeoutMs ?? 10_000;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const retries = options.retries ?? 1;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000
    || !Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 1_000
    || ![0, 1].includes(retries)) throw failure('invalid_options');

  const statePath = resolve(options.statePath ?? '.local/monitor-state.json');
  const logPath = resolve(options.logPath ?? '.local/incidents.jsonl');
  if (statePath === logPath) throw failure('state_and_log_must_differ');
  return { url: url.origin, timeoutMs, retryDelayMs, retries, statePath, logPath };
}

export function parseArguments(args) {
  const options = {};
  const flags = {
    '--url': 'url', '--state': 'statePath', '--log': 'logPath',
    '--timeout-ms': 'timeoutMs', '--retry-delay-ms': 'retryDelayMs', '--retries': 'retries',
  };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--once') continue;
    if (args[i] === '--help' || args[i] === '-h') { options.help = true; continue; }
    const key = flags[args[i]];
    const value = args[++i];
    if (!key || !value || value.startsWith('--')) throw failure('invalid_arguments');
    options[key] = ['timeoutMs', 'retryDelayMs', 'retries'].includes(key) ? Number(value) : value;
  }
  return options;
}

async function readLimitedBody(response, limit) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw failure('response_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size).toString('utf8');
}

function healthObservation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  return {
    status: ['ok', 'degraded'].includes(body.status) ? body.status : 'unexpected',
    database: ['ok', 'unavailable', 'unconfigured'].includes(body.database) ? body.database : 'unexpected',
    authConfigured: typeof body.authConfigured === 'boolean' ? body.authConfigured : null,
    version: safeVersion(body.version),
  };
}

async function requestAttempt(check, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let statusCode = null;
  try {
    const response = await fetch(`${options.url}${CHECK_PATHS[check]}`, {
      method: 'GET', redirect: 'manual', signal: controller.signal,
      headers: { Accept: check === 'api' ? 'application/json' : 'text/html', 'Cache-Control': 'no-cache' },
    });
    statusCode = response.status;
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    const text = await readLimitedBody(response, check === 'api' ? 16_384 : 524_288);
    let body;
    if (check === 'api') {
      try { body = JSON.parse(text); } catch { /* Never expose an upstream body or parser message. */ }
    }
    const observation = check === 'api' ? healthObservation(body) : undefined;
    const result = { check, path: CHECK_PATHS[check], statusCode, ...(observation ? { observation } : {}) };
    if (statusCode !== 200) return { ...result, status: 'failed', code: 'http_status' };
    if ((check === 'api' && contentType !== 'application/json')
      || (check === 'page' && contentType !== 'text/html')) {
      return { ...result, status: 'failed', code: 'unexpected_content_type' };
    }
    if (check === 'api') {
      if (body === undefined) return { ...result, status: 'failed', code: 'invalid_json' };
      if (!observation || observation.status !== 'ok' || observation.database !== 'ok'
        || observation.authConfigured !== true || observation.version === null) {
        return { ...result, status: 'failed', code: 'health_not_ready' };
      }
    } else if (!/<html(?:\s|>)/i.test(text) || !/\bdata-app\s*=\s*["']yourgame["']/i.test(text)) {
      return { ...result, status: 'failed', code: 'page_marker_missing' };
    }
    return { ...result, status: 'ok', code: null };
  } catch (error) {
    const code = controller.signal.aborted ? 'timeout'
      : error.monitorCode === 'response_too_large' ? 'response_too_large' : 'network_error';
    return { check, path: CHECK_PATHS[check], status: 'failed', code, statusCode };
  } finally { clearTimeout(timer); }
}

async function checkEndpoint(check, options) {
  let result;
  for (let attempt = 1; attempt <= options.retries + 1; attempt += 1) {
    if (attempt > 1) await new Promise((done) => setTimeout(done, options.retryDelayMs));
    result = { ...await requestAttempt(check, options), attempts: attempt };
    if (result.status === 'ok') return result;
  }
  return result;
}

export async function checkHealth(options = {}) {
  const settings = normalizeOptions(options);
  const checks = await Promise.all(Object.keys(CHECK_PATHS).map((check) => checkEndpoint(check, settings)));
  return {
    timestamp: new Date().toISOString(), target: settings.url,
    status: checks.every((check) => check.status === 'ok') ? 'healthy' : 'degraded',
    checks,
  };
}

function freshState(target) {
  return { schemaVersion: 1, target, lastSuccess: null, consecutiveFailures: 0, healthyVersion: null, activeIncidents: [] };
}

async function readState(settings) {
  let raw;
  try { raw = await readFile(settings.statePath, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return freshState(settings.url); throw failure('state_read_failed'); }
  let state;
  try { state = JSON.parse(raw); } catch { throw failure('state_invalid'); }
  if (!state || state.schemaVersion !== 1 || typeof state.target !== 'string'
    || (state.lastSuccess !== null && !timestamp(state.lastSuccess))
    || !Number.isSafeInteger(state.consecutiveFailures) || state.consecutiveFailures < 0
    || (state.healthyVersion !== null && typeof state.healthyVersion !== 'string')
    || !Array.isArray(state.activeIncidents) || state.activeIncidents.length > 2
    || state.activeIncidents.some((incident) => !incident || !Object.hasOwn(CHECK_PATHS, incident.check)
      || !ISSUE_CODES.has(incident.code) || !/^[a-f\d]{24}$/.test(incident.fingerprint)
      || !timestamp(incident.firstSeen)
      || (incident.statusCode !== null && (!Number.isInteger(incident.statusCode) || incident.statusCode < 100 || incident.statusCode > 599)))) {
    throw failure('state_invalid');
  }
  if (state.target !== settings.url) return freshState(settings.url);
  return {
    ...freshState(settings.url), lastSuccess: state.lastSuccess,
    consecutiveFailures: state.consecutiveFailures, healthyVersion: safeVersion(state.healthyVersion),
    activeIncidents: state.activeIncidents.map(({ check, code, fingerprint, firstSeen, statusCode }) =>
      ({ check, code, fingerprint, firstSeen, statusCode })),
  };
}

function fingerprint(target, check) {
  const evidence = [target, check.check, check.code, check.statusCode,
    check.observation?.status ?? null, check.observation?.database ?? null, check.observation?.authConfigured ?? null];
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex').slice(0, 24);
}

async function atomicStateWrite(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function runOnce(options = {}) {
  const settings = normalizeOptions(options);
  const [observed, priorResult] = await Promise.allSettled([checkHealth(settings), readState(settings)]);
  if (observed.status === 'rejected') throw failure('check_failed');
  const snapshot = observed.value;
  const previous = priorResult.status === 'fulfilled' ? priorResult.value : freshState(settings.url);
  const monitorErrors = priorResult.status === 'rejected' ? [priorResult.reason.monitorCode ?? 'state_read_failed'] : [];
  const lastSuccess = snapshot.status === 'healthy' ? snapshot.timestamp : previous.lastSuccess;
  const consecutiveFailures = snapshot.status === 'healthy' ? 0 : Math.min(previous.consecutiveFailures + 1, Number.MAX_SAFE_INTEGER);
  const healthyVersion = snapshot.status === 'healthy'
    ? snapshot.checks.find((check) => check.check === 'api').observation.version : previous.healthyVersion;
  const activeIncidents = [];
  const newIncidents = [];
  const recoveries = [];
  for (const check of snapshot.checks) {
    const prior = previous.activeIncidents.find((item) => item.check === check.check);
    if (check.status === 'ok') {
      if (prior) recoveries.push({
        type: 'recovery', timestamp: snapshot.timestamp, target: settings.url,
        fingerprint: prior.fingerprint, check: check.check, path: check.path,
        incidentStartedAt: prior.firstSeen, statusCode: check.statusCode,
        applicationStatus: snapshot.status, lastSuccess, consecutiveFailures, healthyVersion,
      });
      continue;
    }
    const id = fingerprint(settings.url, check);
    const incident = {
      fingerprint: id, check: check.check, code: check.code, statusCode: check.statusCode,
      firstSeen: prior?.fingerprint === id ? prior.firstSeen : snapshot.timestamp,
    };
    activeIncidents.push(incident);
    if (prior?.fingerprint !== id) newIncidents.push({
      type: 'incident', timestamp: snapshot.timestamp, target: settings.url, ...incident,
      path: check.path, ...(check.observation ? { observation: check.observation } : {}),
      ...(prior ? { replacesFingerprint: prior.fingerprint } : {}),
      rootCause: 'unconfirmed', lastSuccess: previous.lastSuccess,
      applicationStatus: snapshot.status,
      consecutiveFailures, healthyVersion: previous.healthyVersion,
    });
  }
  const state = {
    schemaVersion: 1, target: settings.url, lastCheckedAt: snapshot.timestamp,
    lastSuccess, consecutiveFailures, healthyVersion, activeIncidents,
  };
  if (monitorErrors.length === 0) {
    try {
      const events = [...newIncidents, ...recoveries];
      if (events.length) {
        await mkdir(dirname(settings.logPath), { recursive: true });
        await appendFile(settings.logPath, events.map((event) => `${JSON.stringify(event)}\n`).join(''), { mode: 0o600 });
      }
      await atomicStateWrite(settings.statePath, state);
    } catch { monitorErrors.push('persistence_failed'); }
  }
  return {
    schemaVersion: 1, ...snapshot,
    applicationStatus: snapshot.status,
    status: monitorErrors.length ? 'degraded' : snapshot.status,
    lastSuccess, consecutiveFailures, healthyVersion,
    newIncidents, recoveries, activeIncidentFingerprints: activeIncidents.map((item) => item.fingerprint),
    notificationRecommended: Boolean(newIncidents.length || recoveries.length || monitorErrors.length),
    monitorErrors,
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: node scripts/check-health.mjs --once [--url https://yourga.me] [--state .local/monitor-state.json] [--log .local/incidents.jsonl] [--timeout-ms 10000] [--retries 0|1] [--retry-delay-ms 250]\nRuns once only. Checks /api/health and /. HTTP is allowed only for localhost tests. No login, notification, scheduler, or environment-variable access.\n');
      return;
    }
    const report = await runOnce(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === 'healthy' ? 0 : 1;
  } catch (error) {
    const allowed = ['invalid_url', 'invalid_options', 'invalid_arguments', 'state_and_log_must_differ', 'check_failed'];
    process.stdout.write(`${JSON.stringify({
      timestamp: new Date().toISOString(), status: 'degraded', applicationStatus: 'unknown',
      monitorErrors: [allowed.includes(error.monitorCode) ? error.monitorCode : 'monitor_failed'],
      newIncidents: [], recoveries: [], notificationRecommended: true,
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
