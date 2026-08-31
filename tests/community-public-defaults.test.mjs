import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { initializeDatabase } from '../server/database.mjs';
import { createStore, hashValue } from '../server/store.mjs';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { ADMIN_EMAIL } from '../server/admin-policy.mjs';
import { initializeCommunityDatabase, activateCommunityPublicDefaults } from '../server/community-schema.mjs';
import { PUBLICATION_POLICY_VERSION } from '../server/community-policy.mjs';
import { pendingSafetyStatements } from '../server/safety-store.mjs';
import { SAFETY_POLICY_VERSION } from '../server/safety-policy.mjs';
import { backendFixture, request, signedHeaders, errorCode, TEST_CLOCK_SQL } from './backend-helpers.mjs';

const op = (action, extra = {}) => ({ action, requestId: randomUUID(), ...extra });
const activate = f => activateCommunityPublicDefaults(f.client, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL });

// These are the old deployed SQL write shapes, with synthetic identities. They
// intentionally do not know about the new policy/default tables or triggers.
async function legacyProposal(f, member, body, original) {
  const id = original?.id || randomUUID();
  const mutation = original ? {
    sql: `UPDATE proposals SET body = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?`,
    args: [body, f.now(), id, original.revision],
  } : {
    sql: `INSERT INTO proposals(id, user_id, request_id, request_body_hash, body, created_at, updated_at, round_id, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'initial', 1)`,
    args: [id, member.session.user.id, randomUUID(), hashValue(body), body, f.now(), f.now()],
  };
  await f.client.batch([mutation, ...pendingSafetyStatements({ proposalId: id, body, databaseClockSql: TEST_CLOCK_SQL })], 'write');
  return { id, body, revision: original ? original.revision + 1 : 1 };
}

async function legacyProfile(f, member) {
  await f.client.execute({
    sql: `INSERT INTO community_profiles(user_id, public_id, alias, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING`,
    args: [member.session.user.id, randomUUID(), `Player-${randomBytes(6).toString('hex')}`, f.now(), f.now()],
  });
}

async function legacyChoice(f, member, proposal, visible) {
  await legacyProfile(f, member);
  const eventId = randomUUID();
  const requestId = randomUUID();
  const action = proposal ? 'set_publication' : 'set_profile_visibility';
  const mutation = proposal ? {
    sql: `INSERT INTO community_publications(proposal_id, public_id, proposal_revision, body_hash, policy_version,
        requested, author_control_revision, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
      ON CONFLICT(proposal_id) DO UPDATE SET proposal_revision = excluded.proposal_revision, body_hash = excluded.body_hash,
        policy_version = excluded.policy_version, requested = excluded.requested, revision = revision + 1, updated_at = excluded.updated_at`,
    args: [proposal.id, randomUUID(), proposal.revision, hashValue(proposal.body), SAFETY_POLICY_VERSION, Number(visible), f.now(), f.now()],
  } : {
    sql: 'UPDATE community_profiles SET leaderboard_visible = ?, revision = revision + 1, updated_at = ? WHERE user_id = ?',
    args: [Number(visible), f.now(), member.session.user.id],
  };
  const event = proposal ? {
    sql: `INSERT INTO community_events(id, actor_user_id, action, target_id, details_json, payload_hash, created_at)
      SELECT ?, ?, ?, public_id, json_object('proposalId', proposal_id, 'requested', requested), ?, ? FROM community_publications WHERE proposal_id = ?`,
    args: [eventId, member.session.user.id, action, hashValue(requestId), f.now(), proposal.id],
  } : {
    sql: `INSERT INTO community_events(id, actor_user_id, action, target_id, details_json, payload_hash, created_at)
      SELECT ?, ?, ?, public_id, json_object('leaderboardVisible', leaderboard_visible), ?, ? FROM community_profiles WHERE user_id = ?`,
    args: [eventId, member.session.user.id, action, hashValue(requestId), f.now(), member.session.user.id],
  };
  await f.client.batch([mutation, event, {
    sql: `INSERT INTO community_requests(user_id, request_id, payload_hash, response_json, created_at)
      SELECT actor_user_id, ?, payload_hash, json_object('ok', json('true'), 'targetId', target_id), created_at FROM community_events WHERE id = ?`,
    args: [requestId, eventId],
  }], 'write');
}

