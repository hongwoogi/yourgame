#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI_VERSION = '59.10.0';
const LOOKBACK_MS = 10 * 60 * 1000;
const RETENTION_MS = 2 * 60 * 60 * 1000;
const MAX_RECORDS = 50;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const API_PATHS = new Set(['/api/status', '/api/session', '/api/login', '/api/logout', '/api/proposals', '/api/health']);
const QUERY_CODES = new Set([
  'cli_unavailable', 'project_not_linked', 'query_timeout', 'query_output_too_large',
  'authentication_required', 'access_denied', 'plan_restricted', 'unsupported_cli',
  'network_error', 'query_failed', 'invalid_log_output', 'unsupported_log_schema',
]);
const CLI_ARGUMENTS = Object.freeze([
  'logs', '--environment', 'production', '--status-code', '5xx', '--since', '10m',
  '--limit', '50', '--json', '--scope', 'hso1025-2820s-projects', '--no-follow',
]);

const failure = code => Object.assign(new Error(code), { monitorCode: code });
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isTimestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

function settings(options = {}) {
  const cwd = resolve(options.cwd ?? PROJECT_ROOT);
  const timeoutMs = options.timeoutMs ?? 25000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 28000) throw failure('invalid_options');
  return { cwd, timeoutMs, statePath: resolve(cwd, options.statePath ?? '.local/runtime-monitor-state.json') };
}

export function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--once') continue;
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (!['--state', '--timeout-ms'].includes(flag)) throw failure('invalid_arguments');
    const value = args[++index];
    if (!value || value.startsWith('--')) throw failure('invalid_arguments');
    options[flag === '--state' ? 'statePath' : 'timeoutMs'] = flag === '--state' ? value : Number(value);
  }
  return options;
}

export async function findCachedCli(cwd, env = process.env) {
  const candidates = [join(cwd, 'node_modules', 'vercel')];
  const caches = new Set([
    env.npm_config_cache, env.NPM_CONFIG_CACHE,
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'npm-cache'),
    join(homedir(), '.npm'),
  ].filter(Boolean).map(path => resolve(path)));
  for (const cache of caches) {
    const root = join(cache, '_npx');
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.slice(0, 200)) {
      if (entry.isDirectory()) candidates.push(join(root, entry.name, 'node_modules', 'vercel'));
    }
  }
  for (const directory of candidates) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (manifest.name !== 'vercel' || manifest.version !== CLI_VERSION) continue;
      const entry = join(directory, 'dist', 'index.js');
      await access(entry);
      return entry;
    } catch { /* A missing/incompatible cache is never repaired or installed. */ }
  }
  throw failure('cli_unavailable');
}

export function classifyCliFailure(result) {
  if (result.errorCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'query_output_too_large';
  if (result.timedOut) return 'query_timeout';
  if (result.errorCode === 'ENOENT') return 'cli_unavailable';
  // Text is used only for classification and never returned, persisted or logged.
  const diagnostic = typeof result.stderr === 'string' ? result.stderr : '';
  if (/upgrade\s+(?:to|your)|requires?\s+(?:a\s+)?(?:pro|enterprise)|not available[^\n]{0,80}plan|payment.required|\b402\b/i.test(diagnostic)) return 'plan_restricted';
  if (/unknown (?:or unexpected )?option|unsupported (?:option|flag)|unrecognized option|invalid option/i.test(diagnostic)) return 'unsupported_cli';
  if (/not logged in|no existing credentials|vercel login|invalid token|token[^\n]{0,40}(?:expired|invalid|not valid)|unauthorized|\b401\b/i.test(diagnostic)) return 'authentication_required';
  if (/forbidden|not authorized|insufficient permissions|\b403\b/i.test(diagnostic)) return 'access_denied';
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network error/i.test(diagnostic)) return 'network_error';
  return 'query_failed';
}

