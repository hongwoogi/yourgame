import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createClient } from '@libsql/client';
import { SCHEMA, checkSchema } from '../server/database.mjs';
import { initializeAdminDatabase, checkAdminSchema } from '../server/admin-schema.mjs';
import { initializeSafetyDatabase, checkSafetySchema } from '../server/safety-schema.mjs';
import { COMMUNITY_SCHEMA, checkCommunitySchema } from '../server/community-schema.mjs';
import { initializeContributionDatabase, checkContributionSchema } from '../server/contribution-schema.mjs';
import { COMMUNITY_DEFAULT_TRIGGER_NAMES } from '../server/community-policy.mjs';
import { parsePreparationArgs, preparationFailure, preparePublicDefaultSchema } from '../scripts/prepare-public-defaults.mjs';

const script = fileURLToPath(new URL('../scripts/prepare-public-defaults.mjs', import.meta.url));
const testScript = fileURLToPath(import.meta.url);
const serial = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? String(item) : item);
const digest = value => createHash('sha256').update(serial(value)).digest('hex');

function test(name, action) {
  return nodeTest(name, async t => {
    if (process.platform !== 'win32' || process.env.YOURGAME_PREPARATION_TEST_WORKER === '1') return action(t);
    // The installed native SDK's transaction.close() ends the transaction but
    // retains its detached SQLite connection until GC. On Windows, run the real
    // file transaction in a child and delete its fixture only after process exit.
    const prefix = join(tmpdir(), 'yourgame-public-default-preparation-');
    const directory = await mkdtemp(prefix);
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    t.after(async () => {
      assert.ok(resolve(directory).startsWith(resolve(prefix)));
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });
    const env = Object.fromEntries(Object.entries({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      TEMP: tmpdir(), TMP: tmpdir(), NODE_ENV: 'test', YOURGAME_PREPARATION_TEST_WORKER: '1',
      YOURGAME_PREPARATION_TEST_DIRECTORY: directory,
    }).filter(([, value]) => value !== undefined));
    const pattern = '^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
    const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', pattern, testScript], {
      cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

async function fixture(t, { initialize = true } = {}) {
  const prefix = join(tmpdir(), 'yourgame-public-default-preparation-');
  const workerDirectory = process.env.YOURGAME_PREPARATION_TEST_WORKER === '1' ? process.env.YOURGAME_PREPARATION_TEST_DIRECTORY : null;
  const directory = workerDirectory || await mkdtemp(prefix);
  assert.ok(resolve(directory).startsWith(resolve(prefix)));
  const filename = join(directory, 'preparation.db');
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    if (workerDirectory) return; // Parent removes it after this process releases native handles.
    // Only the unique directory created by this fixture may be removed.
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const open = async () => {
    const client = createClient({ url: 'file:' + filename.replaceAll('\\', '/') });
    clients.push(client);
    await client.execute('PRAGMA foreign_keys = ON');
    return client;
  };
  const run = (args, extra = {}) => {
    const env = Object.fromEntries(Object.entries({ SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      TEMP: directory, TMP: directory, NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:3000',
      TURSO_DATABASE_URL: 'file:' + filename.replaceAll('\\', '/'), TURSO_AUTH_TOKEN: '', ...extra,
    }).filter(([, value]) => value !== undefined));
    return spawnSync(process.execPath, [script, ...args], { cwd: directory, env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  };
  if (!initialize) return { filename, open, run };
  const client = await open();
  const userId = randomUUID();
  const body = 'Synthetic private fixture content, never a real submission.';
  const createdAt = Date.parse('2026-08-30T00:00:00.000Z');
  await client.batch(SCHEMA, 'write');
  await client.batch([
    { sql: 'INSERT INTO users(id, google_sub, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      args: [userId, `synthetic-sub-${userId}`, 'Synthetic fixture member', createdAt, createdAt] },
    { sql: `INSERT INTO proposals(id, user_id, request_id, request_body_hash, body, created_at, updated_at, round_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'initial')`,
      args: [randomUUID(), userId, randomUUID(), createHash('sha256').update(body).digest('hex'), body, createdAt, createdAt] },
  ], 'write');
  await initializeAdminDatabase(client);
  await initializeSafetyDatabase(client);
  // Reproduce the previous schema, without installing the new public policy.
  await client.batch(COMMUNITY_SCHEMA, 'write');
  await initializeContributionDatabase(client);
  await client.execute({ sql: `INSERT INTO community_profiles(user_id, public_id, alias, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`, args: [userId, randomUUID(), `Player-${randomBytes(6).toString('hex')}`, createdAt, createdAt] });
  await client.execute({ sql: 'UPDATE service_control SET message = ?, updated_at = ? WHERE id = 1',
    args: ['Synthetic unchanged service notice', createdAt] });
  assert.equal(Number((await client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'community_public_policy'")).rows[0].n), 0);
  return { client, filename, open, run };
}

async function snapshot(client) {
  const shape = (await client.execute("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")).rows;
  const tables = {};
  for (const table of shape.filter(row => row.type === 'table')) {
    assert.match(table.name, /^[a-z_]+$/);
    const result = await client.execute(`SELECT * FROM ${table.name}`);
    tables[table.name] = result.rows.map(row => digest(result.columns.map(key => [key, row[key]]))).sort();
  }
  return { shape: digest(shape), tables };
}

function observe(client, { afterBatch, afterCommit } = {}) {
  const facts = { transactions: 0, writeMode: true, mutations: 0, batches: 0, rollbacks: 0, commits: 0 };
  const count = statement => {
    if (/^\s*(?:CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE)\b/i.test(typeof statement === 'string' ? statement : statement.sql)) facts.mutations += 1;
  };
  return { facts, client: { transaction: async mode => {
    facts.transactions += 1;
    facts.writeMode &&= mode === 'write';
    const transaction = await client.transaction(mode);
    return {
      execute: async statement => { count(statement); return transaction.execute(statement); },
      batch: async statements => {
        facts.batches += 1;
        statements.forEach(count);
        const result = await transaction.batch(statements);
        await afterBatch?.(transaction, statements);
        return result;
      },
      commit: async () => { facts.commits += 1; await transaction.commit(); await afterCommit?.(); },
      rollback: async () => { facts.rollbacks += 1; return transaction.rollback(); },
      close: () => transaction.close(),
    };
  } } };
}

test('preparation rejects malformed/duplicate revisions before opening a database', async t => {
  const f = await fixture(t, { initialize: false });
  assert.deepEqual(parsePreparationArgs(['--expected-service-revision=1']), { help: false, expectedServiceRevision: 1 });
  assert.deepEqual(parsePreparationArgs(['--expected-service-revision', '9007199254740991']),
    { help: false, expectedServiceRevision: Number.MAX_SAFE_INTEGER });
  for (const args of [[], ['--expected-service-revision', '0'], ['--expected-service-revision', '01'],
    ['--expected-service-revision', '-1'], ['--expected-service-revision', '1.0'], ['--expected-service-revision', '1e0'],
    ['--expected-service-revision', ' 1'], ['--expected-service-revision', '9007199254740992'],
    ['--expected-service-revision', '1', '--expected-service-revision', '1'], ['--help', '--expected-service-revision', '1'],
    ['--expected-service-revision', '1', 'positional'], ['--unknown', 'SYNTHETIC_PRIVATE_ARGUMENT']]) {
    assert.throws(() => parsePreparationArgs(args), error => error.code === 'INVALID_ARGUMENTS');
    const result = f.run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^Usage:/);
    assert.doesNotMatch(result.stdout + result.stderr, /SYNTHETIC_PRIVATE_ARGUMENT/);
  }
  assert.equal(f.run(['--help']).status, 0);
  await assert.rejects(stat(f.filename), error => error.code === 'ENOENT');
  let opened = false;
  await assert.rejects(preparePublicDefaultSchema({ transaction: () => { opened = true; } }, { expectedServiceRevision: 0 }),
    error => error.code === 'INVALID_ARGUMENTS');
  assert.equal(opened, false);
});

test('preparation requires an explicit database URL and never falls back in production', async t => {
  const f = await fixture(t, { initialize: false });
  for (const mode of [{ NODE_ENV: 'production' }, { NODE_ENV: 'test', VERCEL: '1' }, { NODE_ENV: 'test' }]) {
    const result = f.run(['--expected-service-revision', '1'], { ...mode, APP_ORIGIN: 'https://yourga.me', TURSO_DATABASE_URL: '' });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stderr), { prepared: null, committed: null, transactionOutcome: 'not_started',
      code: 'DATABASE_UNCONFIGURED', message: 'Preparation did not start.' });
    assert.equal(result.stdout, '');
  }
  await assert.rejects(stat(f.filename), error => error.code === 'ENOENT');
});

test('initializer failure rolls back every new DDL object and seed row and redacts the error', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.client);
  let injected = false;
  const observed = observe(f.client, { afterBatch: async (_, statements) => {
    if (statements.some(statement => String(statement.sql || statement).includes('CREATE TABLE IF NOT EXISTS community_public_policy'))) {
      injected = true;
      throw Object.assign(new Error('SYNTHETIC_PRIVATE_PROVIDER_ERROR'), { code: 'SYNTHETIC_PRIVATE_PROVIDER_ERROR' });
    }
  } });
  await assert.rejects(preparePublicDefaultSchema(observed.client, { expectedServiceRevision: 1 }), error => {
    const safe = preparationFailure(error);
    assert.equal(safe.transactionOutcome, 'rolled_back');
    assert.equal(safe.code, 'DATABASE_ERROR');
    assert.doesNotMatch(serial(safe), /SYNTHETIC_PRIVATE_PROVIDER_ERROR|SELECT|CREATE|sqlite/i);
    return true;
  });
  assert.equal(injected, true);
  assert.equal(observed.facts.commits, 0);
  assert.equal(observed.facts.rollbacks, 1);
  assert.equal(observed.facts.writeMode, true);
  assert.deepEqual(await snapshot(f.client), before);
});

for (const [label, update, code] of [
  ['maintenance', "mode = 'maintenance'", 'SERVICE_NOT_ACTIVE'],
  ['ended', "mode = 'ended', proposals_enabled = 0, development_enabled = 0", 'SERVICE_NOT_ACTIVE'],
  ['proposals disabled', 'proposals_enabled = 0', 'SERVICE_NOT_ACTIVE'],
  ['development disabled', 'development_enabled = 0', 'SERVICE_NOT_ACTIVE'],
  ['stale revision', 'revision = 2', 'SERVICE_REVISION_CONFLICT'],
]) test(`preparation ${label} guard runs before any DDL or data mutation`, async t => {
  const f = await fixture(t);
  await f.client.execute(`UPDATE service_control SET ${update} WHERE id = 1`);
  const before = await snapshot(f.client);
  const observed = observe(f.client);
  await assert.rejects(preparePublicDefaultSchema(observed.client, { expectedServiceRevision: 1 }), error => error.code === code);
  assert.equal(observed.facts.transactions, 1);
  assert.equal(observed.facts.writeMode, true);
  assert.equal(observed.facts.mutations, 0);
  assert.equal(observed.facts.batches, 0);
  assert.equal(observed.facts.commits, 0);
  assert.deepEqual(await snapshot(f.client), before);
});

test('preparation detects an initializer changing the service notice and rolls it back', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.client);
  const observed = observe(f.client, { afterBatch: async (transaction, statements) => {
    if (statements.some(statement => String(statement.sql || statement).includes('CREATE TABLE IF NOT EXISTS contribution_ledger'))) {
      await transaction.execute("UPDATE service_control SET message = 'Synthetic unexpected initializer side effect' WHERE id = 1");
    }
  } });
  await assert.rejects(preparePublicDefaultSchema(observed.client, { expectedServiceRevision: 1 }),
    error => error.code === 'SERVICE_CONTROL_CHANGED' && error.transactionOutcome === 'rolled_back');
  assert.equal(observed.facts.commits, 0);
  assert.deepEqual(await snapshot(f.client), before);
});

test('inactive preparation commits preserve every original row and repeated preparation changes nothing', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.client);
  const result = await preparePublicDefaultSchema(f.client, { expectedServiceRevision: 1 });
  assert.equal(result.prepared, true);
  assert.equal(result.committed, true);
  assert.equal(result.policyState, 'inactive');
  assert.equal(result.serviceControlPreserved, true);
  assert.deepEqual(result.schemaAdded, { tables: 6, triggers: COMMUNITY_DEFAULT_TRIGGER_NAMES.length });
  assert.deepEqual(result.counts, { users: 1, proposals: 1, bodyHistory: 1, safetyReviews: 1, contributionAwards: 0,
    profiles: 1, publications: 0, votes: 0 });
  assert.ok(Object.values(result.policyCounts).every(value => value === 0));
  // Application health requires active policy and must not be used for preparation.
  for (const check of [checkSchema, checkAdminSchema, checkSafetySchema, checkCommunitySchema, checkContributionSchema]) await check(f.client);
  const after = await snapshot(f.client);
  for (const [table, rows] of Object.entries(before.tables)) {
    for (const row of rows) assert.ok(after.tables[table].includes(row), 'An original row changed.');
    if (table !== 'community_meta') assert.deepEqual(after.tables[table], rows);
  }
  assert.equal((await f.client.execute('SELECT state FROM community_public_policy WHERE id = 1')).rows[0].state, 'inactive');
  const repeat = await preparePublicDefaultSchema(f.client, { expectedServiceRevision: 1 });
  assert.deepEqual(repeat.schemaAdded, { tables: 0, triggers: 0 });
  assert.deepEqual(await snapshot(f.client), after);
});

