import { ApiError } from './errors.mjs';

export const CONTRIBUTION_SCHEMA_VERSION = 1;
const digest = name => `${name} TEXT NOT NULL CHECK(length(${name}) = 64 AND ${name} NOT GLOB '*[^0-9a-f]*')`;

// Storage constraints preserve an issued record; they are not proof that a game
// was released or a requirement fulfilled. No trusted issuer exists yet and the
// contribution service rejects every settlement. There is no admin award API.
export const CONTRIBUTION_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS contribution_meta(key TEXT PRIMARY KEY, value INTEGER NOT NULL)',
  `CREATE TABLE IF NOT EXISTS contribution_ledger (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
    ${digest('award_key')},
    user_id TEXT NOT NULL REFERENCES users(id),
    requirement_group_id TEXT NOT NULL CHECK(length(requirement_group_id) BETWEEN 1 AND 128),
    fulfillment_id TEXT NOT NULL CHECK(length(fulfillment_id) BETWEEN 1 AND 128),
    release_id TEXT NOT NULL CHECK(length(release_id) BETWEEN 1 AND 128),
    round_id TEXT NOT NULL REFERENCES community_rounds(id),
    contribution_kind TEXT NOT NULL CHECK(contribution_kind IN ('proposer', 'voter')),
    adopted INTEGER NOT NULL CHECK(adopted IN (0, 1)),
    points_units TEXT NOT NULL CHECK(typeof(points_units) = 'text' AND length(points_units) BETWEEN 1 AND 128
      AND (points_units = '0'
        OR (substr(points_units, 1, 1) BETWEEN '1' AND '9' AND points_units NOT GLOB '*[^0-9]*')
        OR (substr(points_units, 1, 1) = '-' AND substr(points_units, 2, 1) BETWEEN '1' AND '9'
          AND substr(points_units, 2) NOT GLOB '*[^0-9]*'))),
    upvotes TEXT NOT NULL CHECK(length(upvotes) BETWEEN 1 AND 19 AND upvotes NOT GLOB '*[^0-9]*'
      AND (upvotes = '0' OR substr(upvotes, 1, 1) BETWEEN '1' AND '9')
      AND (length(upvotes) < 19 OR upvotes <= '9223372036854775807')),
    downvotes TEXT NOT NULL CHECK(length(downvotes) BETWEEN 1 AND 19 AND downvotes NOT GLOB '*[^0-9]*'
      AND (downvotes = '0' OR substr(downvotes, 1, 1) BETWEEN '1' AND '9')
      AND (length(downvotes) < 19 OR downvotes <= '9223372036854775807')),
    scoring_policy_version TEXT NOT NULL CHECK(length(scoring_policy_version) BETWEEN 1 AND 80),
    safety_policy_version TEXT NOT NULL CHECK(length(safety_policy_version) BETWEEN 1 AND 80),
    ${digest('source_digest')}, ${digest('assets_digest')},
    ${digest('release_evidence_digest')}, ${digest('fulfillment_evidence_digest')},
    ${digest('vote_snapshot_digest')}, ${digest('input_bindings_digest')},
    vote_snapshot_at INTEGER NOT NULL CHECK(typeof(vote_snapshot_at) = 'integer' AND vote_snapshot_at >= 0),
    published_at INTEGER NOT NULL CHECK(typeof(published_at) = 'integer' AND published_at >= vote_snapshot_at),
    created_at INTEGER NOT NULL CHECK(typeof(created_at) = 'integer' AND created_at >= published_at),
    UNIQUE(award_key),
    UNIQUE(requirement_group_id, fulfillment_id, user_id),
    UNIQUE(release_id, requirement_group_id, user_id)
  )`,
  'CREATE INDEX IF NOT EXISTS contribution_user_time_idx ON contribution_ledger(user_id, created_at DESC, id DESC)',
  `CREATE TRIGGER IF NOT EXISTS contribution_ledger_no_update BEFORE UPDATE ON contribution_ledger
    BEGIN SELECT RAISE(ABORT, 'contribution records are immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS contribution_ledger_no_delete BEFORE DELETE ON contribution_ledger
    BEGIN SELECT RAISE(ABORT, 'contribution records are immutable'); END`,
  // SQLite REPLACE can delete a conflicting row without its delete trigger
  // when recursive_triggers is off. Reject conflicts before that can happen.
  `CREATE TRIGGER IF NOT EXISTS contribution_ledger_no_replace BEFORE INSERT ON contribution_ledger
    WHEN EXISTS (SELECT 1 FROM contribution_ledger old WHERE old.id = NEW.id OR old.award_key = NEW.award_key
      OR (old.user_id = NEW.user_id AND old.requirement_group_id = NEW.requirement_group_id
        AND (old.fulfillment_id = NEW.fulfillment_id OR old.release_id = NEW.release_id)))
    BEGIN SELECT RAISE(ABORT, 'duplicate contribution records cannot be replaced'); END`,
  { sql: 'INSERT INTO contribution_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
    args: ['schema_version', CONTRIBUTION_SCHEMA_VERSION] },
];

export async function initializeContributionDatabase(client) {
  await client.batch(CONTRIBUTION_SCHEMA, 'write');
  await checkContributionSchema(client);
}

export async function checkContributionSchema(client) {
  try {
    const result = await client.execute(`SELECT
      (SELECT value FROM contribution_meta WHERE key = 'schema_version') AS schema_version,
      (SELECT award_key FROM contribution_ledger LIMIT 1) AS award_check,
      (SELECT points_units FROM contribution_ledger LIMIT 1) AS units_check,
      (SELECT input_bindings_digest FROM contribution_ledger LIMIT 1) AS binding_check,
      (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'
        AND name IN ('contribution_ledger_no_update', 'contribution_ledger_no_delete', 'contribution_ledger_no_replace')) AS immutable_triggers`);
    if (Number(result.rows[0]?.schema_version) !== CONTRIBUTION_SCHEMA_VERSION
      || Number(result.rows[0]?.immutable_triggers) !== 3) throw new Error('Incomplete contribution schema.');
  } catch {
    throw new ApiError(503, 'CONTRIBUTION_SCHEMA_UNAVAILABLE', '기여도 기록 저장소를 확인해야 합니다.');
  }
}
