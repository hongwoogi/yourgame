import { ApiError } from './errors.mjs';
import { DATABASE_NOW_SQL } from './database-clock.mjs';
import { INITIAL_CUTOFF } from './config.mjs';
import {
  PUBLICATION_POLICY_VERSION, COMMUNITY_DEFAULT_ACTIVE_SQL, COMMUNITY_DEFAULT_READY_SQL,
  COMMUNITY_DEFAULT_TRIGGER_NAMES, PUBLIC_PUBLICATIONS_SQL, PUBLIC_VOTES_SQL, COMMUNITY_VOTE_LIMIT,
} from './community-policy.mjs';

export const COMMUNITY_SCHEMA_VERSION = 1;
export const COMMUNITY_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS community_meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS community_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id), public_id TEXT NOT NULL UNIQUE,
    alias TEXT NOT NULL UNIQUE CHECK(length(alias) = 19 AND substr(alias, 1, 7) = 'Player-'
      AND substr(alias, 8) NOT GLOB '*[^0-9a-f]*'),
    leaderboard_visible INTEGER NOT NULL DEFAULT 0 CHECK(leaderboard_visible IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS community_profile_identity_immutable BEFORE UPDATE OF user_id, public_id, alias, created_at ON community_profiles
    BEGIN SELECT RAISE(ABORT, 'community identity is immutable'); END`,
  `CREATE TABLE IF NOT EXISTS community_rounds (
    id TEXT PRIMARY KEY, proposal_round_id TEXT NOT NULL UNIQUE,
    opens_at INTEGER NOT NULL, closes_at INTEGER NOT NULL CHECK(closes_at > opens_at)
  )`,
  `INSERT INTO community_rounds(id, proposal_round_id, opens_at, closes_at)
    SELECT 'initial', 'initial', MIN(${DATABASE_NOW_SQL}, ${INITIAL_CUTOFF - 1},
      COALESCE((SELECT MIN(created_at) FROM proposals WHERE round_id = 'initial'), ${DATABASE_NOW_SQL})), ${INITIAL_CUTOFF}
    WHERE true ON CONFLICT(id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS community_publications (
    proposal_id TEXT PRIMARY KEY REFERENCES proposals(id), public_id TEXT NOT NULL UNIQUE,
    proposal_revision INTEGER NOT NULL CHECK(proposal_revision >= 1), body_hash TEXT NOT NULL,
    policy_version TEXT NOT NULL, requested INTEGER NOT NULL CHECK(requested IN (0, 1)),
    author_control_revision INTEGER NOT NULL CHECK(author_control_revision >= 1),
    revision INTEGER NOT NULL CHECK(revision >= 1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS community_publication_identity_immutable BEFORE UPDATE OF proposal_id, public_id, created_at ON community_publications
    BEGIN SELECT RAISE(ABORT, 'publication identity is immutable'); END`,
  `CREATE TABLE IF NOT EXISTS community_votes (
    user_id TEXT NOT NULL REFERENCES users(id), round_id TEXT NOT NULL REFERENCES community_rounds(id),
    public_id TEXT NOT NULL REFERENCES community_publications(public_id),
    direction TEXT NOT NULL CHECK(direction IN ('up', 'down', 'none')),
    proposal_revision INTEGER NOT NULL, publication_revision INTEGER NOT NULL, body_hash TEXT NOT NULL,
    policy_version TEXT NOT NULL, safety_review_id TEXT NOT NULL REFERENCES proposal_safety_reviews(id), safety_revision INTEGER NOT NULL,
    author_control_revision INTEGER NOT NULL, voter_control_revision INTEGER NOT NULL, moderation_revision INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, round_id, public_id)
  )`,
  'CREATE INDEX IF NOT EXISTS community_votes_public_idx ON community_votes(public_id, round_id, direction)',
  `CREATE TABLE IF NOT EXISTS community_events (
    id TEXT PRIMARY KEY, actor_user_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL,
    target_id TEXT NOT NULL, details_json TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS community_events_no_update BEFORE UPDATE ON community_events
    BEGIN SELECT RAISE(ABORT, 'community history is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS community_events_no_delete BEFORE DELETE ON community_events
    BEGIN SELECT RAISE(ABORT, 'community history is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS community_events_no_replace BEFORE INSERT ON community_events
    WHEN EXISTS (SELECT 1 FROM community_events WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'community history cannot be replaced'); END`,
  `CREATE TABLE IF NOT EXISTS community_requests (
    user_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    response_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, request_id)
  )`,
  `CREATE TRIGGER IF NOT EXISTS community_requests_no_update BEFORE UPDATE ON community_requests
    BEGIN SELECT RAISE(ABORT, 'community receipt is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS community_requests_no_delete BEFORE DELETE ON community_requests
    BEGIN SELECT RAISE(ABORT, 'community receipt is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS community_requests_no_replace BEFORE INSERT ON community_requests
    WHEN EXISTS (SELECT 1 FROM community_requests WHERE user_id = NEW.user_id AND request_id = NEW.request_id)
    BEGIN SELECT RAISE(ABORT, 'community receipts cannot be replaced'); END`,
  `CREATE TABLE IF NOT EXISTS community_rate_windows (
    user_id TEXT NOT NULL REFERENCES users(id), window_start INTEGER NOT NULL, used INTEGER NOT NULL CHECK(used > 0),
    expires_at INTEGER NOT NULL, PRIMARY KEY(user_id, window_start)
  )`,
  'CREATE INDEX IF NOT EXISTS community_rate_expiry_idx ON community_rate_windows(expires_at)',
  { sql: 'INSERT INTO community_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', args: ['schema_version', COMMUNITY_SCHEMA_VERSION] },
];

export async function initializeCommunityDatabase(client) {
  await client.batch(COMMUNITY_SCHEMA, 'write');
  // Preparation is deliberately inactive. A deployment operator must review
  // and activate this policy separately; ordinary initialization is not consent.
  await client.batch(COMMUNITY_PUBLIC_DEFAULT_SCHEMA, 'write');
  await checkCommunitySchema(client);
}

export async function checkCommunitySchema(client) {
  try {
    const result = await client.execute(`SELECT (SELECT value FROM community_meta WHERE key = 'schema_version') AS version,
      (SELECT revision FROM community_profiles LIMIT 1) AS profile_check,
      (SELECT closes_at FROM community_rounds LIMIT 1) AS round_check,
      (SELECT revision FROM community_publications LIMIT 1) AS publication_check,
      (SELECT safety_revision FROM community_votes LIMIT 1) AS vote_check,
      (SELECT id FROM community_events LIMIT 1) AS event_check,
      (SELECT payload_hash FROM community_requests LIMIT 1) AS request_check,
      (SELECT used FROM community_rate_windows LIMIT 1) AS rate_check,
      (SELECT value FROM community_meta WHERE key = 'public_defaults_schema_version') AS defaults_version,
      (SELECT state FROM community_public_policy WHERE id = 1) AS defaults_state,
      (SELECT event_id FROM community_visibility_choices LIMIT 1) AS choice_check,
      (SELECT policy_version FROM community_profile_defaults LIMIT 1) AS profile_default_check,
      (SELECT policy_version FROM community_publication_defaults LIMIT 1) AS publication_default_check,
      (SELECT id FROM community_default_events LIMIT 1) AS default_event_check,
      (SELECT id FROM community_policy_transitions LIMIT 1) AS transition_check,
      (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (
        'community_profile_identity_immutable', 'community_publication_identity_immutable',
        'community_events_no_update', 'community_events_no_delete', 'community_events_no_replace',
        'community_requests_no_update', 'community_requests_no_delete', 'community_requests_no_replace')) AS immutable_triggers`);
    if (Number(result.rows[0]?.version) !== COMMUNITY_SCHEMA_VERSION || Number(result.rows[0]?.immutable_triggers) !== 8
        || Number(result.rows[0]?.defaults_version) !== 1 || !['inactive', 'active'].includes(result.rows[0]?.defaults_state)) {
      throw new Error('Incomplete community storage.');
    }
  } catch {
    throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Community storage is temporarily unavailable.');
  }
}

const uuidSql = `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
  || '-' || substr('89ab', (random() & 3) + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))`;
const policySql = `'${PUBLICATION_POLICY_VERSION}'`;

function defaultEventSql(kind, target, sourceRevision, publicationRevision, from, where, time) {
  return `INSERT INTO community_default_events(id, kind, target_id, source_revision, publication_revision, policy_version, basis, created_at)
    SELECT ${uuidSql}, '${kind}', ${target}, ${sourceRevision}, ${publicationRevision}, ${policySql},
      CASE WHEN EXISTS(SELECT 1 FROM community_visibility_choices c WHERE c.kind = '${kind}' AND c.target_id = ${target})
        THEN 'author_choice' ELSE 'service_default' END, ${time}
    FROM ${from} WHERE ${where} AND ${COMMUNITY_DEFAULT_ACTIVE_SQL}
      AND NOT EXISTS(SELECT 1 FROM community_default_events e WHERE e.kind = '${kind}'
        AND e.target_id = ${target} AND e.source_revision = ${sourceRevision})`;
}

function profileStatements(scope = 'true', time = DATABASE_NOW_SQL) {
  return [
    `INSERT INTO community_profiles(user_id, public_id, alias, leaderboard_visible, created_at, updated_at)
      SELECT u.id, ${uuidSql}, 'Player-' || lower(hex(randomblob(6))),
        COALESCE((SELECT visible FROM community_visibility_choices c WHERE c.kind = 'profile' AND c.target_id = u.id), 1),
        ${time}, ${time} FROM users u WHERE ${scope} AND ${COMMUNITY_DEFAULT_ACTIVE_SQL}
      ON CONFLICT(user_id) DO NOTHING`,
  ];
}

function enrollProfileStatements(scope = 'true', time = DATABASE_NOW_SQL) {
  return [
    `INSERT INTO community_profile_defaults(user_id, policy_version, created_at, updated_at)
      SELECT pr.user_id, ${policySql}, ${time}, ${time} FROM community_profiles pr WHERE ${scope} AND ${COMMUNITY_DEFAULT_ACTIVE_SQL}
      ON CONFLICT(user_id) DO NOTHING`,
    defaultEventSql('profile', 'pr.user_id', '1', 'NULL', 'community_profiles pr', scope, time),
  ];
}

function publicationStatements(scope = 'true', time = DATABASE_NOW_SQL) {
  return [
    `INSERT INTO community_publications(proposal_id, public_id, proposal_revision, body_hash, policy_version,
        requested, author_control_revision, revision, created_at, updated_at)
      SELECT p.id, ${uuidSql}, p.revision, h.body_hash, ${policySql}, 0, COALESCE(m.revision, 1), 1, ${time}, ${time}
      FROM proposals p JOIN proposal_body_revisions h ON h.proposal_id = p.id AND h.body_revision = p.revision
        AND h.body = p.body COLLATE BINARY LEFT JOIN member_access m ON m.user_id = p.user_id
      WHERE ${scope} AND ${COMMUNITY_DEFAULT_ACTIVE_SQL}
      ON CONFLICT(proposal_id) DO UPDATE SET proposal_revision = excluded.proposal_revision, body_hash = excluded.body_hash,
        policy_version = excluded.policy_version, author_control_revision = excluded.author_control_revision,
        revision = community_publications.revision + 1, updated_at = excluded.updated_at
      WHERE community_publications.proposal_revision != excluded.proposal_revision OR community_publications.body_hash != excluded.body_hash`,
    `INSERT INTO community_publication_defaults(proposal_id, policy_version, proposal_revision, created_at, updated_at)
      SELECT p.id, ${policySql}, p.revision, ${time}, ${time} FROM proposals p JOIN community_publications cp ON cp.proposal_id = p.id
      WHERE ${scope} AND ${COMMUNITY_DEFAULT_ACTIVE_SQL}
      ON CONFLICT(proposal_id) DO UPDATE SET proposal_revision = excluded.proposal_revision, updated_at = excluded.updated_at
      WHERE community_publication_defaults.proposal_revision != excluded.proposal_revision`,
    defaultEventSql('publication', 'p.id', 'p.revision', 'cp.revision',
      'proposals p JOIN community_publications cp ON cp.proposal_id = p.id', scope, time),
  ];
}

const choiceSelect = `SELECT kind, target_id, visible, event_id, event_rowid, created_at FROM (
  SELECT 'publication' AS kind, p.id AS target_id, json_extract(e.details_json, '$.requested') AS visible,
    e.id AS event_id, e.rowid AS event_rowid, e.created_at
  FROM community_events e JOIN community_publications cp ON cp.public_id = e.target_id
    JOIN proposals p ON p.id = cp.proposal_id AND p.user_id = e.actor_user_id
  WHERE e.action = 'set_publication' AND json_valid(e.details_json)
    AND json_extract(e.details_json, '$.proposalId') = p.id
    AND json_extract(e.details_json, '$.requested') IN (0, 1)
  UNION ALL
  SELECT 'profile', pr.user_id, json_extract(e.details_json, '$.leaderboardVisible'), e.id, e.rowid, e.created_at
  FROM community_events e JOIN community_profiles pr ON pr.public_id = e.target_id AND pr.user_id = e.actor_user_id
  WHERE e.action = 'set_profile_visibility' AND json_valid(e.details_json)
    AND json_extract(e.details_json, '$.leaderboardVisible') IN (0, 1)
)`;
const choiceUpsert = `ON CONFLICT(kind, target_id) DO UPDATE SET visible = excluded.visible, event_id = excluded.event_id,
  event_rowid = excluded.event_rowid, created_at = excluded.created_at WHERE excluded.event_rowid > community_visibility_choices.event_rowid`;

const immutable = table => [
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'community policy history is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
    BEGIN SELECT RAISE(ABORT, 'community policy history is immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS ${table}_no_replace BEFORE INSERT ON ${table}
    WHEN EXISTS(SELECT 1 FROM ${table} WHERE id = NEW.id${table === 'community_default_events'
    ? ' OR (kind = NEW.kind AND target_id = NEW.target_id AND source_revision = NEW.source_revision)' : ''})
    BEGIN SELECT RAISE(ABORT, 'community policy history cannot be replaced'); END`,
];

export const COMMUNITY_PUBLIC_DEFAULT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS community_public_policy (
    id INTEGER PRIMARY KEY CHECK(id = 1), version TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('inactive', 'active')),
    activated_at INTEGER, service_revision INTEGER
  )`,
  `INSERT INTO community_public_policy(id, version, state) VALUES (1, ${policySql}, 'inactive') ON CONFLICT(id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS community_visibility_choices (
    kind TEXT NOT NULL CHECK(kind IN ('profile', 'publication')), target_id TEXT NOT NULL,
    visible INTEGER NOT NULL CHECK(visible IN (0, 1)), event_id TEXT NOT NULL REFERENCES community_events(id),
    event_rowid INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(kind, target_id)
  )`,
  `CREATE TABLE IF NOT EXISTS community_profile_defaults (
    user_id TEXT PRIMARY KEY REFERENCES users(id), policy_version TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS community_publication_defaults (
    proposal_id TEXT PRIMARY KEY REFERENCES proposals(id), policy_version TEXT NOT NULL, proposal_revision INTEGER NOT NULL CHECK(proposal_revision >= 1),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS community_default_events (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('profile', 'publication')), target_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision >= 1), publication_revision INTEGER,
    policy_version TEXT NOT NULL, basis TEXT NOT NULL CHECK(basis IN ('service_default', 'author_choice')), created_at INTEGER NOT NULL,
    UNIQUE(kind, target_id, source_revision)
  )`,
  ...immutable('community_default_events'),
  `CREATE TABLE IF NOT EXISTS community_policy_transitions (
    id TEXT PRIMARY KEY, policy_version TEXT NOT NULL, service_revision INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`,
  ...immutable('community_policy_transitions'),
  `CREATE TRIGGER IF NOT EXISTS community_visibility_choice AFTER INSERT ON community_events
    WHEN NEW.action IN ('set_publication', 'set_profile_visibility')
    BEGIN INSERT INTO community_visibility_choices(kind, target_id, visible, event_id, event_rowid, created_at)
      ${choiceSelect} WHERE event_id = NEW.id ${choiceUpsert}; END`,
  `CREATE TRIGGER IF NOT EXISTS community_default_profile AFTER INSERT ON community_profiles
    WHEN ${COMMUNITY_DEFAULT_ACTIVE_SQL} BEGIN
      UPDATE community_profiles SET leaderboard_visible = COALESCE((SELECT visible FROM community_visibility_choices c
        WHERE c.kind = 'profile' AND c.target_id = NEW.user_id), 1) WHERE user_id = NEW.user_id;
      ${enrollProfileStatements('pr.user_id = NEW.user_id', 'NEW.created_at').join(';\n')}; END`,
  `CREATE TRIGGER IF NOT EXISTS community_default_user AFTER INSERT ON users WHEN ${COMMUNITY_DEFAULT_ACTIVE_SQL}
    BEGIN ${profileStatements('u.id = NEW.id', 'NEW.created_at').join(';\n')}; END`,
  `CREATE TRIGGER IF NOT EXISTS community_default_body AFTER INSERT ON proposal_body_revisions
    WHEN ${COMMUNITY_DEFAULT_ACTIVE_SQL} AND EXISTS(SELECT 1 FROM proposals p WHERE p.id = NEW.proposal_id
      AND p.revision = NEW.body_revision AND p.body = NEW.body COLLATE BINARY)
    BEGIN ${[...profileStatements('u.id = (SELECT user_id FROM proposals WHERE id = NEW.proposal_id)', 'NEW.created_at'),
      ...publicationStatements('p.id = NEW.proposal_id', 'NEW.created_at')].join(';\n')}; END`,
  // Old and new deployed writers share the same cap during promotion/rollback.
  // Review-state changes must not make legacy clients see reusable vote slots.
  ...['INSERT', 'UPDATE'].map(operation => `CREATE TRIGGER IF NOT EXISTS community_default_vote_${operation.toLowerCase()}_cap
    BEFORE ${operation} ON community_votes WHEN ${COMMUNITY_DEFAULT_ACTIVE_SQL} AND NEW.direction IN ('up', 'down')
    BEGIN SELECT RAISE(ABORT, 'community vote quota exceeded') WHERE
      (WITH ${PUBLIC_PUBLICATIONS_SQL}, ${PUBLIC_VOTES_SQL} SELECT COUNT(*) FROM valid_votes
        WHERE user_id = NEW.user_id AND round_id = NEW.round_id AND public_id != NEW.public_id) >= ${COMMUNITY_VOTE_LIMIT}; END`),
  `INSERT INTO community_meta(key, value) VALUES ('public_defaults_schema_version', 1) ON CONFLICT(key) DO NOTHING`,
];

export async function assertCommunityPublicDefaults(client) {
  try {
    const row = (await client.execute(`SELECT ${COMMUNITY_DEFAULT_READY_SQL} AS ready`)).rows[0];
    if (Number(row?.ready) !== 1) throw new Error('Public defaults unavailable');
  } catch {
    throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Community storage is temporarily unavailable.');
  }
}

export async function activateCommunityPublicDefaults(client, { expectedServiceRevision, databaseClockSql = DATABASE_NOW_SQL } = {}) {
  if (!Number.isSafeInteger(expectedServiceRevision) || expectedServiceRevision < 1) {
    throw new ApiError(422, 'INVALID_ADMIN_INPUT', 'An exact service revision is required.');
  }
  const preparedSql = `((SELECT version FROM community_public_policy WHERE id = 1) = ${policySql}
    AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN
      (${COMMUNITY_DEFAULT_TRIGGER_NAMES.map(name => `'${name}'`).join(',')})) = ${COMMUNITY_DEFAULT_TRIGGER_NAMES.length})`;
  const historySql = `NOT EXISTS(SELECT 1 FROM proposals original WHERE NOT EXISTS(SELECT 1 FROM proposal_body_revisions archive
    WHERE archive.proposal_id = original.id AND archive.body_revision = original.revision AND archive.body = original.body COLLATE BINARY))`;
  const allowed = `(${preparedSql} AND ${historySql} AND EXISTS(SELECT 1 FROM service_control
    WHERE id = 1 AND mode = 'active' AND proposals_enabled = 1 AND development_enabled = 1 AND revision = ${expectedServiceRevision}))`;
  const countSql = `SELECT (SELECT COUNT(*) FROM community_profiles) AS profiles,
    (SELECT COUNT(*) FROM community_publications) AS publications, (SELECT COUNT(*) FROM community_default_events) AS events`;
  // A single write batch also works with an in-memory libSQL client. Every
  // mutation carries the same gate; failed preconditions leave all rows intact.
  const statements = [
      `SELECT *, ${preparedSql} AS prepared, ${historySql} AS history_ready FROM service_control WHERE id = 1`, countSql,
      `INSERT INTO community_visibility_choices(kind, target_id, visible, event_id, event_rowid, created_at)
        ${choiceSelect} WHERE ${allowed} ORDER BY event_rowid ${choiceUpsert}`,
      `UPDATE community_public_policy SET state = 'active', activated_at = COALESCE(activated_at, ${databaseClockSql}),
        service_revision = COALESCE(service_revision, ${expectedServiceRevision}) WHERE id = 1 AND ${allowed}`,
      ...profileStatements(allowed, databaseClockSql),
      `UPDATE community_profiles SET leaderboard_visible = COALESCE((SELECT visible FROM community_visibility_choices c
          WHERE c.kind = 'profile' AND c.target_id = community_profiles.user_id), 1), revision = revision + 1, updated_at = ${databaseClockSql}
        WHERE ${allowed} AND leaderboard_visible != COALESCE((SELECT visible FROM community_visibility_choices c
          WHERE c.kind = 'profile' AND c.target_id = community_profiles.user_id), 1)`,
      ...enrollProfileStatements(allowed, databaseClockSql),
      ...publicationStatements(allowed, databaseClockSql),
      `INSERT INTO community_policy_transitions(id, policy_version, service_revision, created_at)
        SELECT '${PUBLICATION_POLICY_VERSION}:activation', ${policySql}, ${expectedServiceRevision}, ${databaseClockSql}
        WHERE ${allowed} AND NOT EXISTS(SELECT 1 FROM community_policy_transitions WHERE id = '${PUBLICATION_POLICY_VERSION}:activation')`,
      countSql,
  ];
  const results = await client.batch(statements, 'write');
  const service = results[0].rows[0];
  if (!service || Number(service.revision) !== expectedServiceRevision) {
    throw new ApiError(409, 'REVISION_CONFLICT', 'Service controls changed before activation.');
  }
  if (service.mode !== 'active' || Number(service.proposals_enabled) !== 1 || Number(service.development_enabled) !== 1) {
    throw new ApiError(409, 'PROPOSALS_PAUSED', 'Activation requires active participation and development.');
  }
  if (Number(service.prepared) !== 1) throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Prepare the public policy schema before activation.');
  if (Number(service.history_ready) !== 1) throw new ApiError(503, 'SAFETY_HISTORY_UNAVAILABLE', 'Preserve existing body history before activation.');
  const before = results[1].rows[0];
  const after = results.at(-1).rows[0];
  return { policyVersion: PUBLICATION_POLICY_VERSION, active: true, serviceRevision: expectedServiceRevision,
    profilesAdded: Number(after.profiles) - Number(before.profiles), publicationsAdded: Number(after.publications) - Number(before.publications),
    defaultEventsAdded: Number(after.events) - Number(before.events) };
}