export async function queryProductionLogs(options) {
  const normalized = settings(options);
  try { await access(join(normalized.cwd, '.vercel', 'project.json')); }
  catch { throw failure('project_not_linked'); }
  const cli = await findCachedCli(normalized.cwd);
  return new Promise(resolveResult => {
    // Execute the already cached JS entry directly. This avoids Windows .cmd
    // shell quoting, npx installation, interactive setup and shell expansion.
    execFile(process.execPath, [cli, ...CLI_ARGUMENTS], {
      cwd: normalized.cwd, timeout: normalized.timeoutMs, killSignal: 'SIGKILL',
      maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true, shell: false,
      env: { ...process.env, CI: '1', NO_COLOR: '1', VERCEL_TELEMETRY_DISABLED: '1' },
    }, (error, stdout, stderr) => resolveResult({
      ok: !error,
      stdout,
      stderr,
      timedOut: Boolean(error?.killed && error?.signal === 'SIGKILL'),
      errorCode: typeof error?.code === 'string' ? error.code : null,
    })).stdin?.end();
  });
}

function safeRequestId(value) {
  if (typeof value !== 'string' || value.length > 160) return null;
  return /^(?:[a-z]{3}\d::){1,3}[A-Za-z0-9_-]{1,40}-\d{10,16}-[A-Za-z0-9_-]{6,80}$/.test(value)
    || /^req_[A-Za-z0-9]{16,80}$/.test(value)
    || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
    ? value : null;
}

function normalizeRecord(record, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.requestPath !== 'string' || !Number.isInteger(record.responseStatusCode)) {
    return { invalid: true };
  }
  const path = record.requestPath.split(/[?#]/, 1)[0];
  if (!API_PATHS.has(path) || record.responseStatusCode < 500 || record.responseStatusCode > 599
    || (record.environment !== undefined && record.environment !== 'production')) return { ignored: true };
  const milliseconds = typeof record.timestamp === 'number' ? record.timestamp
    : isTimestamp(record.timestamp) ? Date.parse(record.timestamp) : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < Date.UTC(2020, 0, 1) || milliseconds > now + 120000) return { invalid: true };
  if (milliseconds < now - LOOKBACK_MS - 30000) return { ignored: true };
  const requestId = safeRequestId(record.id);
  const deploymentId = typeof record.deploymentId === 'string' && /^dpl_[A-Za-z0-9]{10,80}$/.test(record.deploymentId)
    ? record.deploymentId : null;
  const event = {
    timestamp: new Date(milliseconds).toISOString(), path, statusCode: record.responseStatusCode,
    ...(requestId ? { requestId } : {}), ...(deploymentId ? { deploymentId } : {}),
  };
  return { event: { ...event, fingerprint: fingerprint(event) } };
}

export function parseRuntimeLogs(stdout, now = Date.now()) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
    return { events: [], recordCount: 0, ignoredCount: 0, failureCode: 'invalid_log_output', limitReached: false };
  }
  const lines = stdout.split(/\r?\n/).filter(line => line.trim());
  const events = new Map();
  let ignoredCount = 0;
  let failureCode = null;
  for (const line of lines.slice(0, MAX_RECORDS)) {
    let record;
    try { record = JSON.parse(line); } catch { failureCode = 'invalid_log_output'; continue; }
    const normalized = normalizeRecord(record, now);
    if (normalized.invalid) failureCode ||= 'unsupported_log_schema';
    if (normalized.ignored) ignoredCount += 1;
    if (normalized.event) events.set(normalized.event.fingerprint, normalized.event);
  }
  return {
    events: [...events.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.fingerprint.localeCompare(b.fingerprint)),
    recordCount: Math.min(lines.length, MAX_RECORDS), ignoredCount, failureCode,
    limitReached: lines.length >= MAX_RECORDS,
  };
}

function emptyState() {
  return { schemaVersion: 1, lastSuccessfulQueryAt: null, seen: [], queryFailure: null, limitWarningActive: false };
}

async function readState(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return emptyState(); throw failure('state_read_failed'); }
  let state;
  try { state = JSON.parse(raw); } catch { throw failure('state_invalid'); }
  if (!state || state.schemaVersion !== 1 || !Array.isArray(state.seen) || state.seen.length > 5000
    || (state.lastSuccessfulQueryAt !== null && !isTimestamp(state.lastSuccessfulQueryAt))
    || typeof state.limitWarningActive !== 'boolean'
    || state.seen.some(item => !item || !/^[a-f0-9]{64}$/.test(item.fingerprint) || !isTimestamp(item.timestamp))
    || (state.queryFailure !== null && (!state.queryFailure || !QUERY_CODES.has(state.queryFailure.code) || !isTimestamp(state.queryFailure.firstSeen)))) {
    throw failure('state_invalid');
  }
  return {
    ...emptyState(), lastSuccessfulQueryAt: state.lastSuccessfulQueryAt,
    seen: state.seen.map(({ fingerprint, timestamp }) => ({ fingerprint, timestamp })),
    limitWarningActive: state.limitWarningActive,
    queryFailure: state.queryFailure ? { code: state.queryFailure.code, firstSeen: state.queryFailure.firstSeen } : null,
  };
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

