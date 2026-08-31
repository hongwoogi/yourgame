import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { writeBatch } from './database.mjs';
import { DATABASE_NOW_SQL } from './database-clock.mjs';
import { bodyDigest } from './safety-store.mjs';
import {
  PUBLICATION_POLICY_VERSION, PUBLICATION_POLICY_DTO, COMMUNITY_DEFAULT_READY_SQL,
  PUBLIC_PUBLICATIONS_SQL as PUBLICATIONS, PUBLIC_VOTES_SQL as VOTES, COMMUNITY_VOTE_LIMIT,
  COMMUNITY_PROFILE_NAMES_READY_SQL, profileDisplayAlias,
} from './community-policy.mjs';
import { normalizeProfileAlias } from '../public/profile-policy.js';

export { COMMUNITY_VOTE_LIMIT } from './community-policy.mjs';
export const COMMUNITY_RATE_LIMIT = 30;
export const COMMUNITY_RATE_WINDOW_MS = 60000;
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const fields = {
  set_publication: ['proposalId', 'proposalRevision', 'publicationRevision', 'visible'],
  set_profile_visibility: ['visible', 'revision'],
  set_profile_alias: ['alias', 'revision'],
  vote: ['publicId', 'proposalRevision', 'publicationRevision', 'roundId', 'direction'],
};
const iso = value => value == null ? null : new Date(Number(value)).toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
function invalid() { return new ApiError(422, 'INVALID_COMMUNITY_INPUT', 'Check the community request.'); }
function id(value) { if (typeof value !== 'string' || !ID.test(value)) throw invalid(); return value; }
function revision(value, min = 1) { if (!Number.isSafeInteger(value) || value < min) throw invalid(); return value; }
function conflict() { return new ApiError(409, 'COMMUNITY_REVISION_CONFLICT', 'The publication or profile changed. Reload the latest state.'); }
function unavailable() { return new ApiError(409, 'PUBLICATION_UNAVAILABLE', 'This publication is not available for voting.'); }
function closed() { return new ApiError(409, 'VOTING_CLOSED', 'Voting is unavailable for this collection round.'); }

const CTE = `WITH ${PUBLICATIONS}, ${VOTES}`;
const PARTICIPATION = `EXISTS (SELECT 1 FROM service_control WHERE id = 1 AND mode = 'active' AND proposals_enabled = 1)`;

function assertService(row) {
  if (!row) throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Service controls are unavailable.');
  if (row.mode === 'ended') throw new ApiError(409, 'SERVICE_ENDED', 'The service has ended.');
  if (row.mode === 'maintenance') throw new ApiError(409, 'SERVICE_MAINTENANCE', 'The service is under maintenance.');
  if (Number(row.proposals_enabled) !== 1) throw new ApiError(409, 'PROPOSALS_PAUSED', 'Participation is paused.');
}

