import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ANONYMOUS_SESSION_MS, GOOGLE_NONCE_MS, INITIAL_CUTOFF, LOGIN_SESSION_MS,
  MAX_BYTES, SESSION_CREATION_LIMIT, SESSION_CREATION_WINDOW_MS, SUBMISSION_LIMIT, WINDOW_MS,
} from './config.mjs';
import { ApiError } from './errors.mjs';
import { checkSchema, writeBatch } from './database.mjs';
import { checkAdminSchema } from './admin-schema.mjs';
import { createAdminStore } from './admin-store.mjs';
import {
  ADMIN_EMAIL, normalizedEmail, PROPOSAL_ACCESS_SQL, assertProposalAccess, proposalAccessStatement,
} from './admin-policy.mjs';
import { DATABASE_NOW_SQL } from './database-clock.mjs';
import { pendingProposalClosesAt, pendingProposalClosesAtSql } from './daily-schedule.mjs';
import { checkSafetySchema } from './safety-schema.mjs';
import { checkCommunitySchema, assertCommunityPublicDefaults } from './community-schema.mjs';
import { COMMUNITY_DEFAULT_READY_SQL } from './community-policy.mjs';
import { createCommunityStore } from './community-store.mjs';
import { checkContributionSchema } from './contribution-schema.mjs';
import { createContributionStore } from './contribution-store.mjs';
import { createGamePublicationStore } from './game-publication-store.mjs';
import {
  EDIT_REVIEW_COOLDOWN_MS, PROPOSAL_ATTEMPT_LIMIT, PROPOSAL_ATTEMPT_WINDOW_MS,
} from './safety-policy.mjs';
import { SAFETY_COLUMNS, SAFETY_JOINS, pendingSafetyStatements, safetyView } from './safety-store.mjs';

export { DATABASE_NOW_SQL } from './database-clock.mjs';

export const hashValue = value => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const cleanupSessions = time => ({
  sql: `DELETE FROM sessions WHERE token_hash IN
    (SELECT token_hash FROM sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`,
  args: [time],
});

export function validateBody(body) {
  if (typeof body !== 'string' || !body.trim() || !body.isWellFormed()) {
    throw new ApiError(422, 'INVALID_BODY', '내용이 있는 올바른 제안을 입력해 주세요.');
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
    throw new ApiError(413, 'BODY_TOO_LARGE', '제안은 UTF-8 기준 2,000바이트까지 입력할 수 있습니다.');
  }
  return body;
}

function proposalView(row, now) {
  const closesAt = row.round_id === 'pending' ? pendingProposalClosesAt(Number(row.created_at))
    : row.round_id === 'initial' ? INITIAL_CUTOFF : null;
  return {
    id: row.id,
    body: row.body,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    roundId: row.round_id,
    closesAt: closesAt === null ? null : new Date(closesAt).toISOString(),
    editable: closesAt !== null && now < closesAt,
    revision: Number(row.revision),
    safety: safetyView(row),
  };
}

function quotaStatement(userId, databaseClockSql) {
  return {
    sql: `WITH clock AS (SELECT ${databaseClockSql} AS now_ms)
      SELECT COUNT(p.id) AS used, MIN(p.created_at) AS oldest, clock.now_ms
      FROM clock LEFT JOIN proposals p ON p.user_id = ?
        AND p.created_at > clock.now_ms - ? AND p.created_at <= clock.now_ms
      GROUP BY clock.now_ms`,
    args: [userId, WINDOW_MS],
  };
}

function quotaView(result) {
  const used = Number(result.rows[0]?.used ?? 0);
  const remaining = Math.max(0, SUBMISSION_LIMIT - used);
  return {
    remaining,
    limit: SUBMISSION_LIMIT,
    nextAvailableAt: remaining === 0 && result.rows[0]?.oldest != null
      ? new Date(Number(result.rows[0].oldest) + WINDOW_MS).toISOString() : null,
  };
}

