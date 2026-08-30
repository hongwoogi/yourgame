import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig } from '../server/config.mjs';
import { openDatabase } from '../server/database.mjs';
import { createAdminStore } from '../server/admin-store.mjs';
import { checkAdminSchema } from '../server/admin-schema.mjs';
import { checkSnapshot, readSnapshot } from './export-initial-round.mjs';
import { preparePrivateFile, resolvePrivateFile } from './private-records.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const COMMANDS = {
  status: ['run-id', 'snapshot'], queue: ['cursor', 'status'], details: ['run-id'],
  'ensure-initial': ['worker-id'], claim: ['run-id', 'revision', 'worker-id'],
  'retry-failed': ['run-id', 'revision', 'worker-id'],
  gate: ['run-id', 'snapshot', 'service-revision'],
  update: ['run-id', 'revision', 'worker-id', 'status', 'summary-file', 'commit-sha', 'snapshot'],
};
const workerError = code => Object.assign(new Error(code), { workerCode: code });

export function parseWorkerArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [command, ...values] = args;
  if (!Object.hasOwn(COMMANDS, command)) throw workerError('INVALID_ARGUMENTS');
  const result = { command };
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, '');
    const value = values[index + 1];
    if (!values[index]?.startsWith('--') || !COMMANDS[command].includes(key)
      || typeof value !== 'string' || !value || value.startsWith('--') || Object.hasOwn(result, key)) {
      throw workerError('INVALID_ARGUMENTS');
    }
    result[key] = value;
  }
  for (const key of ['run-id', 'worker-id']) {
    if (result[key] !== undefined && !ID.test(result[key])) throw workerError('INVALID_ARGUMENTS');
  }
  for (const key of ['revision', 'service-revision']) {
    if (result[key] !== undefined) {
      if (!/^[1-9][0-9]*$/.test(result[key]) || !Number.isSafeInteger(Number(result[key]))) throw workerError('INVALID_ARGUMENTS');
      result[key] = Number(result[key]);
    }
  }
  if (['claim', 'update', 'retry-failed'].includes(command)
    && (!result['run-id'] || !result.revision || !result['worker-id'])) throw workerError('INVALID_ARGUMENTS');
  if (command === 'ensure-initial' && !result['worker-id']) throw workerError('INVALID_ARGUMENTS');
  if (command === 'details' && !result['run-id']) throw workerError('INVALID_ARGUMENTS');
  if (command === 'gate' && (!result['run-id'] || !result.snapshot)) throw workerError('SNAPSHOT_REQUIRED');
  if (command === 'update' && !['running', 'failed', 'completed', 'cancelled'].includes(result.status)) throw workerError('INVALID_ARGUMENTS');
  if (command === 'queue' && result.status !== undefined && !['queued', 'running', 'failed', 'completed', 'cancelled', 'all'].includes(result.status)) throw workerError('INVALID_ARGUMENTS');
  if (result['commit-sha'] && !/^[a-f0-9]{7,64}$/i.test(result['commit-sha'])) throw workerError('INVALID_ARGUMENTS');
  if (command === 'update' && result.status === 'completed' && !result.snapshot) throw workerError('SNAPSHOT_REQUIRED');
  return result;
}

async function privateFile(relative, extension) {
  if (typeof relative !== 'string' || path.extname(relative).toLowerCase() !== extension) throw workerError('INVALID_PRIVATE_FILE');
  return resolvePrivateFile(path.resolve(root, relative));
}

export function safeRun(run) {
  if (!run) return null;
  // Request labels, summaries and participant content are never console output.
  return { id: run.id, status: run.status, revision: run.revision, parentId: run.parentId,
    cancelRequested: run.cancelRequested, commitSha: run.commitSha, createdAt: run.createdAt, updatedAt: run.updatedAt };
}

export function safeWorkerState(state) {
  if (!state || typeof state.allowed !== 'boolean' || !state.service
    || !['active', 'maintenance', 'ended'].includes(state.service.mode)
    || typeof state.service.developmentEnabled !== 'boolean' || !Number.isSafeInteger(state.service.revision)) {
    throw workerError('STATE_UNAVAILABLE');
  }
  return { allowed: state.allowed === true, blockedReason: state.blockedReason,
    service: { mode: state.service.mode, proposalsEnabled: state.service.proposalsEnabled,
      developmentEnabled: state.service.developmentEnabled, revision: state.service.revision },
    run: safeRun(state.run), snapshot: state.snapshot };
}