test('preparation refuses an active policy without deactivating it or reinitializing', async t => {
  const f = await fixture(t);
  await preparePublicDefaultSchema(f.client, { expectedServiceRevision: 1 });
  // This policy-state fixture exists only in a unique local test database.
  await f.client.execute("UPDATE community_public_policy SET state = 'active', activated_at = 1, service_revision = 1 WHERE id = 1");
  const before = await snapshot(f.client);
  const observed = observe(f.client);
  await assert.rejects(preparePublicDefaultSchema(observed.client, { expectedServiceRevision: 1 }), error => error.code === 'POLICY_ALREADY_ACTIVE');
  assert.equal(observed.facts.mutations, 0);
  assert.equal(observed.facts.commits, 0);
  assert.deepEqual(await snapshot(f.client), before);
});

test('a lost commit response remains unknown even when the database actually committed', async t => {
  const f = await fixture(t);
  const observed = observe(f.client, { afterCommit: () => { throw new Error('SYNTHETIC_PRIVATE_PROVIDER_ERROR'); } });
  await assert.rejects(preparePublicDefaultSchema(observed.client, { expectedServiceRevision: 1 }), error => {
    const safe = preparationFailure(error);
    assert.equal(safe.prepared, null);
    assert.equal(safe.committed, null);
    assert.equal(safe.transactionOutcome, 'unknown');
    assert.equal(safe.code, 'DATABASE_ERROR');
    assert.doesNotMatch(serial(safe), /SYNTHETIC_PRIVATE_PROVIDER_ERROR/);
    return true;
  });
  assert.equal(observed.facts.commits, 1);
  assert.equal((await f.client.execute('SELECT state FROM community_public_policy WHERE id = 1')).rows[0].state, 'inactive');
});

test('preparation CLI prints only fixed policy/control fields and aggregate counts on success', async t => {
  const f = await fixture(t);
  f.client.close();
  const result = f.run(['--expected-service-revision', '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output).sort(), ['committed', 'counts', 'policyCounts', 'policyState', 'policyVersion', 'prepared',
    'schemaAdded', 'service', 'serviceControlPreserved'].sort());
  assert.equal(output.policyState, 'inactive');
  assert.equal(output.counts.proposals, 1);
  assert.doesNotMatch(result.stdout, /Synthetic|Player-|synthetic-sub-|file:|token|body_hash/i);
  const inspect = await f.open();
  assert.equal((await inspect.execute('SELECT state FROM community_public_policy WHERE id = 1')).rows[0].state, 'inactive');
});
