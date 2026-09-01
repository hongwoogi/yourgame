import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { readContributionVotes, MAX_CONTRIBUTION_VOTE_ROWS } from '../server/contribution-votes.mjs';
import { backendFixture, errorCode, TEST_CLOCK_SQL } from './backend-helpers.mjs';

const HISTORY = 'CONTRIBUTION_VOTE_HISTORY_UNAVAILABLE';
const BINDING = 'CONTRIBUTION_INPUT_BINDING_MISMATCH';
const ROUND = 'CONTRIBUTION_ROUND_UNAVAILABLE';
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');

async function fixture(t) {
  const f = await backendFixture(t, { time: INITIAL_CUTOFF - 60000 });
  await f.client.execute({ sql: "UPDATE community_rounds SET opens_at = ? WHERE id = 'initial'", args: [INITIAL_CUTOFF - 3600000] });
  return {
    ...f,
    async idea(author) {
      author ??= await f.login(randomUUID());
      const { proposal } = await f.store.createProposal(author.session.user.id,
        { body: 'Synthetic fixture: add a visible fantasy puzzle.', requestId: randomUUID() });
      const entry = (await f.store.community.privateState(author.session)).publications.find(item => item.proposalId === proposal.id);
      const binding = (await f.client.execute({ sql: `SELECT proposal_id AS id, body_revision AS revision, body_hash AS bodyHash
        FROM proposal_body_revisions WHERE proposal_id = ? AND body_revision = ?`, args: [proposal.id, proposal.revision] })).rows[0];
      return { author, proposal, entry, binding: { ...binding, participantId: author.session.user.id } };
    },
    async vote(voter, idea, direction = 'up') {
      return f.store.community.mutate(voter.session, { action: 'vote', requestId: randomUUID(), publicId: idea.entry.publicId,
        proposalRevision: idea.entry.proposalRevision, publicationRevision: idea.entry.publicationRevision, roundId: 'initial', direction });
    },
    async visibility(idea, visible) {
      const result = await f.store.community.mutate(idea.author.session, { action: 'set_publication', requestId: randomUUID(),
        proposalId: idea.proposal.id, proposalRevision: idea.entry.proposalRevision,
        publicationRevision: idea.entry.publicationRevision, visible });
      idea.entry = (await f.store.community.privateState(idea.author.session)).publications.find(item => item.proposalId === idea.proposal.id);
      return result;
    },
    close() { return f.setTime(INITIAL_CUTOFF + 1000); },
    read(ideas, client = f.client, changes = {}) {
      return readContributionVotes(client, { roundId: 'initial', bindings: ideas.map(item => item.binding),
        databaseClockSql: TEST_CLOCK_SQL, ...changes });
    },
  };
}

async function moderator(f) {
  const anonymous = await f.store.createAnonymousSession();
  return f.store.completeLogin(anonymous.session, { googleSub: 'synthetic-contribution-moderator',
    name: 'Synthetic moderator', email: ADMIN_EMAIL, emailVerified: true });
}
const moderationInput = (item, changes = {}) => ({ action: 'moderate_proposal', requestId: randomUUID(),
  reason: 'Synthetic private moderation reason.', proposalId: item.proposal.id, moderation: 'reviewed', revision: 1, ...changes });

async function alterFixtureEvidence(f, table, operation, statement) {
  assert.ok(['admin_audit', 'admin_requests', 'community_events', 'community_requests'].includes(table));
  assert.ok(['update', 'delete'].includes(operation));
  const name = `${table}_no_${operation}`;
  const original = (await f.client.execute({ sql: 'SELECT sql FROM sqlite_master WHERE name=?', args: [name] })).rows[0].sql;
  await f.client.execute(`DROP TRIGGER ${name}`);
  try { await f.client.execute(statement); }
  finally { await f.client.execute(original); }
}