const PRESERVED = ['users', 'proposals', 'proposal_body_revisions', 'proposal_safety_reviews', 'contribution_ledger',
  'service_control', 'member_access', 'admin_identity', 'admin_audit', 'community_events', 'community_requests', 'community_votes'];
async function rows(client, table) {
  assert.ok([...PRESERVED, 'community_profiles', 'community_publications', 'community_public_policy', 'community_visibility_choices',
    'community_profile_defaults', 'community_publication_defaults', 'community_default_events', 'community_policy_transitions'].includes(table));
  return (await client.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows;
}
async function snapshot(f, tables = PRESERVED) {
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, await rows(f.client, table)])));
}
async function publish(f, member, body) {
  return (await f.store.createProposal(member.session.user.id, { body, requestId: randomUUID() })).proposal;
}
const vote = idea => op('vote', { publicId: idea.id, proposalRevision: idea.proposalRevision,
  publicationRevision: idea.publicationRevision, roundId: idea.roundId, direction: 'up' });

test('preparation remains inactive and legacy original/history/health schema survive until explicit activation', async t => {
  const f = await backendFixture(t, { publicDefaults: false });
  const member = await f.login();
  const proposal = await legacyProposal(f, member, 'Unselected original');
  await legacyProfile(f, member); // old default=0 is not an explicit privacy choice
  const before = await snapshot(f);
  await initializeCommunityDatabase(f.client);
  await initializeCommunityDatabase(f.client);
  assert.deepEqual(await snapshot(f), before);
  assert.equal((await rows(f.client, 'community_public_policy'))[0].state, 'inactive');
  assert.equal((await rows(f.client, 'community_publications')).length, 0);
  assert.equal((await rows(f.client, 'community_profiles'))[0].leaderboard_visible, 0);
  // The previous release checks these values and eight pre-existing trigger names.
  for (const table of ['schema_meta', 'admin_meta', 'safety_meta', 'community_meta', 'contribution_meta']) {
    assert.equal(Number((await f.client.execute(`SELECT value FROM ${table} WHERE key = 'schema_version'`)).rows[0].value), 1);
  }
  assert.equal((await f.client.execute(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (
    'community_profile_identity_immutable','community_publication_identity_immutable','community_events_no_update',
    'community_events_no_delete','community_events_no_replace','community_requests_no_update','community_requests_no_delete','community_requests_no_replace')`)).rows[0].n, 8);
  await activate(f);
  assert.deepEqual(await snapshot(f), before);
  assert.equal((await f.store.community.publicFeed()).recent[0].body, proposal.body);
  assert.equal((await f.store.community.privateState(member.session)).profile.leaderboardVisible, true);
});

test('activation reconciles current explicit hide/show choices without fabricating consent or changing protected records', async t => {
  const f = await backendFixture(t, { publicDefaults: false });
  const unselected = await f.login('unselected');
  const hidden = await f.login('explicit-hidden');
  const reshown = await f.login('explicit-reshown');
  const first = await legacyProposal(f, unselected, 'Public by the new service policy');
  let second = await legacyProposal(f, hidden, 'A hidden original');
  const third = await legacyProposal(f, reshown, 'Explicitly reshown original');
  await legacyProfile(f, unselected);
  // All timestamps deliberately tie; database event order is authoritative.
  await legacyChoice(f, hidden, second, false);
  await legacyChoice(f, hidden, null, false);
  await legacyChoice(f, reshown, third, false);
  await legacyChoice(f, reshown, third, true);
  await legacyChoice(f, reshown, null, false);
  await legacyChoice(f, reshown, null, true);
  second = await legacyProposal(f, hidden, 'Hidden choice survives a legacy edit', second);
  // Simulate installing after historical events: activation reconstructs them.
  await f.client.execute('DELETE FROM community_visibility_choices');
  const protectedBefore = await snapshot(f);
  const identities = (await rows(f.client, 'community_profiles')).map(row => [row.user_id, row.public_id, row.alias, row.created_at]);
  const result = await activate(f);
  assert.equal(result.active, true);
  assert.equal(result.publicationsAdded, 1);
  assert.deepEqual(await snapshot(f), protectedBefore);
  assert.deepEqual((await rows(f.client, 'community_profiles')).map(row => [row.user_id, row.public_id, row.alias, row.created_at]), identities);
  const feed = await f.store.community.publicFeed();
  assert.deepEqual(feed.recent.map(item => item.body).sort(), [first.body, third.body].sort());
  const hiddenState = await f.store.community.privateState(hidden.session);
  assert.equal(hiddenState.profile.leaderboardVisible, false);
  assert.equal(hiddenState.profile.visibilitySource, 'author_choice');
  assert.equal(hiddenState.publications[0].proposalRevision, 2);
  assert.equal(hiddenState.publications[0].requested, false);
  assert.equal(hiddenState.publications[0].eligible, false);
  assert.equal(hiddenState.publications[0].visibilitySource, 'author_choice');
  const firstState = await f.store.community.privateState(unselected.session);
  assert.equal(firstState.profile.leaderboardVisible, true);
  assert.equal(firstState.publications[0].visibilitySource, 'service_default');
  assert.equal((await f.client.execute({ sql: 'SELECT requested FROM community_publications WHERE proposal_id = ?', args: [first.id] })).rows[0].requested, 0);
  const allTables = [...PRESERVED, 'community_profiles', 'community_publications', 'community_public_policy', 'community_visibility_choices',
    'community_profile_defaults', 'community_publication_defaults', 'community_default_events', 'community_policy_transitions'];
  const once = await snapshot(f, allTables);
  await f.setTime(f.now() + 1000);
  await initializeDatabase(f.client);
  const again = await activate(f);
  assert.deepEqual(again, { policyVersion: PUBLICATION_POLICY_VERSION, active: true, serviceRevision: 1,
    profilesAdded: 0, publicationsAdded: 0, defaultEventsAdded: 0 });
  assert.deepEqual(await snapshot(f, allTables), once);
  assert.equal((await f.store.admin.listEligibleProposals({ roundId: 'initial' })).length, 0);
  await assert.rejects(f.store.contribution.settle({}), errorCode('RELEASE_REVIEW_UNAVAILABLE'));
});

test('old deployed inserts, edits and privacy actions on either side of activation are captured atomically', async t => {
  const f = await backendFixture(t, { publicDefaults: false });
  const member = await f.login();
  let old = await legacyProposal(f, member, 'Before activation');
  await activate(f);
  const initial = (await f.store.community.publicFeed()).recent[0];
  const late = await legacyProposal(f, member, 'Late insert from the old deployment');
  assert.equal((await f.store.community.publicFeed()).recent.length, 2);
  old = await legacyProposal(f, member, 'Late old deployment edit', old);
  const edited = (await f.store.community.publicFeed()).recent.find(item => item.id === initial.id);
  assert.equal(edited.body, old.body);
  assert.equal(edited.publicationRevision, initial.publicationRevision + 1);
  await legacyChoice(f, member, old, false);
  old = await legacyProposal(f, member, 'An edit after explicit hiding', old);
  assert.deepEqual((await f.store.community.publicFeed()).recent.map(item => item.body), [late.body]);
  await activate(f);
  assert.deepEqual((await f.store.community.publicFeed()).recent.map(item => item.body), [late.body]);
  await legacyChoice(f, member, old, true);
  await activate(f);
  assert.equal((await f.store.community.publicFeed()).recent.length, 2);
  assert.equal((await f.store.community.privateState(member.session)).publications.find(item => item.proposalId === old.id).visibilitySource, 'author_choice');
  assert.equal((await f.store.listProposals(member.session.user.id)).proposals.find(item => item.id === old.id).safety.status, 'pending');
  // A code rollback only restores the old stricter read behavior. Defaults are
  // not rewritten into old requested=1 or fake Teen safety approval records.
  const legacyVisible = await f.client.execute(`SELECT COUNT(*) AS n FROM community_publications cp JOIN proposals p ON p.id = cp.proposal_id
    JOIN proposal_safety_reviews s ON s.proposal_id = p.id AND s.body_revision = p.revision
    WHERE cp.requested = 1 AND cp.policy_version = '${SAFETY_POLICY_VERSION}' AND s.status = 'approved'`);
  assert.equal(legacyVisible.rows[0].n, 0);
});

test('new intake fails without activation or required triggers and cannot consume submission quota or partially edit', async t => {
  for (const missing of ['activation', 'body_trigger', 'vote_cap_trigger']) {
    await t.test(missing, async nested => {
      const f = await backendFixture(nested, { publicDefaults: false });
      const member = await f.login();
      const old = await legacyProposal(f, member, 'Preserved old body');
      if (missing !== 'activation') {
        await activate(f);
        await f.client.execute(`DROP TRIGGER ${missing === 'body_trigger' ? 'community_default_body' : 'community_default_vote_insert_cap'}`);
      }
      const before = await snapshot(f);
      for (const input of [
        { method: 'POST', body: { body: 'A new public idea', requestId: randomUUID() } },
        { method: 'PATCH', body: { body: 'A new revision', id: old.id, revision: 1 } },
      ]) {
        const result = await request(f.handler, '/api/proposals', { ...signedHeaders(member), ...input });
        assert.equal(result.status, 503);
        assert.equal(result.body.error.code, 'COMMUNITY_SCHEMA_UNAVAILABLE');
        assert.doesNotMatch(result.text, /SELECT|sqlite|trigger|Preserved old body/);
      }
      assert.deepEqual(await snapshot(f), before);
      assert.equal((await f.store.listProposals(member.session.user.id)).quota.remaining, 2);
      await assert.rejects(f.store.health(), errorCode('COMMUNITY_SCHEMA_UNAVAILABLE'));
    });
  }
});

test('an actual publication write failure rolls back the proposal, pending review, history, quota and existing vote validity', async t => {
  const f = await backendFixture(t);
  const author = await f.login('atomic-author');
  await f.client.execute(`CREATE TRIGGER synthetic_publication_failure BEFORE INSERT ON community_publications
    BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END`);
  await assert.rejects(publish(f, author, 'Do not partly save this'));
  assert.equal((await rows(f.client, 'proposals')).length, 0);
  assert.equal((await rows(f.client, 'proposal_body_revisions')).length, 0);
  assert.equal((await rows(f.client, 'proposal_safety_reviews')).length, 0);
  assert.equal((await f.store.listProposals(author.session.user.id)).quota.remaining, 3);
  await f.client.execute('DROP TRIGGER synthetic_publication_failure');
  const proposal = await publish(f, author, 'Original public body');
  const viewer = await f.login('atomic-voter');
  await f.client.execute({ sql: "UPDATE community_rounds SET opens_at = ? WHERE id = 'initial'", args: [f.now() - 1] });
  await f.store.community.mutate(viewer.session, vote((await f.store.community.publicFeed()).recent[0]));
  const before = await snapshot(f);
  await f.client.execute(`CREATE TRIGGER synthetic_publication_failure BEFORE UPDATE ON community_publications
    BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END`);
  await assert.rejects(f.store.editProposal(author.session.user.id, { id: proposal.id, body: 'Failed replacement', revision: 1 }));
  assert.deepEqual(await snapshot(f), before);
  assert.equal((await f.store.community.publicFeed()).recent[0].upvotes, 1);
  assert.equal((await f.store.community.privateState(viewer.session)).voteQuota.used, 1);
});

test('activation observes concurrent service changes in its write transaction and otherwise leaves every policy row untouched', async t => {
  for (const update of ["mode = 'maintenance'", 'proposals_enabled = 0', 'development_enabled = 0', 'revision = 2']) {
    await t.test(update, async nested => {
      const f = await backendFixture(nested, { publicDefaults: false });
      const member = await f.login();
      await legacyProposal(f, member, 'Existing original');
      const wrapper = { batch: async (statements, mode) => {
        await f.client.execute(`UPDATE service_control SET ${update} WHERE id = 1`);
        return f.client.batch(statements, mode);
      } };
      await assert.rejects(activateCommunityPublicDefaults(wrapper, { expectedServiceRevision: 1, databaseClockSql: TEST_CLOCK_SQL }),
        errorCode(update === 'revision = 2' ? 'REVISION_CONFLICT' : 'PROPOSALS_PAUSED'));
      assert.equal((await rows(f.client, 'community_public_policy'))[0].state, 'inactive');
      for (const table of ['community_profiles', 'community_publications', 'community_visibility_choices',
        'community_profile_defaults', 'community_publication_defaults', 'community_default_events', 'community_policy_transitions']) {
        assert.equal((await rows(f.client, table)).length, 0, table);
      }
      assert.equal((await rows(f.client, 'proposals'))[0].body, 'Existing original');
      assert.equal((await rows(f.client, 'proposal_safety_reviews'))[0].status, 'pending');
    });
  }
});

test('a delayed game safety decision does not reject a vote prepared for the same current public body', async t => {
  const f = await backendFixture(t);
  const author = await f.login();
  await publish(f, author, 'A fantasy puzzle');
  const viewer = await f.login('late-review-voter');
  await f.client.execute({ sql: "UPDATE community_rounds SET opens_at = ? WHERE id = 'initial'", args: [f.now() - 1] });
  const idea = (await f.store.community.publicFeed()).recent[0];
  let changed = false;
  const wrapper = { execute: (...args) => f.client.execute(...args), batch: async (statements, mode) => {
    if (!changed && statements.some(statement => String(statement.sql || statement).includes('INSERT INTO community_votes'))) {
      changed = true;
      await f.client.execute("UPDATE proposal_safety_reviews SET status = 'held', revision = revision + 1");
    }
    return f.client.batch(statements, mode);
  } };
  const store = createStore(wrapper, { now: f.now, databaseClockSql: TEST_CLOCK_SQL });
  await store.community.mutate(viewer.session, vote(idea));
  assert.equal(changed, true);
  assert.equal((await f.store.community.publicFeed()).recent[0].upvotes, 1);
});

test('legacy review-dependent vote counting cannot exceed the same three slots after safety reviews change', async t => {
  const f = await backendFixture(t);
  await f.client.execute({ sql: "UPDATE community_rounds SET opens_at = ? WHERE id = 'initial'", args: [f.now() - 1] });
  const viewer = await f.login('legacy-quota-voter');
  const anonymous = await f.store.createAnonymousSession();
  const admin = await f.store.completeLogin(anonymous.session, { googleSub: 'public-default-admin', name: 'Private admin', email: ADMIN_EMAIL, emailVerified: true });
  const items = [];
  for (let index = 0; index < 4; index++) {
    const author = await f.login(`legacy-quota-author-${index}`);
    const proposal = await publish(f, author, `Legacy-compatible idea ${index}`);
    await legacyChoice(f, author, proposal, true);
    const row = (await f.store.admin.query(admin.session, { section: 'proposals', limit: 50 })).items.find(item => item.id === proposal.id);
    await f.store.admin.mutate(admin.session, op('review_proposal_safety', {
      reason: 'Synthetic review', proposalId: row.id, proposalRevision: row.revision, bodyHash: row.safety.bodyHash,
      policyVersion: row.safety.policyVersion, revision: row.safety.revision, status: 'approved',
      checklistConfirmed: true, developmentBrief: 'Add a colorful puzzle.',
    }));
    items.push((await f.store.community.publicFeed()).recent.find(item => item.body === proposal.body));
  }
  for (const idea of items.slice(0, 3)) await f.store.community.mutate(viewer.session, vote(idea));
  await f.client.execute(`UPDATE proposal_safety_reviews SET status = 'held', revision = revision + 1
    WHERE proposal_id IN (SELECT cp.proposal_id FROM community_votes v JOIN community_publications cp ON cp.public_id = v.public_id)`);
  const oldCount = (await f.client.execute(`SELECT COUNT(*) AS n FROM community_votes v JOIN proposal_safety_reviews s
    ON s.id = v.safety_review_id AND s.revision = v.safety_revision WHERE s.status = 'approved'`)).rows[0].n;
  assert.equal(oldCount, 0); // the previous release would think slots were free
  const idea = items[3];
  await assert.rejects(f.client.execute({
    sql: `INSERT INTO community_votes(user_id, round_id, public_id, direction, proposal_revision, publication_revision, body_hash,
      policy_version, safety_review_id, safety_revision, author_control_revision, voter_control_revision, moderation_revision, created_at, updated_at)
      SELECT ?, 'initial', cp.public_id, 'up', cp.proposal_revision, cp.revision, cp.body_hash, cp.policy_version,
        s.id, s.revision, 1, 1, 1, ?, ? FROM community_publications cp JOIN proposal_safety_reviews s ON s.proposal_id = cp.proposal_id
      WHERE cp.public_id = ? AND s.status = 'approved'`,
    args: [viewer.session.user.id, f.now(), f.now(), idea.id],
  }), error => /community vote quota exceeded/.test(error.message));
  await assert.rejects(f.store.community.mutate(viewer.session, vote(idea)), errorCode('VOTE_QUOTA_EXCEEDED'));
  assert.equal((await f.store.community.privateState(viewer.session)).voteQuota.used, 3);
  assert.equal((await rows(f.client, 'community_votes')).length, 3);
});

test('explicit hiding survives an edit and stale successful receipts do not reopen publication or leaderboard visibility', async t => {
  const f = await backendFixture(t);
  const author = await f.login();
  const proposal = await publish(f, author, 'An initially public idea');
  let state = await f.store.community.privateState(author.session);
  const publication = state.publications[0];
  const hide = op('set_publication', { proposalId: proposal.id, proposalRevision: 1,
    publicationRevision: publication.publicationRevision, visible: false });
  const hideProfile = op('set_profile_visibility', { visible: false, revision: state.profile.revision });
  await f.store.community.mutate(author.session, hide);
  await f.store.community.mutate(author.session, hideProfile);
  const edited = await f.store.editProposal(author.session.user.id, { id: proposal.id, body: 'A new body stays hidden', revision: 1 });
  await initializeDatabase(f.client);
  await activate(f);
  await f.store.community.mutate(author.session, hide);
  await f.store.community.mutate(author.session, hideProfile);
  state = await f.store.community.privateState(author.session);
  assert.equal(state.profile.leaderboardVisible, false);
  assert.equal(state.publications[0].proposalRevision, edited.proposal.revision);
  assert.equal(state.publications[0].requested, false);
  assert.deepEqual((await f.store.community.publicFeed()).recent, []);
  assert.deepEqual((await f.store.contribution.leaderboard()).items, []);
  const events = await rows(f.client, 'community_events');
  assert.equal(events.length, 2);
  for (const table of ['community_default_events', 'community_policy_transitions']) {
    await assert.rejects(f.client.execute(`UPDATE ${table} SET policy_version = 'forged'`));
    await assert.rejects(f.client.execute(`DELETE FROM ${table}`));
    await assert.rejects(f.client.execute(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} LIMIT 1`));
  }
  assert.equal((await rows(f.client, 'contribution_ledger')).length, 0);
  assert.equal(INITIAL_CUTOFF, Date.parse('2026-08-31T14:00:00.000Z'));
});