function sessionView(row) {
  if (!row) return null;
  return {
    tokenHash: row.token_hash,
    csrfToken: row.csrf_token,
    googleNonce: row.google_nonce,
    nonceExpiresAt: Number(row.nonce_expires_at),
    expiresAt: Number(row.expires_at),
    user: row.user_id ? { id: row.user_id, name: row.name, isAdmin: Number(row.is_admin) === 1 } : null,
  };
}

const sessionSql = `SELECT s.*, u.name,
  CASE WHEN a.email_verified = 1 AND a.email = '${ADMIN_EMAIL}' AND i.user_id IS NOT NULL THEN 1 ELSE 0 END AS is_admin
  FROM sessions s LEFT JOIN users u ON u.id = s.user_id
  LEFT JOIN session_auth a ON a.token_hash = s.token_hash
  LEFT JOIN admin_identity i ON i.id = 1 AND i.user_id = u.id AND i.google_sub = u.google_sub
  WHERE s.token_hash = ? AND s.expires_at > ?
    AND NOT EXISTS (SELECT 1 FROM member_access m WHERE m.user_id = s.user_id AND m.status = 'suspended')`;

export function createStore(client, { now = Date.now, databaseClockSql = DATABASE_NOW_SQL } = {}) {
  const admin = createAdminStore(client, { now, databaseClockSql });
  return {
    admin,
    community: createCommunityStore(client, { databaseClockSql }),
    contribution: createContributionStore(client, { databaseClockSql }),
    getService: admin.getService,
    getPublicGame: availableVersions => createGamePublicationStore(client).getPublicGame(availableVersions),
    async health() {
      await checkSchema(client);
      await checkAdminSchema(client);
      await checkSafetySchema(client);
      await checkCommunitySchema(client);
      await assertCommunityPublicDefaults(client);
      await checkContributionSchema(client);
      return 'ok';
    },

    async getSession(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const result = await client.execute({ sql: sessionSql, args: [hashValue(token), now()] });
      return sessionView(result.rows[0]);
    },

    async createAnonymousSession(clientFingerprint = 'unknown') {
      const time = now();
      const token = randomToken();
      const tokenHash = hashValue(token);
      const csrfToken = randomToken();
      const googleNonce = randomToken();
      const expiresAt = time + ANONYMOUS_SESSION_MS;
      const rateWindow = Math.floor(time / SESSION_CREATION_WINDOW_MS);
      const rateWindowEnd = (rateWindow + 1) * SESSION_CREATION_WINDOW_MS;
      const rateKey = hashValue(`${rateWindow}:${clientFingerprint}`);
      const results = await writeBatch(client, [
        cleanupSessions(time),
        {
          sql: `DELETE FROM session_rate_windows WHERE bucket_key IN
            (SELECT bucket_key FROM session_rate_windows WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`,
          args: [time],
        },
        {
          sql: `INSERT INTO session_rate_windows(bucket_key, used, expires_at) VALUES (?, 1, ?)
            ON CONFLICT(bucket_key) DO UPDATE SET used = used + 1 WHERE used < ?`,
          args: [rateKey, rateWindowEnd, SESSION_CREATION_LIMIT],
        },
        {
          sql: `INSERT INTO sessions(token_hash, user_id, csrf_token, google_nonce,
            nonce_expires_at, created_at, expires_at) SELECT ?, NULL, ?, ?, ?, ?, ? WHERE changes() = 1`,
          args: [tokenHash, csrfToken, googleNonce, time + GOOGLE_NONCE_MS, time, expiresAt],
        },
      ]);
      if (results[3].rowsAffected !== 1) {
        throw new ApiError(429, 'SESSION_RATE_LIMITED', '접속 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', {
          retryAfterSeconds: Math.max(1, Math.ceil((rateWindowEnd - time) / 1000)),
        });
      }
      return {
        token,
        session: { tokenHash, csrfToken, googleNonce, expiresAt, nonceExpiresAt: time + GOOGLE_NONCE_MS, user: null },
      };
    },

    async refreshSessionNonce(session) {
      const time = now();
      if (session.nonceExpiresAt > time) return session;
      const nonce = randomToken();
      const results = await writeBatch(client, [
        {
          sql: `UPDATE sessions SET google_nonce = ?, nonce_expires_at = ?
            WHERE token_hash = ? AND expires_at > ? AND nonce_expires_at <= ?`,
          args: [nonce, time + GOOGLE_NONCE_MS, session.tokenHash, time, time],
        },
        { sql: sessionSql, args: [session.tokenHash, time] },
      ]);
      return sessionView(results[1].rows[0]);
    },

    async completeLogin(session, identity) {
      const time = now();
      if (session.nonceExpiresAt <= time) {
        throw new ApiError(401, 'GOOGLE_NONCE_EXPIRED', '로그인 대기 시간이 지났습니다. Google 로그인을 다시 진행해 주세요.');
      }
      const token = randomToken();
      const tokenHash = hashValue(token);
      const csrfToken = randomToken();
      const googleNonce = randomToken();
      const email = normalizedEmail(identity.email);
      const emailVerified = identity.emailVerified === true && email !== null;
      const oldSessionCondition = `EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?
        AND google_nonce = ? AND expires_at > ${databaseClockSql} AND nonce_expires_at > ${databaseClockSql})
        AND NOT EXISTS (SELECT 1 FROM member_access m JOIN users u ON u.id = m.user_id
          WHERE u.google_sub = ? AND m.status = 'suspended')`;
      const oldSessionArgs = [session.tokenHash, session.googleNonce, identity.googleSub];
      const results = await writeBatch(client, [
        {
          sql: 'SELECT m.status FROM member_access m JOIN users u ON u.id = m.user_id WHERE u.google_sub = ?',
          args: [identity.googleSub],
        },
        {
          sql: `INSERT INTO users(id, google_sub, name, created_at, updated_at)
            SELECT ?, ?, ?, ${databaseClockSql}, ${databaseClockSql} WHERE ${oldSessionCondition}
            ON CONFLICT(google_sub) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
          args: [randomUUID(), identity.googleSub, identity.name, ...oldSessionArgs],
        },
        {
          sql: `INSERT INTO member_access(user_id, email, updated_at)
            SELECT id, ?, ${databaseClockSql} FROM users WHERE google_sub = ? AND ${oldSessionCondition}
            ON CONFLICT(user_id) DO UPDATE SET email = COALESCE(excluded.email, member_access.email)`,
          args: [emailVerified ? email : null, identity.googleSub, ...oldSessionArgs],
        },
        {
          sql: `INSERT INTO sessions(token_hash, user_id, csrf_token, google_nonce,
              nonce_expires_at, created_at, expires_at)
            SELECT ?, users.id, ?, ?, ${databaseClockSql} + ?, ${databaseClockSql}, ${databaseClockSql} + ? FROM users
            WHERE google_sub = ? AND ${oldSessionCondition}`,
          args: [tokenHash, csrfToken, googleNonce, GOOGLE_NONCE_MS, LOGIN_SESSION_MS,
            identity.googleSub, ...oldSessionArgs],
        },
        {
          sql: `INSERT INTO session_auth(token_hash, email, email_verified, authenticated_at)
            SELECT token_hash, ?, ?, ${databaseClockSql} FROM sessions WHERE token_hash = ?`,
          args: [email, Number(emailVerified), tokenHash],
        },
        {
          sql: `INSERT INTO admin_identity(id, user_id, google_sub, created_at)
            SELECT 1, u.id, u.google_sub, ${databaseClockSql} FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND ? = 1 AND ? = ? ON CONFLICT(id) DO NOTHING`,
          args: [tokenHash, Number(emailVerified), email, ADMIN_EMAIL],
        },
        {
          sql: 'DELETE FROM sessions WHERE token_hash = ? AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?)',
          args: [session.tokenHash, tokenHash],
        },
        cleanupSessions(time),
        { sql: sessionSql, args: [tokenHash, time] },
      ]);
      if (results[0].rows[0]?.status === 'suspended') {
        throw new ApiError(403, 'USER_SUSPENDED', '이 계정은 이용이 정지되어 로그인할 수 없습니다.');
      }
      const updated = sessionView(results.at(-1).rows[0]);
      if (!updated) {
        throw new ApiError(409, 'LOGIN_SESSION_CHANGED', '로그인 상태가 변경되었습니다. 새로고침한 뒤 다시 시도해 주세요.');
      }
      return { token, session: updated };
    },

    async logout(session) {
      const time = now();
      const token = randomToken();
      const tokenHash = hashValue(token);
      const csrfToken = randomToken();
      const googleNonce = randomToken();
      const expiresAt = time + ANONYMOUS_SESSION_MS;
      await writeBatch(client, [
        { sql: 'DELETE FROM sessions WHERE token_hash = ?', args: [session.tokenHash] },
        cleanupSessions(time),
        {
          sql: `INSERT INTO sessions(token_hash, user_id, csrf_token, google_nonce,
            nonce_expires_at, created_at, expires_at) VALUES (?, NULL, ?, ?, ?, ?, ?)`,
          args: [tokenHash, csrfToken, googleNonce, time + GOOGLE_NONCE_MS, time, expiresAt],
        },
      ]);
      return {
        token,
        session: { tokenHash, csrfToken, googleNonce, nonceExpiresAt: time + GOOGLE_NONCE_MS, expiresAt, user: null },
      };
    },

    async listProposals(userId) {
      const results = await client.batch([
        {
          sql: `SELECT p.*, ${SAFETY_COLUMNS} FROM proposals p ${SAFETY_JOINS}
            WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id DESC`,
          args: [userId],
        },
        quotaStatement(userId, databaseClockSql),
      ], 'read');
      const time = Number(results[1].rows[0].now_ms);
      return {
        // This is the round's edit lifetime. Temporary operating controls are
        // reported separately and rechecked atomically when saving a change.
        proposals: results[0].rows.map(row => proposalView(row, time)),
        quota: quotaView(results[1]),
        serverTime: new Date(time).toISOString(),
      };
    },

    async createProposal(userId, { body, requestId }) {
      validateBody(body);
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
        throw new ApiError(422, 'INVALID_REQUEST_ID', '접수 요청 식별자가 올바르지 않습니다. 새로고침 후 다시 시도해 주세요.');
      }
      const bodyHash = hashValue(body);
      const proposalId = randomUUID();
      // The quota check and insert share ONE write transaction. Separate
      // read-then-insert queries would let parallel instances exceed the cap.
      const results = await writeBatch(client, [
        {
          sql: `WITH clock AS (SELECT ${databaseClockSql} AS now_ms)
            INSERT INTO proposals(id, user_id, request_id, request_body_hash, body,
              created_at, updated_at, round_id, revision)
            SELECT ?, ?, ?, ?, ?, clock.now_ms, clock.now_ms,
              CASE WHEN clock.now_ms < ? THEN 'initial' ELSE 'pending' END, 1 FROM clock
            WHERE (SELECT COUNT(*) FROM proposals
              WHERE user_id = ? AND created_at > clock.now_ms - ? AND created_at <= clock.now_ms) < ?
              AND ${PROPOSAL_ACCESS_SQL} AND ${COMMUNITY_DEFAULT_READY_SQL}
            ON CONFLICT(user_id, request_id) DO NOTHING`,
          args: [proposalId, userId, requestId, bodyHash, body, INITIAL_CUTOFF,
            userId, WINDOW_MS, SUBMISSION_LIMIT, userId, userId],
        },
        ...pendingSafetyStatements({ proposalId, body, databaseClockSql }),
        { sql: `SELECT p.*, ${SAFETY_COLUMNS} FROM proposals p ${SAFETY_JOINS}
          WHERE p.user_id = ? AND p.request_id = ?`, args: [userId, requestId] },
        quotaStatement(userId, databaseClockSql),
        proposalAccessStatement(userId),
        `SELECT ${COMMUNITY_DEFAULT_READY_SQL} AS ready`,
      ]);
      assertProposalAccess(results[5].rows[0]);
      if (Number(results[6].rows[0]?.ready) !== 1) {
        throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Public participation is temporarily unavailable.');
      }
      const time = Number(results[4].rows[0].now_ms);
      const quota = quotaView(results[4]);
      const row = results[3].rows[0];
      if (row && row.request_body_hash !== bodyHash) {
        throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '같은 접수 요청으로 다른 내용을 전송할 수 없습니다. 목록을 확인한 뒤 다시 작성해 주세요.', { quota });
      }
      if (!row) {
        throw new ApiError(429, 'QUOTA_EXCEEDED', '최근 60분 동안 제안 3개를 모두 제출했습니다. 다음 제출 가능 시각을 확인해 주세요.', { quota });
      }
      return { proposal: proposalView(row, time), quota, created: results[0].rowsAffected === 1 };
    },

    async editProposal(userId, { id, body, revision }) {
      validateBody(body);
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) {
        throw new ApiError(422, 'INVALID_PROPOSAL_ID', '수정할 제안을 확인해 주세요.');
      }
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new ApiError(422, 'INVALID_REVISION', '제안의 최신 내용을 확인한 뒤 다시 수정해 주세요.');
      }
      const results = await writeBatch(client, [
        {
          sql: `WITH clock AS (SELECT ${databaseClockSql} AS now_ms)
            UPDATE proposals SET body = ?, updated_at = MAX(created_at, (SELECT now_ms FROM clock)), revision = revision + 1
            WHERE id = ? AND user_id = ? AND revision = ?
              AND ((round_id = 'pending' AND (SELECT now_ms FROM clock) < ${pendingProposalClosesAtSql()})
                OR (round_id = 'initial' AND (SELECT now_ms FROM clock) < ?))
              AND ${PROPOSAL_ACCESS_SQL} AND ${COMMUNITY_DEFAULT_READY_SQL}
              AND EXISTS (SELECT 1 FROM proposal_body_revisions ph WHERE ph.proposal_id = proposals.id
                AND ph.body_revision = proposals.revision AND ph.body = proposals.body COLLATE BINARY)
              AND NOT EXISTS (SELECT 1 FROM proposal_edit_cooldowns WHERE user_id = ?
                AND last_edit_at > (SELECT now_ms FROM clock) - ?)` ,
          args: [body, id, userId, revision, INITIAL_CUTOFF, userId, userId, userId, EDIT_REVIEW_COOLDOWN_MS],
        },
        ...pendingSafetyStatements({ proposalId: id, body, databaseClockSql }),
        { sql: `INSERT INTO proposal_edit_cooldowns(user_id, last_edit_at)
            SELECT ?, ${databaseClockSql} WHERE changes() = 1
            ON CONFLICT(user_id) DO UPDATE SET last_edit_at = excluded.last_edit_at`, args: [userId] },
        { sql: `SELECT p.*, ${SAFETY_COLUMNS}, sh.proposal_id IS NOT NULL AS history_available
            FROM proposals p ${SAFETY_JOINS} WHERE p.id = ?`, args: [id] },
        quotaStatement(userId, databaseClockSql),
        proposalAccessStatement(userId),
        { sql: 'SELECT last_edit_at FROM proposal_edit_cooldowns WHERE user_id = ?', args: [userId] },
        `SELECT ${COMMUNITY_DEFAULT_READY_SQL} AS ready`,
      ]);
      assertProposalAccess(results[6].rows[0]);
      if (Number(results[8].rows[0]?.ready) !== 1) {
        throw new ApiError(503, 'COMMUNITY_SCHEMA_UNAVAILABLE', 'Public participation is temporarily unavailable.');
      }
      const time = Number(results[5].rows[0].now_ms);
      const row = results[4].rows[0];
      if (!row) throw new ApiError(404, 'PROPOSAL_NOT_FOUND', '제안을 찾을 수 없습니다.');
      if (row.user_id !== userId) throw new ApiError(403, 'NOT_PROPOSAL_OWNER', '본인의 제안만 수정할 수 있습니다.');
      const quota = quotaView(results[5]);
      if (results[0].rowsAffected !== 1) {
        if ((row.round_id === 'initial' && time >= INITIAL_CUTOFF)
          || (row.round_id === 'pending' && time >= pendingProposalClosesAt(Number(row.created_at)))) {
          throw new ApiError(409, 'ROUND_CLOSED', '이 제안의 모집이 마감되어 수정할 수 없습니다.', { quota });
        }
        if (Number(row.revision) === revision && Number(row.history_available) !== 1) {
          throw new ApiError(503, 'SAFETY_HISTORY_UNAVAILABLE', '기존 본문의 보존 상태를 확인해야 하므로 지금은 수정할 수 없습니다. 작성한 내용을 유지해 주세요.');
        }
        const nextEditAt = Number(results[7].rows[0]?.last_edit_at || 0) + EDIT_REVIEW_COOLDOWN_MS;
        if (Number(row.revision) === revision && time < nextEditAt) {
          throw new ApiError(429, 'EDIT_RATE_LIMITED', '수정 검토 요청이 잦습니다. 잠시 후 다시 저장해 주세요.', {
            quota, retryAfterSeconds: Math.max(1, Math.ceil((nextEditAt - time) / 1000)),
          });
        }
        throw new ApiError(409, 'REVISION_CONFLICT', '다른 곳에서 수정된 제안입니다. 최신 내용을 확인한 뒤 다시 수정해 주세요.', { quota });
      }
      return { proposal: proposalView(row, time), quota };
    },

    async recordProposalAttempt(userId, tokenHash) {
      const validSession = `EXISTS(SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ${databaseClockSql})`;
      const results = await writeBatch(client, [
        { sql: `DELETE FROM proposal_attempt_windows WHERE (user_id, window_start) IN
            (SELECT user_id, window_start FROM proposal_attempt_windows WHERE expires_at <= ${databaseClockSql}
              ORDER BY expires_at LIMIT 100)`, args: [] },
        { sql: `WITH clock AS (SELECT ${databaseClockSql} AS now_ms)
            INSERT INTO proposal_attempt_windows(user_id, window_start, used, expires_at)
            SELECT ?, (clock.now_ms / ?) * ?, 1, ((clock.now_ms / ?) + 1) * ? FROM clock
            WHERE ${validSession} AND NOT EXISTS(SELECT 1 FROM member_access WHERE user_id = ? AND status = 'suspended')
            ON CONFLICT(user_id, window_start) DO UPDATE SET used = used + 1 WHERE used < ?`,
          args: [userId, PROPOSAL_ATTEMPT_WINDOW_MS, PROPOSAL_ATTEMPT_WINDOW_MS, PROPOSAL_ATTEMPT_WINDOW_MS,
            PROPOSAL_ATTEMPT_WINDOW_MS, tokenHash, userId, userId, PROPOSAL_ATTEMPT_LIMIT] },
        { sql: `SELECT ${validSession} AS live, ${databaseClockSql} AS now_ms`, args: [tokenHash, userId] },
        proposalAccessStatement(userId),
      ]);
      assertProposalAccess(results[3].rows[0]);
      if (Number(results[2].rows[0].live) !== 1) throw new ApiError(401, 'LOGIN_REQUIRED', '로그인 상태를 다시 확인해 주세요.');
      if (results[1].rowsAffected !== 1) {
        const time = Number(results[2].rows[0].now_ms);
        const next = (Math.floor(time / PROPOSAL_ATTEMPT_WINDOW_MS) + 1) * PROPOSAL_ATTEMPT_WINDOW_MS;
        throw new ApiError(429, 'PROPOSAL_ATTEMPT_RATE_LIMITED', '요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.', {
          retryAfterSeconds: Math.max(1, Math.ceil((next - time) / 1000)),
        });
      }
    },
  };
}