async function advanceVoteStatementClocks(f) {
  // These local SQLite triggers advance the trusted fixture clock after the
  // primary statement. The real writer then creates its event and receipt;
  // their contents/times are not hand-crafted for the test.
  await f.client.execute(`CREATE TRIGGER test_vote_insert_clock AFTER INSERT ON community_votes
    BEGIN UPDATE test_clock SET now_ms=now_ms+1 WHERE id=1; END`);
  await f.client.execute(`CREATE TRIGGER test_vote_update_clock AFTER UPDATE ON community_votes
    BEGIN UPDATE test_clock SET now_ms=now_ms+2 WHERE id=1; END`);
}

async function sequentialVoteFixture(t) {
  const f = await fixture(t);
  const item = await f.idea();
  const voter = await f.login('sequential-vote-writer');
  await advanceVoteStatementClocks(f);
  await f.vote(voter, item);
  const clock = (await f.client.execute('SELECT now_ms FROM test_clock WHERE id=1')).rows[0].now_ms;
  await f.setTime(clock + 1);
  await f.vote(voter, item, 'down');
  return { f, item, voter };
}

// Controlled corrupt/invalid rows are used only in local fixture databases.
// They let the reader prove that valid-looking counts do not replace receipts.
async function manualVote(f, voter, idea, { direction = 'up', receipt = true, invalidPayload = false, invalidResponse = false } = {}) {
  const source = (await f.client.execute({ sql: `SELECT cp.*, sr.id AS safety_review_id, sr.revision AS safety_revision,
      COALESCE(ma.revision, 1) AS author_control_revision, COALESCE(va.revision, 1) AS voter_control_revision,
      COALESCE(pm.revision, 1) AS moderation_revision
    FROM community_publications cp JOIN proposals p ON p.id = cp.proposal_id
    JOIN proposal_safety_reviews sr ON sr.proposal_id = p.id AND sr.body_revision = p.revision
    LEFT JOIN member_access ma ON ma.user_id = p.user_id LEFT JOIN member_access va ON va.user_id = ?
    LEFT JOIN proposal_moderation pm ON pm.proposal_id = p.id WHERE cp.public_id = ?`,
  args: [voter.session.user.id, idea.entry.publicId] })).rows[0];
  const details = { roundId: 'initial', direction, proposalRevision: source.proposal_revision, publicationRevision: source.revision,
    bodyHash: source.body_hash, policyVersion: source.policy_version, safetyReviewId: source.safety_review_id,
    safetyRevision: source.safety_revision, authorControlRevision: source.author_control_revision,
    voterControlRevision: source.voter_control_revision, moderationRevision: source.moderation_revision, revision: 1 };
  const requestId = randomUUID();
  const input = { action: 'vote', requestId, publicId: source.public_id, proposalRevision: source.proposal_revision,
    publicationRevision: source.revision, roundId: 'initial', direction };
  const payloadHash = invalidPayload ? hash('synthetic mismatching receipt') : hash(input);
  await f.client.execute({ sql: `INSERT INTO community_votes(user_id, round_id, public_id, direction,
      proposal_revision, publication_revision, body_hash, policy_version, safety_review_id, safety_revision,
      author_control_revision, voter_control_revision, moderation_revision, revision, created_at, updated_at)
    VALUES (?, 'initial', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  args: [voter.session.user.id, source.public_id, direction, source.proposal_revision, source.revision, source.body_hash,
    source.policy_version, source.safety_review_id, source.safety_revision, source.author_control_revision,
    source.voter_control_revision, source.moderation_revision, f.now(), f.now()] });
  await f.client.execute({ sql: `INSERT INTO community_events(id, actor_user_id, action, target_id, details_json, payload_hash, created_at)
    VALUES (?, ?, 'vote', ?, ?, ?, ?)`, args: [randomUUID(), voter.session.user.id, source.public_id, JSON.stringify(details), payloadHash, f.now()] });
  if (receipt) await f.client.execute({ sql: `INSERT INTO community_requests(user_id, request_id, payload_hash, response_json, created_at)
    VALUES (?, ?, ?, ?, ?)`, args: [voter.session.user.id, requestId, payloadHash,
    JSON.stringify({ ok: true, targetId: invalidResponse ? 'another-publication' : source.public_id }), f.now()] });
}

test('closed cutoff capture returns exact sorted private recipients, deterministically without reading bodies or writing', async t => {
  const f = await fixture(t);
  const first = await f.idea();
  const second = await f.idea();
  const supporter = await f.login('supporter');
  const other = await f.login('other-voter');
  await f.vote(supporter, first);
  await f.vote(supporter, second);
  await f.vote(other, first, 'down');
  await f.close();
  const before = (await f.client.execute('SELECT total_changes() AS n')).rows[0].n;
  const statements = [];
  const readonly = { execute(input) {
    assert.match(input.sql, /^WITH /);
    assert.doesNotMatch(input.sql, /\bp\.\*|\bp\.body\b|\bh\.body\b|google_sub|csrf_token|token_hash|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
    statements.push(input);
    return f.client.execute(input);
  } };
  const result = await f.read([second, first], readonly);
  const repeated = await f.read([first, second]);
  assert.deepEqual(result, repeated);
  assert.equal(statements.length, 1);
  assert.equal((await f.client.execute('SELECT total_changes() AS n')).rows[0].n, before);
  assert.deepEqual(Object.keys(result).sort(), ['cutoff', 'proposals', 'roundId', 'snapshotDigest']);
  assert.equal(result.cutoff, INITIAL_CUTOFF);
  assert.match(result.snapshotDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.proposals.find(row => row.proposalId === first.proposal.id), {
    proposalId: first.proposal.id, authorId: first.author.session.user.id,
    upvoterIds: [supporter.session.user.id], downvoterIds: [other.session.user.id],
  });
  assert.deepEqual(result.proposals.find(row => row.proposalId === second.proposal.id).upvoterIds, [supporter.session.user.id]);
  assert.doesNotMatch(JSON.stringify(result), /Synthetic fixture|Player-|google|bodyHash|safetyReview/i);
});

test('real closed round with zero votes and a transaction exposing only execute is supported', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  await f.close();
  const tx = await f.client.transaction('read');
  try {
    const result = await f.read([item], { execute: tx.execute.bind(tx) });
    assert.deepEqual(result.proposals[0], { proposalId: item.proposal.id, authorId: item.author.session.user.id,
      upvoterIds: [], downvoterIds: [] });
  } finally { await tx.rollback(); }
});

test('pending development input resolves to its exact dated daily voting round', async t => {
  const f = await backendFixture(t, { time: INITIAL_CUTOFF + 1 });
  const author = await f.login('daily-contribution-author');
  const voter = await f.login('daily-contribution-voter');
  const { proposal } = await f.store.createProposal(author.session.user.id,
    { body: 'Synthetic daily contribution fixture.', requestId: randomUUID() });
  const entry = (await f.store.community.privateState(author.session)).publications
    .find(item => item.proposalId === proposal.id);
  await f.store.community.mutate(voter.session, { action: 'vote', requestId: randomUUID(),
    publicId: entry.publicId, proposalRevision: entry.proposalRevision,
    publicationRevision: entry.publicationRevision, roundId: 'daily-2026-09-01', direction: 'up' });
  const binding = (await f.client.execute({ sql: `SELECT proposal_id AS id,body_revision AS revision,body_hash AS bodyHash
    FROM proposal_body_revisions WHERE proposal_id=? AND body_revision=?`, args: [proposal.id, proposal.revision] })).rows[0];
  await f.setTime(INITIAL_CUTOFF + 24 * 60 * 60 * 1000 + 1);
  const result = await readContributionVotes(f.client, { roundId: 'daily-2026-09-01',
    bindings: [{ ...binding, participantId: author.session.user.id }], databaseClockSql: TEST_CLOCK_SQL });
  assert.equal(result.roundId, 'daily-2026-09-01');
  assert.deepEqual(result.proposals, [{ proposalId: proposal.id, authorId: author.session.user.id,
    upvoterIds: [voter.session.user.id], downvoterIds: [] }]);
});

test('cancelled choices retain their exact history and release the active budget before cutoff', async t => {
  const f = await fixture(t);
  const items = [];
  for (let index = 0; index < 4; index++) items.push(await f.idea());
  const voter = await f.login('budget-voter');
  await f.vote(voter, items[0]);
  await f.vote(voter, items[0], 'none');
  for (const item of items.slice(1)) await f.vote(voter, item);
  await f.close();
  const result = await f.read(items);
  assert.deepEqual(result.proposals.find(row => row.proposalId === items[0].proposal.id).upvoterIds, []);
  assert.equal(result.proposals.reduce((sum, row) => sum + row.upvoterIds.length, 0), 3);
});

test('direction changes select the final receipted revision, never an earlier support vote', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  const voter = await f.login('switch-voter');
  await f.vote(voter, item);
  await f.setTime(f.now() + 1);
  await f.vote(voter, item, 'down');
  await f.close();
  const result = await f.read([item]);
  assert.deepEqual(result.proposals[0].upvoterIds, []);
  assert.deepEqual(result.proposals[0].downvoterIds, [voter.session.user.id]);
});

test('real vote primary/event statements may advance by 1ms or 2ms while preserving the exact receipt chain', async t => {
  const { f, item, voter } = await sequentialVoteFixture(t);
  const vote = (await f.client.execute('SELECT created_at,updated_at FROM community_votes')).rows[0];
  const events = (await f.client.execute("SELECT created_at FROM community_events WHERE action='vote' ORDER BY rowid")).rows;
  const receipts = (await f.client.execute('SELECT created_at FROM community_requests ORDER BY created_at')).rows;
  assert.equal(events[0].created_at, vote.created_at + 1);
  assert.equal(events[1].created_at, vote.updated_at + 2);
  assert.ok(events[0].created_at <= vote.updated_at);
  assert.deepEqual(receipts.map(row => row.created_at), events.map(row => row.created_at));
  await f.close();
  const snapshot = await f.read([item]);
  assert.deepEqual(snapshot.proposals[0].upvoterIds, []);
  assert.deepEqual(snapshot.proposals[0].downvoterIds, [voter.session.user.id]);
});

test('sequential vote proof rejects reverse order, a missing revision and a mismatched receipt', async t => {
  for (const change of ['creation-after-first-event', 'update-after-last-event', 'prior-event-after-update', 'missing-event', 'receipt-time']) {
    await t.test(change, async t => {
      const { f, item } = await sequentialVoteFixture(t);
      const events = (await f.client.execute("SELECT id,created_at FROM community_events WHERE action='vote' ORDER BY rowid")).rows;
      await f.close();
      if (change === 'creation-after-first-event') await f.client.execute({
        sql: 'UPDATE community_votes SET created_at=?', args: [events[0].created_at + 1] });
      if (change === 'update-after-last-event') await f.client.execute({
        sql: 'UPDATE community_votes SET updated_at=?', args: [events[1].created_at + 1] });
      if (change === 'prior-event-after-update') await f.client.execute({
        sql: 'UPDATE community_votes SET updated_at=?', args: [events[0].created_at - 1] });
      if (change === 'missing-event') await alterFixtureEvidence(f, 'community_events', 'delete', {
        sql: 'DELETE FROM community_events WHERE id=?', args: [events[0].id] });
      if (change === 'receipt-time') await alterFixtureEvidence(f, 'community_requests', 'update', {
        sql: 'UPDATE community_requests SET created_at=created_at+1 WHERE created_at=?', args: [events[1].created_at] });
      await assert.rejects(f.read([item]), errorCode(HISTORY));
    });
  }
});

test('a successful primary vote before cutoff with its event at cutoff remains unavailable for historical settlement', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  const voter = await f.login('cutoff-edge-voter');
  await advanceVoteStatementClocks(f);
  await f.setTime(INITIAL_CUTOFF - 1);
  await f.vote(voter, item);
  assert.equal((await f.client.execute('SELECT updated_at FROM community_votes')).rows[0].updated_at, INITIAL_CUTOFF - 1);
  assert.equal((await f.client.execute("SELECT created_at FROM community_events WHERE action='vote'")).rows[0].created_at, INITIAL_CUTOFF);
  await f.close();
  await assert.rejects(f.read([item]), errorCode(HISTORY));
});

test('known invalid self votes and superseded public revisions are excluded', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  const voter = await f.login('revision-voter');
  await f.vote(voter, item);
  await f.visibility(item, false);
  await f.visibility(item, true);
  await manualVote(f, item.author, item);
  await f.close();
  const result = await f.read([item]);
  assert.deepEqual(result.proposals[0].upvoterIds, []);
  assert.deepEqual(result.proposals[0].downvoterIds, []);
});

test('current vote mismatching immutable evidence, missing receipts and forged payload hashes fail closed', async t => {
  for (const mode of ['current-row', 'missing-receipt', 'payload', 'response']) await t.test(mode, async t => {
    const f = await fixture(t);
    const item = await f.idea();
    const voter = await f.login('evidence-voter');
    if (mode === 'current-row') {
      await f.vote(voter, item);
      await f.client.execute("UPDATE community_votes SET direction = 'down'");
    } else await manualVote(f, voter, item, { receipt: mode !== 'missing-receipt', invalidPayload: mode === 'payload', invalidResponse: mode === 'response' });
    await f.close();
    await assert.rejects(f.read([item]), errorCode(HISTORY));
  });
});

test('exact input body hash, revision, author and unique proposal identity are required', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  await f.close();
  for (const changes of [{ bodyHash: 'a'.repeat(64) }, { revision: item.binding.revision + 1 }, { participantId: 'another-person' }, { id: 'absent-proposal' }]) {
    await assert.rejects(f.read([item], f.client, { bindings: [{ ...item.binding, ...changes }] }), errorCode(BINDING));
  }
  await assert.rejects(f.read([item, item]), errorCode(BINDING));
});

test('missing, still-open and malformed rounds do not produce an apparent cutoff snapshot', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  await assert.rejects(f.read([item]), errorCode(ROUND));
  await f.close();
  await assert.rejects(f.read([item], f.client, { roundId: 'not-a-real-round' }), errorCode(ROUND));
  await assert.rejects(f.read([item], f.client, { roundId: 'initial;bad' }), errorCode(ROUND));
  await f.client.execute("UPDATE community_rounds SET closes_at = 'unknown' WHERE id = 'initial'");
  await assert.rejects(f.read([item]), errorCode(ROUND));
});

test('post-cutoff publication, visibility, member, moderation and body changes cannot be called historical eligibility', async t => {
  for (const change of ['publication', 'visibility', 'author', 'voter', 'moderation', 'body']) await t.test(change, async t => {
    const f = await fixture(t);
    const item = await f.idea();
    const voter = await f.login('history-voter');
    await f.vote(voter, item);
    await f.close();
    if (change === 'visibility') await f.visibility(item, false);
    if (change === 'publication') await f.client.execute({ sql: 'UPDATE community_publications SET updated_at = ? WHERE proposal_id = ?', args: [f.now(), item.proposal.id] });
    if (change === 'author' || change === 'voter') await f.client.execute({ sql: 'UPDATE member_access SET revision = revision + 1, updated_at = ? WHERE user_id = ?',
      args: [f.now(), (change === 'author' ? item.author : voter).session.user.id] });
    if (change === 'moderation') await f.client.execute({ sql: `INSERT INTO proposal_moderation(proposal_id, moderation, reason, revision, updated_at)
      VALUES (?, 'reviewed', 'Synthetic fixture control change', 2, ?)`, args: [item.proposal.id, f.now()] });
    if (change === 'body') await f.client.execute({ sql: 'UPDATE proposals SET updated_at = ? WHERE id = ?', args: [f.now(), item.proposal.id] });
    await assert.rejects(f.read([item]), errorCode(HISTORY));
  });
});

test('one fully receipted first moderation after cutoff proves the prior pending revision without changing current controls', async t => {
  for (const moderation of ['reviewed', 'pending', 'excluded']) await t.test(moderation, async t => {
    const f = await fixture(t);
    const item = await f.idea();
    const voter = await f.login('moderation-history-voter');
    const admin = await moderator(f);
    await f.vote(voter, item);
    await f.close();
    const before = await f.read([item]);
    await f.store.admin.mutate(admin.session, moderationInput(item, { moderation }));
    const stored = (await f.client.execute({ sql: 'SELECT moderation,revision,updated_at FROM proposal_moderation WHERE proposal_id=?',
      args: [item.proposal.id] })).rows[0];
    assert.equal(stored.moderation, moderation);
    assert.equal(stored.revision, 2);
    const changes = (await f.client.execute('SELECT total_changes() AS n')).rows[0].n;
    const snapshot = await f.read([item]);
    assert.deepEqual(snapshot.proposals, before.proposals);
    assert.deepEqual(snapshot.proposals[0].upvoterIds, [voter.session.user.id]);
    assert.deepEqual(await f.read([item]), snapshot);
    assert.notEqual(snapshot.snapshotDigest, before.snapshotDigest); // proof now includes the exact administrative receipt
    assert.equal((await f.client.execute('SELECT total_changes() AS n')).rows[0].n, changes);
    assert.deepEqual((await f.client.execute({ sql: 'SELECT moderation,revision,updated_at FROM proposal_moderation WHERE proposal_id=?',
      args: [item.proposal.id] })).rows[0], stored);
    assert.doesNotMatch(JSON.stringify(snapshot), /Synthetic private|moderation reason|actorId|requestId/);
  });
});

test('moderation primary and audit clocks may advance sequentially without a guessed time tolerance', async t => {
  for (const advance of [1, 60001]) await t.test(String(advance), async t => {
    const f = await fixture(t);
    const item = await f.idea();
    const voter = await f.login('sequential-moderation-voter');
    const admin = await moderator(f);
    await f.vote(voter, item);
    await f.close();
    await f.client.execute(`CREATE TRIGGER test_moderation_clock AFTER INSERT ON proposal_moderation
      BEGIN UPDATE test_clock SET now_ms=now_ms+${advance} WHERE id=1; END`);
    const input = moderationInput(item);
    await f.store.admin.mutate(admin.session, input);
    const primaryAt = (await f.client.execute('SELECT updated_at FROM proposal_moderation')).rows[0].updated_at;
    const auditAt = (await f.client.execute("SELECT created_at FROM admin_audit WHERE action='moderate_proposal'")).rows[0].created_at;
    const receiptAt = (await f.client.execute({ sql: 'SELECT created_at FROM admin_requests WHERE request_id=?', args: [input.requestId] })).rows[0].created_at;
    assert.equal(auditAt, primaryAt + advance);
    assert.equal(receiptAt, auditAt);
    assert.deepEqual((await f.read([item])).proposals[0].upvoterIds, [voter.session.user.id]);
  });
});

test('moderation clock ordering rejects reversed or future audits and keeps receipt time exact', async t => {
  for (const change of ['reverse-order', 'future-audit', 'receipt-time']) await t.test(change, async t => {
    const f = await fixture(t);
    const item = await f.idea();
    const admin = await moderator(f);
    await f.close();
    await f.client.execute(`CREATE TRIGGER test_moderation_clock AFTER INSERT ON proposal_moderation
      BEGIN UPDATE test_clock SET now_ms=now_ms+1 WHERE id=1; END`);
    const input = moderationInput(item);
    await f.store.admin.mutate(admin.session, input);
    const auditAt = (await f.client.execute("SELECT created_at FROM admin_audit WHERE action='moderate_proposal'")).rows[0].created_at;
    if (change === 'reverse-order') {
      await f.setTime(auditAt + 10);
      await f.client.execute({ sql: 'UPDATE proposal_moderation SET updated_at=?', args: [auditAt + 1] });
    } else if (change === 'future-audit') {
      await alterFixtureEvidence(f, 'admin_audit', 'update', {
        sql: "UPDATE admin_audit SET created_at=created_at+1 WHERE action='moderate_proposal'" });
      await alterFixtureEvidence(f, 'admin_requests', 'update', {
        sql: 'UPDATE admin_requests SET created_at=created_at+1 WHERE request_id=?', args: [input.requestId] });
    } else {
      await f.setTime(auditAt + 10);
      await alterFixtureEvidence(f, 'admin_requests', 'update', {
        sql: 'UPDATE admin_requests SET created_at=created_at+1 WHERE request_id=?', args: [input.requestId] });
    }
    await assert.rejects(f.read([item]), errorCode(HISTORY));
  });
});

test('first moderation reconstruction rejects missing, tampered or misbound administrative evidence', async t => {
  for (const change of ['missing-receipt', 'payload', 'actor', 'time', 'target', 'missing-audit', 'reason']) await t.test(change, async t => {
    const f = await fixture(t);
    const item = await f.idea();
    const voter = await f.login('receipt-history-voter');
    const admin = await moderator(f);
    await f.vote(voter, item);
    await f.close();
    const input = moderationInput(item);
    await f.store.admin.mutate(admin.session, input);
    if (change === 'missing-receipt') await alterFixtureEvidence(f, 'admin_requests', 'delete', {
      sql: 'DELETE FROM admin_requests WHERE request_id=?', args: [input.requestId] });
    if (change === 'payload') await alterFixtureEvidence(f, 'admin_requests', 'update', {
      sql: 'UPDATE admin_requests SET payload_hash=? WHERE request_id=?', args: ['0'.repeat(64), input.requestId] });
    if (change === 'actor') await alterFixtureEvidence(f, 'admin_requests', 'update', {
      sql: 'UPDATE admin_requests SET actor_user_id=? WHERE request_id=?', args: [voter.session.user.id, input.requestId] });
    if (change === 'time') await alterFixtureEvidence(f, 'admin_requests', 'update', {
      sql: 'UPDATE admin_requests SET created_at=created_at+1 WHERE request_id=?', args: [input.requestId] });
    if (change === 'target') await alterFixtureEvidence(f, 'admin_requests', 'update', {
      sql: 'UPDATE admin_requests SET response_json=? WHERE request_id=?',
      args: [JSON.stringify({ ok: true, targetId: 'another-proposal' }), input.requestId] });
    if (change === 'missing-audit') await alterFixtureEvidence(f, 'admin_audit', 'delete', {
      sql: "DELETE FROM admin_audit WHERE action='moderate_proposal' AND target_id=?", args: [item.proposal.id] });
    if (change === 'reason') await f.client.execute({ sql: 'UPDATE proposal_moderation SET reason=? WHERE proposal_id=?',
      args: ['A different synthetic reason.', item.proposal.id] });
    await assert.rejects(f.read([item]), errorCode(HISTORY));
  });
});

test('trimmed reasons whose original request hash cannot be proven are not guessed', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  const admin = await moderator(f);
  await f.close();
  await f.store.admin.mutate(admin.session, moderationInput(item, { reason: '  Synthetic original whitespace.  ' }));
  await assert.rejects(f.read([item]), errorCode(HISTORY));
});

test('multiple moderation transitions cannot be reconstructed from the latest row', async t => {
  for (const firstAfterCutoff of [false, true]) await t.test(String(firstAfterCutoff), async t => {
    const f = await fixture(t);
    const item = await f.idea();
    const admin = await moderator(f);
    if (firstAfterCutoff) await f.close();
    await f.store.admin.mutate(admin.session, moderationInput(item));
    await f.close();
    await f.setTime(f.now() + 1);
    await f.store.admin.mutate(admin.session, moderationInput(item, { moderation: 'pending', revision: 2 }));
    assert.equal((await f.client.execute('SELECT revision FROM proposal_moderation')).rows[0].revision, 3);
    await assert.rejects(f.read([item]), errorCode(HISTORY));
  });
});

test('administrative history guards remain mandatory for the narrow reconstruction', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  const admin = await moderator(f);
  await f.close();
  await f.store.admin.mutate(admin.session, moderationInput(item));
  await f.client.execute('DROP TRIGGER admin_audit_no_update');
  await assert.rejects(f.read([item]), errorCode(HISTORY));
});

test('safety-only review changes after cutoff and a later login do not alter the vote snapshot', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  const voter = await f.login('unchanged-supporter');
  await f.vote(voter, item);
  await f.close();
  const before = await f.read([item]);
  await f.client.execute({ sql: `UPDATE proposal_safety_reviews SET status = 'held', revision = revision + 1,
    reviewed_at = ? WHERE proposal_id = ?`, args: [f.now(), item.proposal.id] });
  await f.login('unchanged-supporter');
  assert.deepEqual(await f.read([item]), before);
});

test('a vote at the exact cutoff has no valid historical receipt for this reader', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  const voter = await f.login('late-voter');
  await f.setTime(INITIAL_CUTOFF);
  await manualVote(f, voter, item);
  await assert.rejects(f.read([item]), errorCode(HISTORY));
});

test('changed pre-cutoff member controls invalidate old votes without guessing past eligibility', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  const voter = await f.login('prior-revision-voter');
  await f.vote(voter, item);
  await f.setTime(f.now() + 1);
  await f.client.execute({ sql: 'UPDATE member_access SET revision = revision + 1, updated_at = ? WHERE user_id = ?',
    args: [f.now(), voter.session.user.id] });
  await f.close();
  assert.deepEqual((await f.read([item])).proposals[0].upvoterIds, []);
});

test('duplicate returned voter identities fail instead of adding points twice', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  await f.vote(await f.login('duplicate-voter'), item);
  await f.close();
  const duplicated = { async execute(statement) {
    const result = await f.client.execute(statement);
    return { rows: [...result.rows, result.rows.find(row => row.kind === 'vote')] };
  } };
  await assert.rejects(f.read([item], duplicated), errorCode(HISTORY));
});

test('the three-vote round budget includes other proposals outside the approved input subset', async t => {
  const f = await fixture(t);
  const items = [];
  for (let index = 0; index < 4; index++) items.push(await f.idea());
  const voter = await f.login('over-budget-voter');
  for (const item of items.slice(0, 3)) await f.vote(voter, item);
  await f.client.execute('DROP TRIGGER community_default_vote_insert_cap');
  await manualVote(f, voter, items[3]);
  await f.close();
  await assert.rejects(f.read([items[0]]), errorCode(HISTORY));
});

test('missing immutable receipt protection and exceeded read bounds fail explicitly', async t => {
  const f = await fixture(t);
  const item = await f.idea();
  await f.close();
  await assert.rejects(f.read([item], { execute: async () => ({ rows: Array(MAX_CONTRIBUTION_VOTE_ROWS + 1).fill({}) }) }), errorCode(HISTORY));
  await f.client.execute('DROP TRIGGER community_requests_no_update');
  await assert.rejects(f.read([item]), errorCode(HISTORY));
});