export async function runOnce(options = {}, { query = queryProductionLogs, now = Date.now } = {}) {
  const normalized = settings(options);
  const startedAt = now();
  const timestamp = new Date(startedAt).toISOString();
  const [stateResult, queryResult] = await Promise.allSettled([readState(normalized.statePath), query(normalized)]);
  const previous = stateResult.status === 'fulfilled' ? stateResult.value : emptyState();
  const monitorErrors = stateResult.status === 'rejected' ? [stateResult.reason.monitorCode || 'state_read_failed'] : [];
  let queryCode = null;
  let parsed = { events: [], recordCount: 0, ignoredCount: 0, failureCode: null, limitReached: false };
  if (queryResult.status === 'rejected') {
    queryCode = QUERY_CODES.has(queryResult.reason?.monitorCode) ? queryResult.reason.monitorCode : 'query_failed';
  } else {
    parsed = parseRuntimeLogs(queryResult.value?.stdout, startedAt);
    queryCode = queryResult.value?.ok ? parsed.failureCode : classifyCliFailure(queryResult.value || {});
  }
  const seen = new Map(previous.seen.filter(event => Date.parse(event.timestamp) >= startedAt - RETENTION_MS)
    .map(event => [event.fingerprint, event]));
  const newIncidents = parsed.events.filter(event => !seen.has(event.fingerprint));
  for (const event of parsed.events) seen.set(event.fingerprint, { fingerprint: event.fingerprint, timestamp: event.timestamp });
  const queryFailure = queryCode ? {
    code: queryCode,
    firstSeen: previous.queryFailure?.code === queryCode ? previous.queryFailure.firstSeen : timestamp,
  } : null;
  const queryRecovered = Boolean(!queryCode && previous.queryFailure);
  const newQueryFailure = Boolean(queryCode && previous.queryFailure?.code !== queryCode);
  const newLimitWarning = parsed.limitReached && !previous.limitWarningActive;
  const state = {
    ...emptyState(), lastCheckedAt: timestamp,
    lastSuccessfulQueryAt: queryCode ? previous.lastSuccessfulQueryAt : timestamp,
    seen: [...seen.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 5000),
    queryFailure, limitWarningActive: parsed.limitReached,
  };
  if (!monitorErrors.length) {
    try { await atomicStateWrite(normalized.statePath, state); }
    catch { monitorErrors.push('state_write_failed'); }
  }
  const status = queryCode || monitorErrors.length || parsed.limitReached ? 'degraded'
    : parsed.events.length ? 'errors_observed' : 'clear';
  return {
    schemaVersion: 1, timestamp, environment: 'production', lookbackMinutes: 10, limit: MAX_RECORDS,
    status, queryStatus: queryCode ? 'failed' : 'ok',
    lastSuccessfulQueryAt: state.lastSuccessfulQueryAt, queryFailure, queryRecovered,
    observedErrorCount: parsed.events.length, ignoredRecordCount: parsed.ignoredCount,
    newIncidents, limitReached: parsed.limitReached,
    notificationRecommended: Boolean(newIncidents.length || newQueryFailure || queryRecovered || newLimitWarning || monitorErrors.length),
    monitorErrors,
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: node scripts/check-runtime-errors.mjs --once [--state .local/runtime-monitor-state.json] [--timeout-ms 25000]\nReads the last 10 minutes of production 5xx request logs once using cached Vercel CLI 59.10.0. Does not install, follow, change plans/settings, or send notifications. Output/state excludes log messages, query strings, domains and personal data.\n');
      return;
    }
    const report = await runOnce(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.status === 'clear' ? 0 : 1;
  } catch (error) {
    const code = ['invalid_options', 'invalid_arguments'].includes(error.monitorCode) ? error.monitorCode : 'monitor_failed';
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), status: 'degraded', queryStatus: 'failed', monitorErrors: [code], newIncidents: [], notificationRecommended: true })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