export function createCommunityStore(client, { databaseClockSql = DATABASE_NOW_SQL } = {}) {
  function assertReady(row) {
    if (Number(row?.ready) !== 1) throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Public participation is temporarily unavailable.');
  }
  const actorSql = `SELECT s.user_id, COALESCE(m.status, 'active') AS status, COALESCE(m.revision, 1) AS control_revision,
    ${databaseClockSql} AS now_ms FROM sessions s LEFT JOIN member_access m ON m.user_id = s.user_id
    WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ${databaseClockSql}`;
  const actor = session => ({ sql: actorSql, args: [session?.tokenHash || '', session?.user?.id || ''] });
  const live = session => ({ sql: `EXISTS (${actorSql} AND COALESCE(m.status, 'active') = 'active')`, args: actor(session).args });
  function assertActor(row) {
    if (!row) throw new ApiError(401, 'LOGIN_REQUIRED', 'Sign in to continue.');
    if (row.status !== 'active') throw new ApiError(403, 'USER_SUSPENDED', 'This account is suspended.');
    return row;
  }

  async function ensureProfile(session) {
    const guard = live(session);
    const result = await writeBatch(client, [actor(session), {
      sql: `INSERT INTO community_profiles(user_id, public_id, alias, created_at, updated_at)
        SELECT ?, ?, ?, ${databaseClockSql}, ${databaseClockSql} WHERE ${guard.sql} AND ${COMMUNITY_DEFAULT_READY_SQL}
        ON CONFLICT(user_id) DO NOTHING`,
      args: [session?.user?.id || '', randomUUID(), `Player-${randomBytes(6).toString('hex')}`, ...guard.args],
    }, { sql: 'SELECT * FROM community_profiles WHERE user_id = ?', args: [session?.user?.id || ''] },
    `SELECT ${COMMUNITY_DEFAULT_READY_SQL} AS ready`]);
    assertActor(result[0].rows[0]);
    assertReady(result[3].rows[0]);
    return result[2].rows[0];
  }

  const roundStatement = () => ({ sql: `SELECT r.*, s.mode, s.proposals_enabled, ${databaseClockSql} AS now_ms,
      ${COMMUNITY_DEFAULT_READY_SQL} AS ready
    FROM service_control s LEFT JOIN community_rounds r ON r.id = 'initial' WHERE s.id = 1`, args: [] });
  function roundView(row) {
    if (!row?.id) return null;
    const now = Number(row.now_ms);
    return { id: row.id, status: now < Number(row.opens_at) ? 'waiting' : now >= Number(row.closes_at) ? 'closed' : 'open',
      closesAt: iso(row.closes_at), limit: COMMUNITY_VOTE_LIMIT };
  }
  function voteQuota(row, used) {
    const round = roundView(row);
    return { roundId: round?.id ?? null, limit: COMMUNITY_VOTE_LIMIT, used,
      remaining: round?.status === 'open' ? Math.max(0, COMMUNITY_VOTE_LIMIT - used) : 0, closesAt: round?.closesAt ?? null };
  }
  function idea(row) {
    const alias = profileDisplayAlias(row.alias, row.custom_alias);
    if (alias === null) throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Public profile information is unavailable.');
    return { id: row.public_id, body: row.body, proposalRevision: Number(row.proposal_revision), publicationRevision: Number(row.revision),
      author: { id: row.author_public_id, alias }, createdAt: iso(row.proposal_created_at),
      upvotes: Number(row.upvotes), downvotes: Number(row.downvotes), votingOpen: Number(row.voting_open) === 1, roundId: row.voting_round_id ?? null };
  }

  async function publicFeed() {
    const select = `${CTE}, counts AS (SELECT public_id,
      SUM(CASE WHEN direction = 'up' THEN 1 ELSE 0 END) AS upvotes,
      SUM(CASE WHEN direction = 'down' THEN 1 ELSE 0 END) AS downvotes FROM valid_votes GROUP BY public_id)
      SELECT ep.*, pn.alias AS custom_alias, COALESCE(c.upvotes, 0) AS upvotes, COALESCE(c.downvotes, 0) AS downvotes,
        r.id AS voting_round_id, (${PARTICIPATION} AND ${databaseClockSql} >= r.opens_at AND ${databaseClockSql} < r.closes_at) AS voting_open
      FROM eligible_publications ep LEFT JOIN counts c ON c.public_id = ep.public_id
      LEFT JOIN community_profile_names pn ON pn.user_id = ep.author_user_id
      LEFT JOIN community_rounds r ON r.proposal_round_id = ep.proposal_round_id`;
    const result = await client.batch([
      roundStatement(),
      `${select} ORDER BY ep.proposal_created_at DESC, ep.public_id DESC LIMIT 6`,
      `${select} ORDER BY (COALESCE(c.upvotes, 0) - COALESCE(c.downvotes, 0)) DESC,
        COALESCE(c.upvotes, 0) DESC, ep.proposal_created_at DESC, ep.public_id DESC LIMIT 6`,
    ], 'read');
    if (!result[0].rows[0]) throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Community state is unavailable.');
    assertReady(result[0].rows[0]);
    return { recent: result[1].rows.map(idea), popular: result[2].rows.map(idea), round: roundView(result[0].rows[0]),
      publicationPolicy: PUBLICATION_POLICY_DTO, serverTime: iso(result[0].rows[0].now_ms) };
  }

  async function publicIdeas({ sort = 'recent', offset = 0, limit = 24 } = {}) {
    if (!['recent', 'popular'].includes(sort) || !Number.isSafeInteger(offset) || offset < 0
        || !Number.isInteger(limit) || limit < 1 || limit > 50) throw invalid();
    const order = prefix => sort === 'popular'
      ? `(${prefix}upvotes - ${prefix}downvotes) DESC, ${prefix}upvotes DESC,
          ${prefix}proposal_created_at DESC, ${prefix}public_id DESC`
      : `${prefix}proposal_created_at DESC, ${prefix}public_id DESC`;
    // One read statement binds visibility, vote totals, pagination and context
    // to one snapshot. Materializing the clock also keeps round/voting state
    // consistent at the exact cutoff. The context row survives an empty page.
    const result = await client.batch([{
      sql: `WITH snapshot_clock AS MATERIALIZED (SELECT ${databaseClockSql} AS now_ms),
        ${PUBLICATIONS}, ${VOTES},
        vote_counts AS (SELECT public_id,
          SUM(CASE WHEN direction = 'up' THEN 1 ELSE 0 END) AS upvotes,
          SUM(CASE WHEN direction = 'down' THEN 1 ELSE 0 END) AS downvotes FROM valid_votes GROUP BY public_id),
        visible_ideas AS (
          SELECT ep.*, pn.alias AS custom_alias, COALESCE(c.upvotes, 0) AS upvotes, COALESCE(c.downvotes, 0) AS downvotes,
            r.id AS voting_round_id,
            (${PARTICIPATION} AND clock.now_ms >= r.opens_at AND clock.now_ms < r.closes_at) AS voting_open
          FROM eligible_publications ep CROSS JOIN snapshot_clock clock
          LEFT JOIN vote_counts c ON c.public_id = ep.public_id
          LEFT JOIN community_profile_names pn ON pn.user_id = ep.author_user_id
          LEFT JOIN community_rounds r ON r.proposal_round_id = ep.proposal_round_id
        ), page_items AS (SELECT * FROM visible_ideas ORDER BY ${order('')} LIMIT ? OFFSET ?),
        page_context AS (
          SELECT r.id AS collection_id, r.opens_at AS collection_opens_at, r.closes_at AS collection_closes_at,
            clock.now_ms, ${COMMUNITY_DEFAULT_READY_SQL} AS ready,
            (SELECT COUNT(*) FROM eligible_publications) AS total
          FROM service_control s CROSS JOIN snapshot_clock clock
          LEFT JOIN community_rounds r ON r.id = 'initial' WHERE s.id = 1
        )
        SELECT context.*, page.* FROM page_context context LEFT JOIN page_items page ON true
        ORDER BY ${order('page.')}`,
      args: [limit, offset],
    }], 'read');
    const rows = result[0].rows;
    const context = rows[0];
    if (!context || !Number.isSafeInteger(Number(context.total)) || Number(context.total) < 0) {
      throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Community state is unavailable.');
    }
    assertReady(context);
    const total = Number(context.total);
    return { items: rows.filter(row => row.public_id != null).map(idea), sort, offset, limit, total,
      hasMore: offset < total && total - offset > limit,
      round: roundView({ id: context.collection_id, opens_at: context.collection_opens_at,
        closes_at: context.collection_closes_at, now_ms: context.now_ms }),
      publicationPolicy: PUBLICATION_POLICY_DTO, serverTime: iso(context.now_ms) };
  }

  async function privateState(session) {
    await ensureProfile(session);
    const userId = session?.user?.id || '';
    const result = await client.batch([
      actor(session),
      { sql: `SELECT pr.*, pn.alias AS custom_alias,
          CASE WHEN c.event_id IS NULL THEN 'service_default' ELSE 'author_choice' END AS visibility_source
        FROM community_profiles pr LEFT JOIN community_visibility_choices c ON c.kind = 'profile' AND c.target_id = pr.user_id
        LEFT JOIN community_profile_names pn ON pn.user_id = pr.user_id
        WHERE pr.user_id = ?`, args: [userId] },
      roundStatement(),
      { sql: `${CTE} SELECT * FROM valid_votes WHERE user_id = ? ORDER BY updated_at DESC, public_id DESC`, args: [userId] },
      { sql: `WITH ${PUBLICATIONS} SELECT p.id AS proposal_id,
          COALESCE(cp.proposal_revision, p.revision) AS proposal_revision, COALESCE(cp.revision, 0) AS publication_revision,
          cp.public_id, COALESCE(c.visible, 1) AS requested, ep.public_id IS NOT NULL AS eligible,
          CASE WHEN c.event_id IS NULL THEN 'service_default' ELSE 'author_choice' END AS visibility_source
        FROM proposals p LEFT JOIN community_publications cp ON cp.proposal_id = p.id
        LEFT JOIN community_visibility_choices c ON c.kind = 'publication' AND c.target_id = p.id
        LEFT JOIN eligible_publications ep ON ep.proposal_id = p.id
        WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id DESC`, args: [userId] },
    ], 'read');
    assertActor(result[0].rows[0]);
    assertReady(result[2].rows[0]);
    const profile = result[1].rows[0];
    if (!profile || !result[2].rows[0]) throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Community state is unavailable.');
    const alias = profileDisplayAlias(profile.alias, profile.custom_alias);
    if (alias === null) throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Public profile information is unavailable.');
    const votes = result[3].rows.map(row => ({ publicId: row.public_id, direction: row.direction,
      proposalRevision: Number(row.proposal_revision), publicationRevision: Number(row.publication_revision), roundId: row.round_id }));
    const used = votes.filter(vote => vote.roundId === result[2].rows[0].id).length;
    return { ownerId: userId, profile: { id: profile.public_id, alias,
      leaderboardVisible: Number(profile.leaderboard_visible) === 1, revision: Number(profile.revision), visibilitySource: profile.visibility_source },
      publicationPolicy: PUBLICATION_POLICY_DTO,
      voteQuota: voteQuota(result[2].rows[0], used), votes,
      publications: result[4].rows.map(row => ({ proposalId: row.proposal_id, proposalRevision: Number(row.proposal_revision),
        publicationRevision: Number(row.publication_revision), publicId: row.public_id ?? null,
        requested: Number(row.requested) === 1, eligible: Number(row.eligible) === 1, visibilitySource: row.visibility_source })) };
  }

  async function recordAttempt(session) {
    const guard = live(session);
    const userId = session?.user?.id || '';
    const result = await writeBatch(client, [actor(session),
      { sql: `DELETE FROM community_rate_windows WHERE (user_id, window_start) IN
        (SELECT user_id, window_start FROM community_rate_windows WHERE expires_at <= ${databaseClockSql} ORDER BY expires_at LIMIT 100)`, args: [] },
      { sql: `INSERT INTO community_rate_windows(user_id, window_start, used, expires_at)
        SELECT ?, (${databaseClockSql} / ${COMMUNITY_RATE_WINDOW_MS}) * ${COMMUNITY_RATE_WINDOW_MS}, 1,
          ((${databaseClockSql} / ${COMMUNITY_RATE_WINDOW_MS}) + 1) * ${COMMUNITY_RATE_WINDOW_MS} WHERE ${guard.sql}
        ON CONFLICT(user_id, window_start) DO UPDATE SET used = used + 1 WHERE used < ${COMMUNITY_RATE_LIMIT}`,
        args: [userId, ...guard.args] },
    ]);
    const current = assertActor(result[0].rows[0]);
    if (result[2].rowsAffected !== 1) {
      const next = (Math.floor(Number(current.now_ms) / COMMUNITY_RATE_WINDOW_MS) + 1) * COMMUNITY_RATE_WINDOW_MS;
      throw new ApiError(429, 'COMMUNITY_RATE_LIMITED', 'Community requests are too frequent. Try again shortly.',
        { retryAfterSeconds: Math.max(1, Math.ceil((next - Number(current.now_ms)) / 1000)) });
    }
  }

  async function mutate(session, input) {
    await recordAttempt(session);
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(fields, input.action)) throw invalid();
    const allowed = new Set(['action', 'requestId', ...fields[input.action]]);
    if (Object.keys(input).some(key => !allowed.has(key))) throw invalid();
    const requestId = id(input.requestId);
    let normalizedAlias;
    if (input.action === 'set_profile_alias') {
      normalizedAlias = normalizeProfileAlias(input.alias);
      if (normalizedAlias === null) throw new ApiError(422, 'INVALID_PROFILE_ALIAS', 'Choose a valid public display name.');
      revision(input.revision);
    }
    await ensureProfile(session);
    const userId = session.user.id;
    const payloadHash = hash(canonical(input));
    const eventId = randomUUID();
    const guard = live(session);
    const common = `${guard.sql} AND ${COMMUNITY_DEFAULT_READY_SQL}
      AND NOT EXISTS(SELECT 1 FROM community_requests WHERE user_id = ? AND request_id = ?)`;
    const commonArgs = [...guard.args, userId, requestId];
    const lookup = { sql: 'SELECT * FROM community_requests WHERE user_id = ? AND request_id = ?', args: [userId, requestId] };
    let primary;
    let target;
    let event;
    let expectedRevision;
    let preparationError;
    const additionalWrites = [];
    const serviceNeeded = input.action === 'vote' || input.action === 'set_profile_alias' || input.visible === true;
    if (input.action === 'set_profile_visibility') {
      if (typeof input.visible !== 'boolean') throw invalid();
      expectedRevision = revision(input.revision);
      target = { sql: 'SELECT revision FROM community_profiles WHERE user_id = ?', args: [userId] };
      primary = { sql: `UPDATE community_profiles SET leaderboard_visible = ?, revision = revision + 1, updated_at = ${databaseClockSql}
        WHERE user_id = ? AND revision = ? AND ${common} ${input.visible ? `AND ${PARTICIPATION}` : ''}`,
        args: [Number(input.visible), userId, expectedRevision, ...commonArgs] };
      event = { sql: `SELECT public_id AS target_id, json_object('leaderboardVisible', leaderboard_visible, 'revision', revision) AS details
        FROM community_profiles WHERE user_id = ? AND changes() = 1`, args: [userId] };
    } else if (input.action === 'set_profile_alias') {
      expectedRevision = revision(input.revision);
      target = { sql: `SELECT revision, ${COMMUNITY_PROFILE_NAMES_READY_SQL} AS names_ready
        FROM community_profiles WHERE user_id = ?`, args: [userId] };
      primary = { sql: `UPDATE community_profiles SET revision = revision + 1, updated_at = ${databaseClockSql}
        WHERE user_id = ? AND revision = ? AND ${common} AND ${PARTICIPATION} AND ${COMMUNITY_PROFILE_NAMES_READY_SQL}`,
        args: [userId, expectedRevision, ...commonArgs] };
      additionalWrites.push({ sql: `INSERT INTO community_profile_names(user_id, alias, revision, created_at, updated_at)
        SELECT user_id, ?, revision, ${databaseClockSql}, ${databaseClockSql} FROM community_profiles
        WHERE user_id = ? AND changes() = 1
        ON CONFLICT(user_id) DO UPDATE SET alias = excluded.alias, revision = excluded.revision, updated_at = excluded.updated_at`,
        args: [normalizedAlias, userId] });
      event = { sql: `SELECT pr.public_id AS target_id, json_object('alias', pn.alias, 'revision', pr.revision) AS details
        FROM community_profiles pr JOIN community_profile_names pn ON pn.user_id = pr.user_id
        WHERE pr.user_id = ? AND pn.revision = pr.revision AND changes() = 1`, args: [userId] };
    } else if (input.action === 'set_publication') {
      id(input.proposalId); revision(input.proposalRevision); expectedRevision = revision(input.publicationRevision, 0);
      if (typeof input.visible !== 'boolean') throw invalid();
      const original = (await client.execute({ sql: 'SELECT body FROM proposals WHERE id = ? AND user_id = ? AND revision = ?',
        args: [input.proposalId, userId, input.proposalRevision] })).rows[0];
      if (!original) preparationError = conflict();
      const body = original?.body || '';
      const bodyHash = bodyDigest(body);
      target = { sql: `SELECT p.id, p.user_id, p.revision AS proposal_revision, COALESCE(cp.revision, 0) AS revision
        FROM proposals p LEFT JOIN community_publications cp ON cp.proposal_id = p.id WHERE p.id = ?`, args: [input.proposalId] };
      primary = { sql: `INSERT INTO community_publications(proposal_id, public_id, proposal_revision, body_hash, policy_version,
          requested, author_control_revision, revision, created_at, updated_at)
        SELECT p.id, ?, p.revision, ?, ?, ?, COALESCE(m.revision, 1), COALESCE(cp.revision, 0) + 1, ${databaseClockSql}, ${databaseClockSql}
        FROM proposals p LEFT JOIN community_publications cp ON cp.proposal_id = p.id LEFT JOIN member_access m ON m.user_id = p.user_id
        WHERE p.id = ? AND p.user_id = ? AND p.revision = ? AND p.body = ? AND COALESCE(cp.revision, 0) = ?
          AND ${common} ${input.visible ? `AND ${PARTICIPATION}` : ''}
        ON CONFLICT(proposal_id) DO UPDATE SET proposal_revision = excluded.proposal_revision, body_hash = excluded.body_hash,
          policy_version = excluded.policy_version, requested = excluded.requested, author_control_revision = excluded.author_control_revision,
          revision = excluded.revision, updated_at = excluded.updated_at`,
        args: [randomUUID(), bodyHash, PUBLICATION_POLICY_VERSION, Number(input.visible), input.proposalId, userId,
          input.proposalRevision, body, expectedRevision, ...commonArgs] };
      event = { sql: `SELECT public_id AS target_id, json_object('proposalId', proposal_id, 'proposalRevision', proposal_revision,
          'publicationRevision', revision, 'bodyHash', body_hash, 'policyVersion', policy_version,
          'requested', requested, 'authorControlRevision', author_control_revision) AS details
        FROM community_publications WHERE proposal_id = ? AND changes() = 1`, args: [input.proposalId] };
    } else {
      id(input.publicId); revision(input.proposalRevision); revision(input.publicationRevision);
      if (typeof input.roundId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.roundId)
          || !['up', 'down', 'none'].includes(input.direction)) throw invalid();
      target = { sql: `WITH ${PUBLICATIONS} SELECT cp.public_id, cp.proposal_revision, cp.revision,
          p.user_id AS author_user_id, ep.public_id IS NOT NULL AS eligible, cr.id AS round_id, cr.opens_at, cr.closes_at,
          ${databaseClockSql} AS now_ms
        FROM community_publications cp JOIN proposals p ON p.id = cp.proposal_id
        LEFT JOIN eligible_publications ep ON ep.public_id = cp.public_id
        LEFT JOIN community_rounds cr ON cr.proposal_round_id = p.round_id
        WHERE cp.public_id = ?`, args: [input.publicId] };
      if (input.direction === 'none') {
        primary = { sql: `UPDATE community_votes SET direction = 'none', revision = revision + 1, updated_at = ${databaseClockSql}
          WHERE user_id = ? AND public_id = ? AND round_id = ? AND proposal_revision = ? AND publication_revision = ?
            AND EXISTS(SELECT 1 FROM community_rounds WHERE id = ? AND ${databaseClockSql} >= opens_at AND ${databaseClockSql} < closes_at)
            AND ${PARTICIPATION} AND ${common}`,
          args: [userId, input.publicId, input.roundId, input.proposalRevision, input.publicationRevision, input.roundId, ...commonArgs] };
      } else {
        primary = { sql: `${CTE} INSERT INTO community_votes(user_id, round_id, public_id, direction,
            proposal_revision, publication_revision, body_hash, policy_version, safety_review_id, safety_revision,
            author_control_revision, voter_control_revision, moderation_revision, revision, created_at, updated_at)
          SELECT ?, cr.id, ep.public_id, ?, ep.proposal_revision, ep.revision, ep.body_hash, ep.policy_version,
            ep.safety_review_id, ep.safety_revision, ep.current_author_revision, COALESCE(va.revision, 1), ep.moderation_revision,
            COALESCE(old.revision, 0) + 1, ${databaseClockSql}, ${databaseClockSql}
          FROM eligible_publications ep JOIN community_rounds cr ON cr.proposal_round_id = ep.proposal_round_id
          LEFT JOIN member_access va ON va.user_id = ?
          LEFT JOIN community_votes old ON old.user_id = ? AND old.round_id = cr.id AND old.public_id = ep.public_id
          WHERE ep.public_id = ? AND ep.proposal_revision = ? AND ep.revision = ? AND ep.author_user_id != ? AND cr.id = ?
            AND ep.safety_review_id IS NOT NULL
            AND ${databaseClockSql} >= cr.opens_at AND ${databaseClockSql} < cr.closes_at AND ${PARTICIPATION} AND ${common}
            AND ((SELECT COUNT(*) FROM valid_votes WHERE user_id = ? AND round_id = cr.id) < ${COMMUNITY_VOTE_LIMIT}
              OR EXISTS(SELECT 1 FROM valid_votes WHERE user_id = ? AND round_id = cr.id AND public_id = ep.public_id))
          ON CONFLICT(user_id, round_id, public_id) DO UPDATE SET direction = excluded.direction,
            proposal_revision = excluded.proposal_revision, publication_revision = excluded.publication_revision,
            body_hash = excluded.body_hash, policy_version = excluded.policy_version,
            safety_review_id = excluded.safety_review_id, safety_revision = excluded.safety_revision,
            author_control_revision = excluded.author_control_revision, voter_control_revision = excluded.voter_control_revision,
            moderation_revision = excluded.moderation_revision, revision = excluded.revision, updated_at = excluded.updated_at`,
          args: [userId, input.direction, userId, userId, input.publicId, input.proposalRevision, input.publicationRevision,
            userId, input.roundId, ...commonArgs, userId, userId] };
      }
      event = { sql: `SELECT public_id AS target_id, json_object('roundId', round_id, 'direction', direction,
          'proposalRevision', proposal_revision, 'publicationRevision', publication_revision, 'bodyHash', body_hash,
          'policyVersion', policy_version, 'safetyReviewId', safety_review_id, 'safetyRevision', safety_revision,
          'authorControlRevision', author_control_revision, 'voterControlRevision', voter_control_revision,
          'moderationRevision', moderation_revision, 'revision', revision) AS details
        FROM community_votes WHERE user_id = ? AND round_id = ? AND public_id = ? AND changes() = 1`,
        args: [userId, input.roundId, input.publicId] };
    }

    const results = await writeBatch(client, [actor(session), lookup, target,
      'SELECT * FROM service_control WHERE id = 1', primary, ...additionalWrites,
      { sql: `INSERT INTO community_events(id, actor_user_id, action, target_id, details_json, payload_hash, created_at)
        SELECT ?, ?, ?, target_id, details, ?, ${databaseClockSql} FROM (${event.sql})`,
        args: [eventId, userId, input.action, payloadHash, ...event.args] },
      { sql: `INSERT INTO community_requests(user_id, request_id, payload_hash, response_json, created_at)
        SELECT actor_user_id, ?, payload_hash, json_object('ok', json('true'), 'targetId', target_id), created_at
        FROM community_events WHERE id = ?`, args: [requestId, eventId] }, lookup,
    ]);
    assertActor(results[0].rows[0]);
    const receipt = results.at(-1).rows[0];
    if (receipt) {
      if (receipt.payload_hash !== payloadHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request ID was used for different content.');
      return JSON.parse(receipt.response_json);
    }
    if (serviceNeeded) assertService(results[3].rows[0]);
    const current = results[2].rows[0];
    if (input.action === 'set_publication') {
      if (!current) throw new ApiError(404, 'PROPOSAL_NOT_FOUND', 'The proposal could not be found.');
      if (current.user_id !== userId) throw new ApiError(403, 'NOT_PROPOSAL_OWNER', 'Only the author can change publication.');
      throw preparationError || conflict();
    }
    if (input.action === 'set_profile_alias' && Number(current?.names_ready) !== 1) {
      throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Display name storage is unavailable.');
    }
    if (input.action === 'set_profile_visibility' || input.action === 'set_profile_alias') throw conflict();
    if (!current) throw unavailable();
    if (current.author_user_id === userId) throw new ApiError(403, 'SELF_VOTE_FORBIDDEN', 'You cannot vote on your own proposal.');
    if (!current.round_id || current.round_id !== input.roundId || Number(current.now_ms) < Number(current.opens_at)
        || Number(current.now_ms) >= Number(current.closes_at)) throw closed();
    if (Number(current.proposal_revision) !== input.proposalRevision || Number(current.revision) !== input.publicationRevision) throw conflict();
    if (input.direction === 'none') throw conflict();
    if (Number(current.eligible) !== 1) throw unavailable();
    const state = await privateState(session);
    if (state.voteQuota.remaining === 0) throw new ApiError(429, 'VOTE_QUOTA_EXCEEDED', 'All 3 vote slots for this round are in use.', { voteQuota: state.voteQuota });
    throw conflict();
  }

  return { publicFeed, publicIdeas, privateState, mutate };
}
