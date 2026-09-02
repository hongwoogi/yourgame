import { ApiError } from './errors.mjs';
import { DATABASE_NOW_SQL } from './database-clock.mjs';
import { formatHalfPoints, publicContributionPolicy, CONTRIBUTION_ISSUANCE_BLOCK } from './contribution-policy.mjs';
import { profileDisplayAlias } from './community-policy.mjs';
import { ANONYMOUS_USER_ID } from './anonymous-policy.mjs';

// Use exact BigInt aggregation instead of SQLite SUM/REAL or Number arithmetic.
// The trusted issuer checks this bound before adding awards. Crossing it fails
// explicitly instead of returning an approximate leaderboard.
export const MAX_CONTRIBUTION_READ_ROWS = 50000;
const UNITS = /^(?:0|[1-9][0-9]{0,127}|-[1-9][0-9]{0,126})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function unavailable() {
  return new ApiError(503, 'CONTRIBUTION_SCHEMA_UNAVAILABLE', '기여도 기록을 정확하게 확인할 수 없습니다.');
}

function ledgerAmount(row) {
  if (row.points_units == null) return { units: 0n, adopted: 0 };
  if (typeof row.points_units !== 'string' || !UNITS.test(row.points_units)
    || ![0, 1].includes(Number(row.adopted))) throw unavailable();
  return { units: BigInt(row.points_units), adopted: Number(row.adopted) };
}

function boundedRows(result) {
  if (!Array.isArray(result?.rows) || result.rows.length > MAX_CONTRIBUTION_READ_ROWS) throw unavailable();
  return result.rows;
}

function rankRows(result) {
  const people = new Map();
  for (const row of boundedRows(result)) {
    const alias = profileDisplayAlias(row.alias, row.custom_alias);
    if (typeof row.public_id !== 'string' || !UUID.test(row.public_id) || alias === null) throw unavailable();
    if (!people.has(row.public_id)) people.set(row.public_id, { publicId: row.public_id, alias, units: 0n, adoptedCount: 0 });
    const person = people.get(row.public_id);
    const amount = ledgerAmount(row);
    person.units += amount.units;
    person.adoptedCount += amount.adopted;
  }
  const sorted = [...people.values()].sort((left, right) => left.units === right.units
    ? left.publicId < right.publicId ? -1 : left.publicId > right.publicId ? 1 : 0
    : left.units > right.units ? -1 : 1);
  let previousUnits;
  let rank = 0;
  return sorted.map((person, index) => {
    if (person.units !== previousUnits) rank = index + 1;
    previousUnits = person.units;
    return { rank, author: { id: person.publicId, alias: person.alias },
      points: formatHalfPoints(person.units), adoptedCount: person.adoptedCount };
  });
}

function pageLimits(offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ApiError(422, 'INVALID_COMMUNITY_INPUT', 'Check the leaderboard page.');
  }
}

export function createContributionStore(client, { databaseClockSql = DATABASE_NOW_SQL } = {}) {
  const live = `EXISTS(SELECT 1 FROM sessions s LEFT JOIN member_access access ON access.user_id = s.user_id
    WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ${databaseClockSql}
      AND COALESCE(access.status, 'active') = 'active')`;
  const rankingStatement = session => ({
    sql: `SELECT p.public_id, p.alias, pn.alias AS custom_alias, l.points_units, l.adopted
      FROM community_profiles p LEFT JOIN member_access m ON m.user_id = p.user_id
      LEFT JOIN community_profile_names pn ON pn.user_id = p.user_id
      LEFT JOIN contribution_ledger l ON l.user_id = p.user_id
      WHERE p.leaderboard_visible = 1 AND p.user_id != '${ANONYMOUS_USER_ID}'
        AND COALESCE(m.status, 'active') = 'active' ${session ? `AND ${live}` : ''}
      ORDER BY p.public_id, l.created_at, l.id LIMIT ${MAX_CONTRIBUTION_READ_ROWS + 1}`,
    args: session ? [session.tokenHash, session.user.id] : [],
  });
  return {
    async leaderboard({ limit = 10 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new TypeError('Leaderboard limit must be an integer from 1 to 50.');
      const items = rankRows(await client.execute(rankingStatement()));
      return { items: items.slice(0, limit), scoring: publicContributionPolicy() };
    },

    async leaderboardPage({ offset = 0, limit = 20 } = {}) {
      pageLimits(offset, limit);
      // Compute exact totals and global competition ranks before slicing. A
      // display-name change never changes the public-ID tie-breaker or rank.
      const ranked = rankRows(await client.execute(rankingStatement()));
      return { items: ranked.slice(offset, offset + limit), offset, limit, total: ranked.length,
        hasMore: offset < ranked.length && ranked.length - offset > limit };
    },

    async privateSummary(session) {
      if (typeof session?.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(session.tokenHash)
        || typeof session?.user?.id !== 'string' || session.user.id.length > 128) {
        throw new ApiError(401, 'LOGIN_REQUIRED', '기여도를 확인하려면 다시 로그인해 주세요.');
      }
      // Authentication, private totals and every ranking row share a database
      // read transaction. Revoked/expired sessions and suspended members cannot
      // authorize either query; profile visibility affects rank, never points.
      const results = await client.batch([{
        sql: `SELECT s.user_id AS owner_id, p.public_id, l.points_units, l.adopted FROM sessions s
          LEFT JOIN member_access m ON m.user_id = s.user_id
          LEFT JOIN community_profiles p ON p.user_id = s.user_id
          LEFT JOIN contribution_ledger l ON l.user_id = s.user_id
          WHERE s.token_hash = ? AND s.user_id = ? AND s.expires_at > ${databaseClockSql}
            AND COALESCE(m.status, 'active') = 'active'
          ORDER BY l.created_at, l.id LIMIT ${MAX_CONTRIBUTION_READ_ROWS + 1}`,
        args: [session.tokenHash, session.user.id],
      }, rankingStatement(session)], 'read');
      const rows = boundedRows(results[0]);
      if (!rows.length) throw new ApiError(401, 'LOGIN_REQUIRED', '기여도를 확인하려면 다시 로그인해 주세요.');
      let units = 0n;
      let adoptedCount = 0;
      for (const row of rows) {
        const amount = ledgerAmount(row);
        units += amount.units;
        adoptedCount += amount.adopted;
      }
      const ranked = rankRows(results[1]);
      const rank = ranked.find(item => item.author.id === rows[0].public_id)?.rank ?? null;
      return { points: formatHalfPoints(units), adoptedCount, rank };
    },

    async settle() {
      // Deliberately no injectable boolean/JSON certificate/test bypass. Safety
      // approval, a completed task, a plan, a deployment READY status or an admin
      // role cannot replace independent publication and fulfillment evidence.
      // Enabling a reviewed scoring formula will not enable this path either.
      throw new ApiError(409, CONTRIBUTION_ISSUANCE_BLOCK,
        '기여도는 실제 공개와 반영 근거를 검증하는 운영 정산 경로에서만 발행할 수 있습니다.');
    },
  };
}
