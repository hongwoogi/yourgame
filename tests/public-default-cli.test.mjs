import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readConfig } from '../server/config.mjs';
import { initializeDatabase, openDatabase } from '../server/database.mjs';

const script = fileURLToPath(new URL('../scripts/activate-public-defaults.mjs', import.meta.url));

async function fixture(t) {
  const prefix = join(tmpdir(), 'yourgame-public-default-cli-');
  const directory = await mkdtemp(prefix);
  assert.ok(resolve(directory).startsWith(resolve(prefix)));
  t.after(async () => {
    // This generated directory is the only recursive cleanup target.
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const database = join(directory, 'activation.db');
  const env = { ...process.env, NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:3000',
    TURSO_DATABASE_URL: 'file:' + database.replaceAll('\\', '/'), TURSO_AUTH_TOKEN: '' };
  delete env.VERCEL;
  const run = args => spawnSync(process.execPath, [script, ...args], {
    env, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  return { database, env, run };
}

test('public-default activation CLI rejects missing, duplicate and malformed revisions before opening a database', async t => {
  const { database, run } = await fixture(t);
  for (const args of [[], ['--expected-service-revision', '0'], ['--expected-service-revision', '01'],
    ['--expected-service-revision', '9007199254740992'], ['--expected-service-revision', '1', '--expected-service-revision', '2'],
    ['--expected-service-revision', '1', 'unexpected'], ['--unexpected', 'PRIVATE_ARGUMENT_MUST_NOT_BE_PRINTED'],
    ['--expected-service-revision', 'PRIVATE_ARGUMENT_MUST_NOT_BE_PRINTED']]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^Usage:/);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_ARGUMENT_MUST_NOT_BE_PRINTED/);
  }
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage:/);
  await assert.rejects(stat(database), { code: 'ENOENT' });
});

test('public-default activation CLI requires prepared schema and the current service revision', async t => {
  const { env, run } = await fixture(t);
  let client = await openDatabase(readConfig(env), { initialize: false });
  await initializeDatabase(client);
  client.close();
  const stale = run(['--expected-service-revision', '2']);
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stderr).code, 'REVISION_CONFLICT');
  client = await openDatabase(readConfig(env), { initialize: false });
  assert.equal((await client.execute('SELECT state FROM community_public_policy WHERE id = 1')).rows[0].state, 'inactive');
  client.close();
  const activated = run(['--expected-service-revision', '1']);
  assert.equal(activated.status, 0, activated.stderr);
  assert.deepEqual(JSON.parse(activated.stdout), { policyVersion: 'public-default-v1', active: true,
    serviceRevision: 1, profilesAdded: 0, publicationsAdded: 0, defaultEventsAdded: 0 });
  const repeated = run(['--expected-service-revision=1']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.deepEqual(JSON.parse(repeated.stdout), JSON.parse(activated.stdout));
});

test('public-default activation CLI does not activate a paused service', async t => {
  const { env, run } = await fixture(t);
  let client = await openDatabase(readConfig(env), { initialize: false });
  await initializeDatabase(client);
  await client.execute("UPDATE service_control SET proposals_enabled = 0, revision = revision + 1 WHERE id = 1");
  client.close();
  const result = run(['--expected-service-revision', '2']);
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).code, 'PROPOSALS_PAUSED');
  client = await openDatabase(readConfig(env), { initialize: false });
  assert.equal((await client.execute('SELECT state FROM community_public_policy WHERE id = 1')).rows[0].state, 'inactive');
  assert.equal(Number((await client.execute('SELECT COUNT(*) AS count FROM community_policy_transitions')).rows[0].count), 0);
  client.close();
});

test('public-default activation CLI never falls back to a local database in production', async t => {
  const { env, run } = await fixture(t);
  env.APP_ORIGIN = 'https://yourga.me';
  env.TURSO_DATABASE_URL = '';
  for (const mode of ['node-production', 'vercel']) {
    env.NODE_ENV = mode === 'node-production' ? 'production' : 'test';
    if (mode === 'vercel') env.VERCEL = '1';
    else delete env.VERCEL;
    const result = run(['--expected-service-revision', '1']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'DATABASE_UNCONFIGURED');
    assert.equal(JSON.parse(result.stderr).active, null);
    assert.equal(result.stdout, '');
  }
});
