import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@libsql/client';
import { CONTRIBUTION_POLICY_VERSION, MAX_VOTE_COUNT, publicContributionPolicy, formatHalfPoints,
  previewContribution, previewRequirementContributions, contributionAwardKey } from '../server/contribution-policy.mjs';
import { initializeContributionDatabase, checkContributionSchema } from '../server/contribution-schema.mjs';
import { createContributionStore, MAX_CONTRIBUTION_READ_ROWS } from '../server/contribution-store.mjs';

const NOW = Date.parse('2026-08-31T05:00:00.000Z');
const CLOCK = '(SELECT now_ms FROM test_clock WHERE id = 1)';
const hash = value => createHash('sha256').update(value).digest('hex');
const errorCode = code => error => error.code === code;

async function fixture(t) {
  const client = createClient({ url: 'file::memory:' });
  t.after(() => client.close());
  await client.execute('PRAGMA foreign_keys = ON');
  // Minimal identity/community fixtures are private, local test data. They have
  // the same columns used by these queries, without invoking Google or a cloud DB.
  await client.batch([
    'CREATE TABLE users(id TEXT PRIMARY KEY, google_sub TEXT UNIQUE, name TEXT)',
    'CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires_at INTEGER)',
    "CREATE TABLE member_access(user_id TEXT PRIMARY KEY REFERENCES users(id), status TEXT, email TEXT)",
    `CREATE TABLE community_profiles(user_id TEXT PRIMARY KEY REFERENCES users(id), public_id TEXT UNIQUE,
      alias TEXT UNIQUE, leaderboard_visible INTEGER NOT NULL DEFAULT 0)`,
    'CREATE TABLE community_rounds(id TEXT PRIMARY KEY)',
    "INSERT INTO community_rounds(id) VALUES ('initial')",
    'CREATE TABLE test_clock(id INTEGER PRIMARY KEY, now_ms INTEGER NOT NULL)',
    { sql: 'INSERT INTO test_clock(id, now_ms) VALUES (1, ?)', args: [NOW] },
  ], 'write');
  await initializeContributionDatabase(client);
  const store = createContributionStore(client, { databaseClockSql: CLOCK });
  return {
    client, store,
    async user({ visible = false, status = 'active', expiresAt = NOW + 3600000,
      id = randomUUID(), publicId = randomUUID(), alias = `Player-${randomBytes(6).toString('hex')}` } = {}) {
      const tokenHash = hash(randomUUID());
      await client.batch([
        { sql: 'INSERT INTO users(id, google_sub, name) VALUES (?, ?, ?)', args: [id, `private-google-${id}`, 'Private Google display name'] },
        { sql: 'INSERT INTO member_access(user_id, status, email) VALUES (?, ?, ?)', args: [id, status, `private-${id}@example.test`] },
        { sql: 'INSERT INTO community_profiles(user_id, public_id, alias, leaderboard_visible) VALUES (?, ?, ?, ?)',
          args: [id, publicId, alias, visible ? 1 : 0] },
        { sql: 'INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)', args: [tokenHash, id, expiresAt] },
      ], 'write');
      return { id, publicId, alias, tokenHash, session: { tokenHash, user: { id } } };
    },
  };
}

function fictionalRecord(user, changes = {}) {
  const group = changes.requirement_group_id || randomUUID();
  const fulfillment = changes.fulfillment_id || randomUUID();
  const record = {
    id: randomUUID(), award_key: contributionAwardKey({ requirementGroupId: group, fulfillmentId: fulfillment, userId: user.id }),
    user_id: user.id, requirement_group_id: group, fulfillment_id: fulfillment, release_id: randomUUID(), round_id: 'initial',
    contribution_kind: 'proposer', adopted: 1, points_units: '200', upvotes: '0', downvotes: '0',
    scoring_policy_version: 'fixture-unissued-v1', safety_policy_version: 'fixture-teen-v1',
    source_digest: hash('fixture source'), assets_digest: hash('fixture assets'),
    release_evidence_digest: hash('fixture publication, not real evidence'),
    fulfillment_evidence_digest: hash('fixture fulfillment, not real evidence'),
    vote_snapshot_digest: hash('fixture fixed votes'), input_bindings_digest: hash('fixture exact revisions and hashes'),
    vote_snapshot_at: NOW - 120000, published_at: NOW - 60000, created_at: NOW,
    ...changes,
  };
  return record;
}