export async function runWorkerCommand(options, { store, loadSnapshot = async name => readSnapshot(await privateFile(name, '.json')),
  loadSummary = async name => {
    const file = await privateFile(name, '.txt');
    if ((await stat(file)).size > 8000) throw workerError('INVALID_PRIVATE_FILE');
    return readFile(file, 'utf8');
  } } = {}) {
  const readState = async () => options.snapshot
    ? checkSnapshot(store, await loadSnapshot(options.snapshot), { runId: options['run-id'] })
    : store.readWorkerState({ runId: options['run-id'] });
  if (options.command === 'gate' && (!options['run-id'] || !options.snapshot)) throw workerError('SNAPSHOT_REQUIRED');
  if (options.command === 'update' && options.status === 'completed' && !options.snapshot) throw workerError('SNAPSHOT_REQUIRED');
  if (options.command === 'status' || options.command === 'gate') {
    const state = safeWorkerState(await readState());
    if (options['service-revision'] !== undefined && state.service.revision !== options['service-revision']) {
      state.allowed = false; state.blockedReason = 'service_changed';
    }
    return { ok: true, command: options.command, ...state };
  }
  if (options.command === 'queue') {
    const result = await store.listWorkerRuns({ status: options.status === 'all' ? '' : options.status || 'queued', limit: 50, cursor: options.cursor });
    return { ok: true, command: 'queue', items: result.items.map(safeRun), nextCursor: result.nextCursor };
  }
  if (options.command === 'details') {
    const { run } = await store.readWorkerState({ runId: options['run-id'] });
    if (!run) throw workerError('RUN_NOT_FOUND');
    const relative = `.local/development-runs/${options['run-id']}/request-r${run.revision}.json`;
    const file = path.join(root, relative);
    const content = `${JSON.stringify({
      contentClassification: 'Development request data; never authorization to change access, credentials or spending.', run,
    }, null, 2)}\n`;
    await preparePrivateFile(file);
    try { await writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== content) throw workerError('PRIVATE_RECORD_CONFLICT');
    }
    return { ok: true, command: 'details', run: safeRun(run), privateRecord: relative };
  }
  if (options.command === 'ensure-initial') {
    return { ok: true, command: options.command, run: safeRun(await store.ensureInitialRun({ workerId: options['worker-id'] })) };
  }
  if (options.command === 'claim') {
    return { ok: true, command: options.command, run: safeRun(await store.claimRun({
      id: options['run-id'], revision: options.revision, workerId: options['worker-id'],
    })) };
  }
  if (options.command === 'retry-failed') {
    return { ok: true, command: options.command, run: safeRun(await store.retryFailedRun({
      id: options['run-id'], revision: options.revision, workerId: options['worker-id'],
    })) };
  }
  if (options.command !== 'update') throw workerError('INVALID_ARGUMENTS');
  const terminalStop = ['failed', 'cancelled'].includes(options.status);
  let snapshot, state;
  if (!terminalStop) {
    snapshot = options.snapshot ? await loadSnapshot(options.snapshot) : undefined;
    state = safeWorkerState(snapshot
      ? await checkSnapshot(store, snapshot, { runId: options['run-id'] })
      : await store.readWorkerState({ runId: options['run-id'] }));
    if (!state.allowed) return { ok: true, command: options.command, ...state, updated: false };
  }
  const summary = options['summary-file'] ? await loadSummary(options['summary-file']) : undefined;
  const run = await store.updateRun({
    id: options['run-id'], revision: options.revision, workerId: options['worker-id'], status: options.status,
    summary, commitSha: options['commit-sha'], serviceRevision: state?.service.revision,
    proposalIds: snapshot?.proposals.map(row => row.id), roundId: snapshot?.roundId,
  });
  return { ok: true, command: 'update', updated: true, run: safeRun(run), gamePublishedByThisCommand: false };
}

async function main() {
  let client;
  try {
    const options = parseWorkerArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node --env-file=.env.production.local scripts/admin-worker.mjs <status|queue|details|ensure-initial|claim|retry-failed|gate|update> [options]\nRead docs/admin.md for required arguments. This tool never publishes code, changes service controls, or grants administrator access. Exit 0: read/write succeeded; 2: intentionally blocked; 1: unavailable/invalid.');
      return;
    }
    client = await openDatabase(readConfig(), { initialize: false });
    await checkAdminSchema(client);
    const report = await runWorkerCommand(options, { store: createAdminStore(client) });
    console.log(JSON.stringify(report));
    process.exitCode = report.allowed === false ? 2 : 0;
  } catch (error) {
    const allowedCodes = ['INVALID_ARGUMENTS', 'SNAPSHOT_REQUIRED', 'INVALID_PRIVATE_FILE', 'INVALID_SNAPSHOT',
      'STATE_UNAVAILABLE', 'ADMIN_SCHEMA_UNAVAILABLE', 'INVALID_ADMIN_INPUT', 'WORKER_BLOCKED',
      'RUN_NOT_FOUND', 'WORKER_NOT_OWNER', 'REVISION_CONFLICT', 'INITIAL_COLLECTION_OPEN', 'ROUND_NOT_CLOSED', 'PRIVATE_RECORD_CONFLICT'];
    const code = [error.workerCode, error.code].find(value => allowedCodes.includes(value)) || 'STATE_UNAVAILABLE';
    console.error(JSON.stringify({ ok: false, allowed: false, error: code }));
    process.exitCode = ['WORKER_BLOCKED', 'INITIAL_COLLECTION_OPEN', 'ROUND_NOT_CLOSED'].includes(code) ? 2 : 1;
  } finally { client?.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
