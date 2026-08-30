import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { createAdminStore } from '../server/admin-store.mjs';
import { initializeAdminDatabase } from '../server/admin-schema.mjs';
import { checkSnapshot, exportInitialRound, readSnapshot, validateSnapshot } from '../scripts/export-initial-round.mjs';
import { preparePrivateFile } from '../scripts/private-records.mjs';
import { backendFixture, TEST_CLOCK_SQL } from './backend-helpers.mjs';

async function fixture(t) {
  const f = await backendFixture(t);
  await initializeAdminDatabase(f.client);
  const directory = await mkdtemp(join(tmpdir(), 'yourgame-snapshot-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert(basename(target).startsWith('yourgame-snapshot-'));
    await rm(target, { recursive: true, force: true });
  });
  const store = createAdminStore(f.client, { now: f.now, databaseClockSql: TEST_CLOCK_SQL });
  const output = join(directory, 'snapshot.json');
  return { ...f, admin: store, output, directory,
    export: () => exportInitialRound({ client: f.client, store, output, privateRoot: directory, databaseClockSql: TEST_CLOCK_SQL }) };
}

test('initial export refuses an open collection and intentional service closure without creating a file', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.export(), { snapshotReady: false, blockedReason: 'initial_collection_open' });
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
  await f.setTime(INITIAL_CUTOFF);
  await f.client.execute("UPDATE service_control SET mode = 'ended', proposals_enabled = 0, development_enabled = 0 WHERE id = 1");
  assert.deepEqual(await f.export(), { snapshotReady: false, blockedReason: 'service_ended' });
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('export excludes moderated and suspended input, preserves originals, and never overwrites a stale frozen snapshot', async t => {
  const f = await fixture(t);
  const one = await f.login('12345678901');
  const two = await f.login('12345678902');
  const keep = await f.store.createProposal(one.session.user.id, { body: '세로 화면 터치 조작', requestId: 'snapshot-keep' });
  const excluded = await f.store.createProposal(one.session.user.id, { body: 'excluded original', requestId: 'snapshot-exclude' });
  await f.store.createProposal(two.session.user.id, { body: 'suspended original', requestId: 'snapshot-suspend' });
  await f.client.execute({
    sql: "INSERT INTO proposal_moderation(proposal_id, moderation, reason, updated_at) VALUES (?, 'excluded', 'test exclusion', ?)",
    args: [excluded.proposal.id, f.now()],
  });
  await f.client.execute({ sql: "UPDATE member_access SET status = 'suspended' WHERE user_id = ?", args: [two.session.user.id] });
  await f.setTime(INITIAL_CUTOFF);
  const exported = await f.export();
  assert.equal(exported.snapshotReady, true);
  assert.equal(exported.proposalCount, 1);
  const frozen = await readFile(f.output, 'utf8');
  const snapshot = await readSnapshot(f.output);
  assert.equal(snapshot.proposals[0].id, keep.proposal.id);
  assert.equal((await f.export()).alreadyExisted, true);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS count FROM proposals')).rows[0].count, 3);
  await f.client.execute({
    sql: "INSERT INTO proposal_moderation(proposal_id, moderation, reason, updated_at) VALUES (?, 'excluded', 'later exclusion', ?)",
    args: [keep.proposal.id, f.now()],
  });
  const gate = await checkSnapshot(f.admin, snapshot);
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockedReason, 'snapshot_ineligible');
  await assert.rejects(f.export(), error => error.workerCode === 'FROZEN_SNAPSHOT_CONFLICT');
  assert.equal(await readFile(f.output, 'utf8'), frozen);
});

test('changed proposal bodies and corrupt digests cannot pass a later worker gate', async t => {
  const f = await fixture(t);
  const account = await f.login();
  const accepted = await f.store.createProposal(account.session.user.id, { body: 'original input', requestId: 'snapshot-original' });
  await f.setTime(INITIAL_CUTOFF);
  await f.export();
  const snapshot = await readSnapshot(f.output);
  assert.throws(() => validateSnapshot({ ...snapshot, proposalDigest: '0'.repeat(64) }), error => error.workerCode === 'INVALID_SNAPSHOT');
  // Simulate a storage-level body change: ID presence alone must not validate input.
  await f.client.execute({ sql: 'UPDATE proposals SET body = ?, revision = revision + 1 WHERE id = ?', args: ['changed input', accepted.proposal.id] });
  const gate = await checkSnapshot(f.admin, snapshot);
  assert.equal(gate.allowed, false);
  assert.equal(gate.blockedReason, 'snapshot_changed');
});

test('database/control read failure does not produce a ready snapshot', async t => {
  const f = await fixture(t);
  await f.setTime(INITIAL_CUTOFF);
  await assert.rejects(exportInitialRound({ client: f.client, output: f.output,
    store: { readWorkerState: async () => { throw new Error('private database diagnostic'); } } }));
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('no eligible initial input stops development without freezing an empty snapshot', async t => {
  const f = await fixture(t);
  await f.setTime(INITIAL_CUTOFF);
  const report = await f.export();
  assert.equal(report.snapshotReady, false);
  assert.equal(report.blockedReason, 'no_eligible_proposals');
  await assert.rejects(readFile(f.output), { code: 'ENOENT' });
});

test('private-record parent junctions cannot redirect writes into public or external directories', async t => {
  const f = await fixture(t);
  const privateRoot = join(f.directory, 'private');
  const publicRoot = join(f.directory, 'public');
  await mkdir(privateRoot); await mkdir(publicRoot);
  await symlink(publicRoot, join(privateRoot, 'redirected'), 'junction');
  await assert.rejects(preparePrivateFile(join(privateRoot, 'redirected', 'snapshot.json'), { privateRoot }),
    error => error.workerCode === 'INVALID_PRIVATE_FILE');
  await assert.rejects(readFile(join(publicRoot, 'snapshot.json')), { code: 'ENOENT' });
});