async function seedRecord(client, record, verb = 'INSERT') {
  // Direct SQL is used only to test immutable storage and exact read projection.
  // This does NOT exercise or substitute a trusted issuer: production settle()
  // remains closed, including for objects that look like these fixtures.
  const keys = Object.keys(record);
  return client.execute({ sql: `${verb} INTO contribution_ledger(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
    args: keys.map(key => record[key]) });
}

test('unconfirmed notation does not activate either preview or permit issuance', () => {
  assert.equal(CONTRIBUTION_POLICY_VERSION, null);
  assert.deepEqual(publicContributionPolicy(), {
    policyVersion: null, status: 'pending_confirmation', issuanceEnabled: false, blockedReason: 'RELEASE_REVIEW_UNAVAILABLE',
    proposer: { base: '100', upvote: { operation: null, value: '5' }, downvote: { operation: null, value: '2' } },
    voter: { base: '10', upvote: { operation: 'multiply', value: '1' }, downvote: { operation: 'multiply', value: '0.5' } },
    negativeAllowed: true, pointStep: '0.5',
  });
  assert.throws(() => previewContribution({ role: 'proposer', upvotes: 2, downvotes: 1 }), /explicit/);
  const changed = publicContributionPolicy();
  changed.proposer.upvote.operation = 'exponent';
  changed.issuanceEnabled = true;
  assert.equal(publicContributionPolicy().proposer.upvote.operation, null);
  assert.equal(publicContributionPolicy().issuanceEnabled, false);
});

test('both explicit interpretations are calculated exactly and never claim an award', () => {
  for (const [formula, points] of [['weighted', '111'], ['exponent', '339']]) {
    const result = previewContribution({ formula, role: 'proposer', upvotes: 3, downvotes: 2 });
    assert.equal(result.points, points);
    assert.equal(result.awardable, false);
    assert.equal(result.policyVersion, null);
    assert.equal(previewContribution({ formula, role: 'voter', upvotes: 3, downvotes: 2 }).points, '12');
  }
});

test('negative and half-point outcomes are retained without rounding or a zero clamp', () => {
  assert.equal(previewContribution({ formula: 'weighted', role: 'proposer', upvotes: 0, downvotes: 201 }).points, '-302');
  assert.equal(previewContribution({ formula: 'exponent', role: 'proposer', upvotes: 0, downvotes: 11 }).points, '-21');
  for (const [downvotes, points] of [[19, '0.5'], [20, '0'], [21, '-0.5'], [201, '-90.5']]) {
    const result = previewContribution({ formula: 'weighted', role: 'voter', upvotes: 0, downvotes });
    assert.equal(result.points, points);
  }
  assert.equal(formatHalfPoints(0n), '0');
  assert.throws(() => formatHalfPoints(0.5), TypeError);
});

test('large integral votes remain precise beyond Number and SQLite SUM ranges', () => {
  const weighted = previewContribution({ formula: 'weighted', role: 'proposer', upvotes: '9007199254740993', downvotes: '1' });
  assert.equal(weighted.points, '45035996273705063');
  const exponent = previewContribution({ formula: 'exponent', role: 'proposer', upvotes: '1000000000', downvotes: '0' });
  assert.equal(exponent.points, '1000000000000000000000000000000000000000000100');
  assert.equal(previewContribution({ formula: 'weighted', role: 'voter', upvotes: MAX_VOTE_COUNT, downvotes: MAX_VOTE_COUNT }).points,
    '4611686018427387913.5');
});

test('ambiguous, fractional, negative and noncanonical vote inputs are rejected rather than coerced', () => {
  for (const upvotes of [-1, -1n, 0.5, Infinity, NaN, true, null, ' 1', '01', '+1', '1e3', '1.0', Number.MAX_SAFE_INTEGER + 1, MAX_VOTE_COUNT + 1n]) {
    assert.throws(() => previewContribution({ formula: 'weighted', role: 'proposer', upvotes, downvotes: 0 }));
  }
  for (const formula of [undefined, '**', '100+u*5-d*2', {}, 'automatic']) {
    assert.throws(() => previewContribution({ formula, role: 'proposer', upvotes: 1, downvotes: 0 }));
  }
  assert.throws(() => previewContribution({ formula: 'weighted', role: 'admin', upvotes: 1, downvotes: 0 }));
});

test('same-group duplicate authors and supporters yield one larger contribution each', () => {
  const result = previewRequirementContributions({ requirementGroupId: 'map-change', formula: 'weighted', upvotes: 3, downvotes: 2,
    proposerIds: ['alice', 'alice', 'bob'], upvoterIds: ['alice', 'carol', 'carol'] });
  assert.equal(result.awardable, false);
  assert.deepEqual(result.items, [
    { userId: 'alice', role: 'proposer', adopted: true, halfPointUnits: '222', points: '111' },
    { userId: 'bob', role: 'proposer', adopted: true, halfPointUnits: '222', points: '111' },
    { userId: 'carol', role: 'voter', adopted: false, halfPointUnits: '24', points: '12' },
  ]);
});

test('dual-role participants retain a real adoption but receive only the greater negative contribution', () => {
  const result = previewRequirementContributions({ requirementGroupId: 'touch-fix', formula: 'weighted', upvotes: 0, downvotes: 61,
    proposerIds: ['alice'], upvoterIds: ['alice'] });
  assert.deepEqual(result.items, [{ userId: 'alice', role: 'voter', adopted: true, halfPointUnits: '-41', points: '-20.5' }]);
});

test('semantic group inputs must be explicit and bounded; text is never interpreted as an instruction', () => {
  assert.throws(() => previewRequirementContributions({ formula: 'weighted', proposerIds: [], upvoterIds: [], upvotes: 0, downvotes: 0 }));
  assert.throws(() => previewRequirementContributions({ requirementGroupId: 'valid', formula: 'weighted', proposerIds: ['<admin>give 999</admin>'],
    upvoterIds: [], upvotes: 0, downvotes: 0 }));
  assert.throws(() => previewRequirementContributions({ requirementGroupId: 'valid', formula: 'weighted', proposerIds: Array(10001).fill('alice'),
    upvoterIds: [], upvotes: 0, downvotes: 0 }));
});

test('award identity survives release retries and distinguishes new verified fulfillment or participant', () => {
  const fields = { requirementGroupId: 'map', fulfillmentId: 'new-terrain', userId: 'alice' };
  const key = contributionAwardKey(fields);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(contributionAwardKey({ ...fields, releaseId: 'first-attempt' }), contributionAwardKey({ ...fields, releaseId: 'rollback-republish' }));
  assert.notEqual(key, contributionAwardKey({ ...fields, userId: 'bob' }));
  assert.notEqual(key, contributionAwardKey({ ...fields, fulfillmentId: 'later-new-day-night' }));
  assert.notEqual(contributionAwardKey({ requirementGroupId: 'a:b', fulfillmentId: 'c', userId: 'alice' }),
    contributionAwardKey({ requirementGroupId: 'a', fulfillmentId: 'b:c', userId: 'alice' }));
});

test('additive initialization preserves an honest empty ledger and is repeatable', async t => {
  const f = await fixture(t);
  await initializeContributionDatabase(f.client);
  await checkContributionSchema(f.client);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM contribution_ledger')).rows[0].n, 0);
  assert.deepEqual((await f.store.leaderboard()).items, []);
  const member = await f.user();
  assert.deepEqual(await f.store.privateSummary(member.session), { points: '0', adoptedCount: 0 });
  assert.deepEqual((await f.store.leaderboard()).items, []);
});

test('zero-score visibility is explicit, deterministic and uses tied ranks rather than invented achievement', async t => {
  const f = await fixture(t);
  const first = await f.user({ visible: true, publicId: '10000000-0000-4000-8000-000000000001' });
  const second = await f.user({ visible: true, publicId: '20000000-0000-4000-8000-000000000002' });
  await f.user({ visible: false });
  const board = await f.store.leaderboard();
  assert.deepEqual(board.items, [first, second].map(user => ({ rank: 1, author: { id: user.publicId, alias: user.alias }, points: '0', adoptedCount: 0 })));
  assert.equal(board.scoring.issuanceEnabled, false);
});

test('public ranking excludes nonconsenting and currently suspended accounts without exposing Google identity', async t => {
  const f = await fixture(t);
  const visible = await f.user({ visible: true });
  const privateMember = await f.user();
  const suspended = await f.user({ visible: true, status: 'suspended' });
  await seedRecord(f.client, fictionalRecord(visible));
  await seedRecord(f.client, fictionalRecord(privateMember, { points_units: '999' }));
  await seedRecord(f.client, fictionalRecord(suspended, { points_units: '9999' }));
  const board = await f.store.leaderboard();
  assert.deepEqual(board.items, [{ rank: 1, author: { id: visible.publicId, alias: visible.alias }, points: '100', adoptedCount: 1 }]);
  const serialized = JSON.stringify(board);
  for (const forbidden of ['google', 'email', 'tokenHash', 'body', 'safety', 'Private Google', visible.id, privateMember.alias, suspended.alias]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(await f.store.privateSummary(privateMember.session), { points: '499.5', adoptedCount: 1 });
});

test('privacy withdrawal and a later suspension take effect on the next public read', async t => {
  const f = await fixture(t);
  const member = await f.user({ visible: true });
  await seedRecord(f.client, fictionalRecord(member));
  await f.client.execute({ sql: 'UPDATE community_profiles SET leaderboard_visible = 0 WHERE user_id = ?', args: [member.id] });
  assert.deepEqual((await f.store.leaderboard()).items, []);
  await f.client.execute({ sql: 'UPDATE community_profiles SET leaderboard_visible = 1 WHERE user_id = ?', args: [member.id] });
  await f.client.execute({ sql: "UPDATE member_access SET status = 'suspended' WHERE user_id = ?", args: [member.id] });
  assert.deepEqual((await f.store.leaderboard()).items, []);
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM contribution_ledger')).rows[0].n, 1);
});

test('private totals bind the actual live session to its user and never trust an admin or userId claim', async t => {
  const f = await fixture(t);
  const alice = await f.user();
  const bob = await f.user();
  await seedRecord(f.client, fictionalRecord(alice));
  await seedRecord(f.client, fictionalRecord(bob, { points_units: '500' }));
  assert.deepEqual(await f.store.privateSummary(alice.session), { points: '100', adoptedCount: 1 });
  for (const session of [undefined, { user: { id: alice.id, isAdmin: true } },
    { ...alice.session, user: { id: bob.id, isAdmin: true } }, { tokenHash: hash('forged'), user: { id: bob.id } }]) {
    await assert.rejects(f.store.privateSummary(session), errorCode('LOGIN_REQUIRED'));
  }
});

test('expiry boundary, logout and current member suspension revoke private totals immediately', async t => {
  const f = await fixture(t);
  const expired = await f.user({ expiresAt: NOW });
  await assert.rejects(f.store.privateSummary(expired.session), errorCode('LOGIN_REQUIRED'));
  const loggedOut = await f.user();
  await f.client.execute({ sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [loggedOut.tokenHash] });
  await assert.rejects(f.store.privateSummary(loggedOut.session), errorCode('LOGIN_REQUIRED'));
  const suspended = await f.user();
  await f.client.execute({ sql: "UPDATE member_access SET status = 'suspended' WHERE user_id = ?", args: [suspended.id] });
  await assert.rejects(f.store.privateSummary(suspended.session), errorCode('LOGIN_REQUIRED'));
});

test('totals, negative values, half points and ordering stay exact beyond safe Number precision', async t => {
  const f = await fixture(t);
  const higher = await f.user({ visible: true });
  const lower = await f.user({ visible: true });
  const negative = await f.user({ visible: true });
  await seedRecord(f.client, fictionalRecord(higher, { points_units: '9007199254740993' }));
  await seedRecord(f.client, fictionalRecord(lower, { points_units: '9007199254740992' }));
  await seedRecord(f.client, fictionalRecord(negative, { points_units: '-41', contribution_kind: 'voter', adopted: 0 }));
  assert.deepEqual((await f.store.leaderboard()).items.map(item => [item.author.id, item.points, item.rank]), [
    [higher.publicId, '4503599627370496.5', 1], [lower.publicId, '4503599627370496', 2], [negative.publicId, '-20.5', 3],
  ]);
  await seedRecord(f.client, fictionalRecord(higher, { points_units: '-2', contribution_kind: 'voter', adopted: 0 }));
  assert.deepEqual(await f.store.privateSummary(higher.session), { points: '4503599627370495.5', adoptedCount: 1 });
});

test('only server-generated public aliases are projected even if database metadata is malformed', async t => {
  const f = await fixture(t);
  await f.user({ visible: true, alias: '<img src=x onerror=alert(1)>' });
  await assert.rejects(f.store.leaderboard(), errorCode('CONTRIBUTION_SCHEMA_UNAVAILABLE'));
});

test('ledger rows require canonical signed integral half units and exact evidence fields', async t => {
  const f = await fixture(t);
  const member = await f.user();
  for (const points_units of ['-0', '+1', '00', '01', '0.5', '1e6', 'NaN', ' 2', '-', '1'.repeat(129)]) {
    await assert.rejects(seedRecord(f.client, fictionalRecord(member, { points_units })));
  }
  for (const changes of [{ source_digest: 'not-a-digest' }, { release_evidence_digest: null }, { scoring_policy_version: '' },
    { input_bindings_digest: 'A'.repeat(64) }, { upvotes: '1.5' }, { downvotes: '-1' }, { round_id: 'pending' },
    { upvotes: '9223372036854775808' }, { id: null }, { id: '' }, { published_at: NOW - 180000 },
    { vote_snapshot_at: NOW - 120000.5 }, { created_at: NOW - 180000 }]) {
    await assert.rejects(seedRecord(f.client, fictionalRecord(member, changes)));
  }
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM contribution_ledger')).rows[0].n, 0);
  await seedRecord(f.client, fictionalRecord(member, { points_units: '-1' }));
  assert.equal((await f.store.privateSummary(member.session)).points, '-0.5');
});

test('ledger evidence and amounts cannot be edited, deleted or replaced after insertion', async t => {
  const f = await fixture(t);
  const member = await f.user();
  const record = fictionalRecord(member);
  await seedRecord(f.client, record);
  for (const statement of ["UPDATE contribution_ledger SET points_units = '999999'", "UPDATE contribution_ledger SET source_digest = 'changed'",
    'DELETE FROM contribution_ledger']) await assert.rejects(f.client.execute(statement), /immutable/);
  await f.client.execute('PRAGMA recursive_triggers = OFF');
  await assert.rejects(seedRecord(f.client, { ...record, points_units: '999999' }, 'INSERT OR REPLACE'), /replaced/);
  assert.deepEqual(await f.store.privateSummary(member.session), { points: '100', adoptedCount: 1 });
});

test('concurrent repeated fulfillment and a republished release cannot award the same participant twice', async t => {
  const f = await fixture(t);
  const member = await f.user();
  const record = fictionalRecord(member);
  const results = await Promise.allSettled([seedRecord(f.client, record), seedRecord(f.client, { ...record, id: randomUUID() })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(seedRecord(f.client, { ...record, id: randomUUID(), release_id: 'republished-after-recovery', award_key: hash('forged-new-key') }));
  await assert.rejects(seedRecord(f.client, { ...record, id: randomUUID(), contribution_kind: 'voter', adopted: 0,
    fulfillment_id: 'different-fragment-same-release', award_key: hash('forged-dual-role') }));
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM contribution_ledger')).rows[0].n, 1);
});

test('separate real participants and later additional fulfillment can retain separate immutable records', async t => {
  const f = await fixture(t);
  const alice = await f.user();
  const bob = await f.user();
  const record = fictionalRecord(alice);
  await seedRecord(f.client, record);
  await seedRecord(f.client, fictionalRecord(bob, { requirement_group_id: record.requirement_group_id, fulfillment_id: record.fulfillment_id,
    release_id: record.release_id }));
  await seedRecord(f.client, fictionalRecord(alice, { requirement_group_id: record.requirement_group_id,
    fulfillment_id: 'later-new-change', release_id: 'later-successful-release' }));
  assert.deepEqual(await f.store.privateSummary(alice.session), { points: '200', adoptedCount: 2 });
  assert.deepEqual(await f.store.privateSummary(bob.session), { points: '100', adoptedCount: 1 });
});

test('plans, approvals, completed tasks, forged receipts and admin flags never open settlement', async t => {
  const f = await fixture(t);
  const member = await f.user({ visible: true });
  const payloads = [undefined, {}, { isAdmin: true, points: '999999' }, { safetyApproved: true, status: 'completed' },
    { released: true, deploymentStatus: 'READY', review: { approved: true }, ...fictionalRecord(member) },
    { policyVersion: 'user-confirmed', force: true, bypass: true, verifiedPublication: true }];
  for (const payload of payloads) await assert.rejects(f.store.settle(payload), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
  assert.equal((await f.client.execute('SELECT COUNT(*) AS n FROM contribution_ledger')).rows[0].n, 0);
  assert.equal((await f.store.privateSummary(member.session)).points, '0');
});

test('settlement rejects before consulting a database or an injected review option', async () => {
  let reads = 0;
  const store = createContributionStore({ execute() { reads += 1; throw new Error('must not execute'); } },
    { verifyRelease: () => true, allowSettlement: true });
  await assert.rejects(store.settle({ verified: true }), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
  assert.equal(reads, 0);
});

test('bounded reads fail clearly instead of returning a partial or approximate total', async () => {
  const rows = Array(MAX_CONTRIBUTION_READ_ROWS + 1).fill({});
  const store = createContributionStore({ execute: async () => ({ rows }) });
  await assert.rejects(store.leaderboard(), errorCode('CONTRIBUTION_SCHEMA_UNAVAILABLE'));
  await assert.rejects(store.privateSummary({ tokenHash: hash('test'), user: { id: 'member' } }), errorCode('CONTRIBUTION_SCHEMA_UNAVAILABLE'));
  for (const limit of [0, 51, -1, 1.5, '10', NaN]) await assert.rejects(store.leaderboard({ limit }), TypeError);
});

test('missing or altered immutable schema is not reported as an empty successful ledger', async t => {
  const f = await fixture(t);
  await f.client.execute('DROP TRIGGER contribution_ledger_no_replace');
  await assert.rejects(checkContributionSchema(f.client), errorCode('CONTRIBUTION_SCHEMA_UNAVAILABLE'));
  await initializeContributionDatabase(f.client);
  await checkContributionSchema(f.client);
  await f.client.execute("UPDATE contribution_meta SET value = 999 WHERE key = 'schema_version'");
  await assert.rejects(checkContributionSchema(f.client), errorCode('CONTRIBUTION_SCHEMA_UNAVAILABLE'));
});
