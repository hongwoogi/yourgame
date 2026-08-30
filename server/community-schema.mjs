import { ApiError } from './errors.mjs';
import { DATABASE_NOW_SQL } from './database-clock.mjs';
import { INITIAL_CUTOFF } from './config.mjs';

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
      (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (
        'community_profile_identity_immutable', 'community_publication_identity_immutable',
        'community_events_no_update', 'community_events_no_delete', 'community_events_no_replace',
        'community_requests_no_update', 'community_requests_no_delete', 'community_requests_no_replace')) AS immutable_triggers`);
    if (Number(result.rows[0]?.version) !== COMMUNITY_SCHEMA_VERSION || Number(result.rows[0]?.immutable_triggers) !== 8) {
      throw new Error('Incomplete community storage.');
    }
  } catch {
    throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Community storage is temporarily unavailable.');
  }
}
