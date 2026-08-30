import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { writeBatch } from './database.mjs';
import { DATABASE_NOW_SQL } from './database-clock.mjs';
import { ADMIN_AUTH_MAX_AGE_MS, ADMIN_EMAIL, SERVICE_MODES, serviceView } from './admin-policy.mjs';
import { INITIAL_CUTOFF } from './config.mjs';

export const INITIAL_RUN_ID = 'initial-round-2026-09-01';

const hash = value => createHash('sha256').update(value).digest('hex');
const iso = value => new Date(Number(value)).toISOString();
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const RUN_STATUSES = ['queued', 'running', 'failed', 'completed', 'cancelled'];
const MODERATION = ['pending', 'reviewed', 'excluded'];
const FIELDS = {
  set_user_status: ['userId', 'status', 'revision'],
  moderate_proposal: ['proposalId', 'moderation', 'revision'],
  create_version: ['label', 'summary'],
  retry_version: ['versionId', 'revision'],
  cancel_version: ['versionId', 'revision'],
  set_service: ['mode', 'proposalsEnabled', 'developmentEnabled', 'message', 'revision', 'confirmation'],
};

function invalid(message = '관리 요청의 입력 값을 확인해 주세요.') {
  return new ApiError(422, 'INVALID_ADMIN_INPUT', message);
}

function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw invalid('요청 대상 식별자를 확인해 주세요.');
  return value;
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid('최신 revision을 확인해 주세요.');
  return value;
}

function textValue(value, max, allowEmpty = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || [...value].length > max
      || (!allowEmpty && !value.trim()) || /\u0000/.test(value)) throw invalid();
  return value.trim();
}

function oneOf(value, allowed) {
  if (!allowed.includes(value)) throw invalid();
  return value;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function versionView(row) {
  if (!row) return null;
  return {
    id: row.id, label: row.label, status: row.status, summary: row.summary,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    revision: Number(row.revision), parentId: row.parent_id ?? null,
    cancelRequested: Number(row.cancel_requested) === 1, commitSha: row.commit_sha ?? null,
  };
}

function auditView(row) {
  return { id: row.id, createdAt: iso(row.created_at), action: row.action,
    targetId: row.target_id, reason: row.reason, actorName: row.actor_name };
}

export function eligibleProposalSql(alias = 'p') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new TypeError('Invalid SQL alias');
  return `NOT EXISTS (SELECT 1 FROM proposal_moderation em WHERE em.proposal_id = ${alias}.id AND em.moderation = 'excluded')
    AND NOT EXISTS (SELECT 1 FROM member_access ea WHERE ea.user_id = ${alias}.user_id AND ea.status = 'suspended')`;
}

function validateProposalIds(value) {
  if (!Array.isArray(value) || value.length > 100000) throw invalid('스냅샷 제안 목록을 확인해 주세요.');
  value.forEach(identifier);
  if (new Set(value).size !== value.length) throw invalid('스냅샷 식별자는 중복될 수 없습니다.');
  return value;
}

function workerBlock(service, run, runRequested, snapshot) {
  if (service.mode === 'ended') return 'service_ended';
  if (service.mode === 'maintenance') return 'service_maintenance';
  if (!service.developmentEnabled) return 'development_paused';
  if (runRequested && (!run || run.status !== 'running')) return 'run_not_running';
  if (run?.cancelRequested) return 'cancel_requested';
  if (!snapshot.allEligible) return 'snapshot_ineligible';
  return null;
}

function workerBlocked(reason) {
  return new ApiError(409, 'WORKER_BLOCKED', '운영 상태 또는 중단 요청에 따라 작업을 진행할 수 없습니다.', { blockedReason: reason });
}

export function createAdminStore(client, { now = Date.now, databaseClockSql = DATABASE_NOW_SQL } = {}) {
  // Every mutation embeds this predicate in the same write batch as its audit
  // and idempotency record. Browser role flags are never an authority source.
  const actorSql = `SELECT u.id, u.name, a.email, a.authenticated_at, ${databaseClockSql} AS now_ms
    FROM sessions s JOIN users u ON u.id = s.user_id
    JOIN session_auth a ON a.token_hash = s.token_hash
    JOIN admin_identity i ON i.id = 1 AND i.user_id = u.id AND i.google_sub = u.google_sub
    WHERE s.token_hash = ? AND s.expires_at > ${databaseClockSql}
      AND a.email_verified = 1 AND a.email = '${ADMIN_EMAIL}'
      AND NOT EXISTS (SELECT 1 FROM member_access m WHERE m.user_id = u.id AND m.status = 'suspended')`;

  function actorStatement(session) {
    return { sql: actorSql, args: [session?.tokenHash || ''] };
  }

  function adminView(row) {
    if (!row) throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 계정만 접근할 수 있습니다.');
    return { id: row.id, name: row.name, email: row.email,
      recentAuthUntil: iso(Number(row.authenticated_at) + ADMIN_AUTH_MAX_AGE_MS) };
  }

  function guard(session, requestId) {
    return {
      sql: `EXISTS (${actorSql}) AND NOT EXISTS
        (SELECT 1 FROM admin_requests WHERE actor_user_id = ? AND request_id = ?)
        AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ?)`,
      args: [session?.tokenHash || '', session?.user?.id || '', requestId, session?.tokenHash || '', session?.user?.id || ''],
    };
  }

  async function getService() {
    const result = await client.execute('SELECT * FROM service_control WHERE id = 1');
    return serviceView(result.rows[0]);
  }

  async function requireAdmin(session) {
    if (!session?.user) throw new ApiError(401, 'LOGIN_REQUIRED', '관리자 계정으로 로그인해 주세요.');
    return adminView((await client.execute(actorStatement(session))).rows[0]);
  }

  function pageOptions(section, input) {
    const q = input.q === undefined ? '' : textValue(input.q, 160, true);
    const status = input.status || '';
    const round = input.round || '';
    const userId = input.userId || '';
    const rawLimit = input.limit === undefined ? 25 : Number(input.limit);
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1) throw invalid('페이지 크기를 확인해 주세요.');
    const limit = Math.min(rawLimit, 50);
    if (status) oneOf(status, section === 'users' ? ['active', 'suspended'] : section === 'proposals' ? MODERATION : section === 'versions' ? RUN_STATUSES : []);
    if (round) oneOf(round, ['initial', 'pending']);
    if (userId) identifier(userId);
    const binding = hash(canonical({ section, q, status, round, userId }));
    let cursor = null;
    if (input.cursor) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw Error();
        cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (cursor.binding !== binding || !Number.isSafeInteger(cursor.time) || cursor.time < 0 || !ID.test(cursor.id)) throw Error();
      } catch { throw invalid('목록 커서가 올바르지 않습니다. 처음부터 다시 조회해 주세요.'); }
    }
    return { q, status, round, userId, limit, cursor, binding };
  }

  async function list(section, input = {}) {
    const page = pageOptions(section, input);
    const filters = [];
    const args = [];
    let sql;
    let alias;
    let view;
    const search = expression => {
      if (!page.q) return;
      filters.push(`${expression} LIKE ? ESCAPE '\\'`);
      args.push(`%${page.q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    };
    if (section === 'users') {
      alias = 'u';
      sql = `SELECT u.*, m.email, COALESCE(m.status, 'active') AS member_status,
        COALESCE(m.revision, 1) AS member_revision, MAX(u.updated_at, COALESCE(m.updated_at, u.updated_at)) AS changed_at,
        EXISTS(SELECT 1 FROM admin_identity i WHERE i.user_id = u.id AND i.google_sub = u.google_sub) AS is_admin,
        (SELECT COUNT(*) FROM proposals p WHERE p.user_id = u.id) AS proposal_count
        FROM users u LEFT JOIN member_access m ON m.user_id = u.id`;
      search("(u.name || ' ' || COALESCE(m.email, '') || ' ' || u.id)");
      if (page.status) { filters.push("COALESCE(m.status, 'active') = ?"); args.push(page.status); }
      view = row => ({ id: row.id, name: row.name, email: row.email ?? null,
        createdAt: iso(row.created_at), updatedAt: iso(row.changed_at), status: row.member_status,
        isAdmin: Number(row.is_admin) === 1, proposalCount: Number(row.proposal_count), revision: Number(row.member_revision) });
    } else if (section === 'proposals') {
      alias = 'p';
      sql = `SELECT p.*, u.name AS user_name, a.email,
        COALESCE(m.moderation, 'pending') AS moderation, COALESCE(m.revision, 1) AS moderation_revision,
        COALESCE(m.reason, '') AS moderation_reason
        FROM proposals p JOIN users u ON u.id = p.user_id
        LEFT JOIN member_access a ON a.user_id = u.id
        LEFT JOIN proposal_moderation m ON m.proposal_id = p.id`;
      search("(p.body || ' ' || u.name || ' ' || COALESCE(a.email, ''))");
      if (page.status) { filters.push("COALESCE(m.moderation, 'pending') = ?"); args.push(page.status); }
      if (page.round) { filters.push('p.round_id = ?'); args.push(page.round); }
      if (page.userId) { filters.push('p.user_id = ?'); args.push(page.userId); }
      view = row => ({ id: row.id, user: { id: row.user_id, name: row.user_name, email: row.email ?? null },
        body: row.body, roundId: row.round_id, createdAt: iso(row.created_at), revision: Number(row.revision),
        moderation: row.moderation, moderationRevision: Number(row.moderation_revision), moderationReason: row.moderation_reason });
    } else if (section === 'versions') {
      alias = 'v';
      sql = 'SELECT v.* FROM development_runs v';
      search("(v.label || ' ' || v.summary)");
      if (page.status) { filters.push('v.status = ?'); args.push(page.status); }
      view = versionView;
    } else if (section === 'audit') {
      alias = 'a';
      sql = 'SELECT a.* FROM admin_audit a';
      search("(a.action || ' ' || a.target_id || ' ' || a.reason || ' ' || a.actor_name)");
      view = auditView;
    } else throw invalid('조회할 관리 항목을 확인해 주세요.');
    if (page.cursor) {
      filters.push(`(${alias}.created_at < ? OR (${alias}.created_at = ? AND ${alias}.id < ?))`);
      args.push(page.cursor.time, page.cursor.time, page.cursor.id);
    }
    if (filters.length) sql += ` WHERE ${filters.join(' AND ')}`;
    sql += ` ORDER BY ${alias}.created_at DESC, ${alias}.id DESC LIMIT ?`;
    args.push(page.limit + 1);
    const result = await client.execute({ sql, args });
    const rows = result.rows.slice(0, page.limit);
    const last = rows.at(-1);
    return { items: rows.map(view), nextCursor: result.rows.length > page.limit && last
      ? Buffer.from(JSON.stringify({ binding: page.binding, time: Number(last.created_at), id: last.id })).toString('base64url') : null };
  }

  async function query(session, input = {}) {
    const admin = await requireAdmin(session);
    const section = input.section || 'overview';
    if (section !== 'overview') return list(section, input);
    const results = await client.batch([
      'SELECT * FROM service_control WHERE id = 1',
      `SELECT (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM member_access WHERE status = 'suspended') AS suspended_users,
        (SELECT COUNT(*) FROM proposals) AS proposals,
        (SELECT COUNT(*) FROM proposal_moderation WHERE moderation = 'excluded') AS excluded_proposals,
        (SELECT COUNT(*) FROM development_runs) AS versions,
        (SELECT COUNT(*) FROM development_runs WHERE status IN ('queued', 'running')) AS pending_versions`,
      'SELECT * FROM admin_audit ORDER BY created_at DESC, id DESC LIMIT 10',
    ], 'read');
    const count = results[1].rows[0];
    return { admin, service: serviceView(results[0].rows[0]), counts: {
      users: Number(count.users), suspendedUsers: Number(count.suspended_users), proposals: Number(count.proposals),
      excludedProposals: Number(count.excluded_proposals), versions: Number(count.versions), pendingVersions: Number(count.pending_versions),
    }, recentAudit: results[2].rows.map(auditView) };
  }

  async function mutate(session, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(FIELDS, input.action)) throw invalid();
    const allowed = new Set(['action', 'requestId', 'reason', ...FIELDS[input.action]]);
    if (Object.keys(input).some(key => !allowed.has(key))) throw invalid('지원하지 않는 관리 요청 필드입니다.');
    const requestId = identifier(input.requestId);
    const reason = textValue(input.reason, 500);
    const action = input.action;
    const payloadHash = hash(canonical(input));
    const auditId = randomUUID();
    const command = guard(session, requestId);
    const common = command.sql;
    let targetId;
    let targetStatement;
    let primary;
    const afterPrimary = [];
    const afterAudit = [];
    let expectedRevision;
    if (action !== 'create_version') expectedRevision = revision(input.revision);

    if (action === 'set_user_status') {
      targetId = identifier(input.userId);
      const status = oneOf(input.status, ['active', 'suspended']);
      targetStatement = { sql: `SELECT u.id, COALESCE(m.revision, 1) AS revision,
        EXISTS(SELECT 1 FROM admin_identity WHERE user_id = u.id) AS is_admin
        FROM users u LEFT JOIN member_access m ON m.user_id = u.id WHERE u.id = ?`, args: [targetId] };
      primary = {
        sql: `INSERT INTO member_access(user_id, email, status, revision, updated_at)
          SELECT u.id, m.email, ?, COALESCE(m.revision, 1) + 1, ${databaseClockSql}
          FROM users u LEFT JOIN member_access m ON m.user_id = u.id
          WHERE u.id = ? AND COALESCE(m.revision, 1) = ? AND ${common}
            AND (? != 'suspended' OR NOT EXISTS (SELECT 1 FROM admin_identity WHERE user_id = u.id))
          ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, revision = excluded.revision, updated_at = excluded.updated_at`,
        args: [status, targetId, expectedRevision, ...command.args, status],
      };
      if (status === 'suspended') afterAudit.push({
        sql: 'DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM admin_audit WHERE id = ?)', args: [targetId, auditId],
      });
    } else if (action === 'moderate_proposal') {
      targetId = identifier(input.proposalId);
      const moderation = oneOf(input.moderation, MODERATION);
      targetStatement = { sql: `SELECT p.id, COALESCE(m.revision, 1) AS revision FROM proposals p
        LEFT JOIN proposal_moderation m ON m.proposal_id = p.id WHERE p.id = ?`, args: [targetId] };
      primary = {
        sql: `INSERT INTO proposal_moderation(proposal_id, moderation, reason, revision, updated_at)
          SELECT p.id, ?, ?, COALESCE(m.revision, 1) + 1, ${databaseClockSql}
          FROM proposals p LEFT JOIN proposal_moderation m ON m.proposal_id = p.id
          WHERE p.id = ? AND COALESCE(m.revision, 1) = ? AND ${common}
          ON CONFLICT(proposal_id) DO UPDATE SET moderation = excluded.moderation, reason = excluded.reason,
            revision = excluded.revision, updated_at = excluded.updated_at`,
        args: [moderation, reason, targetId, expectedRevision, ...command.args],
      };
    } else if (action === 'create_version') {
      targetId = randomUUID();
      targetStatement = { sql: 'SELECT NULL AS id', args: [] };
      primary = {
        sql: `INSERT INTO development_runs(id, label, summary, status, created_at, updated_at, created_by)
          SELECT ?, ?, ?, 'queued', ${databaseClockSql}, ${databaseClockSql}, ? WHERE ${common}`,
        args: [targetId, textValue(input.label, 80), textValue(input.summary, 2000), session?.user?.id || '', ...command.args],
      };
    } else if (action === 'retry_version' || action === 'cancel_version') {
      const sourceId = identifier(input.versionId);
      targetId = action === 'retry_version' ? randomUUID() : sourceId;
      targetStatement = { sql: 'SELECT * FROM development_runs WHERE id = ?', args: [sourceId] };
      if (action === 'retry_version') {
        primary = {
          sql: `UPDATE development_runs SET revision = revision + 1, updated_at = ${databaseClockSql}
            WHERE id = ? AND revision = ? AND status IN ('failed', 'cancelled') AND ${common}
              AND NOT EXISTS (SELECT 1 FROM development_runs child WHERE child.parent_id = development_runs.id
                AND child.status IN ('queued', 'running'))`,
          args: [sourceId, expectedRevision, ...command.args],
        };
        afterPrimary.push({
          sql: `INSERT INTO development_runs(id, label, summary, status, created_at, updated_at, parent_id, created_by)
            SELECT ?, label, summary, 'queued', ${databaseClockSql}, ${databaseClockSql}, id, ?
            FROM development_runs WHERE id = ? AND changes() = 1`,
          args: [targetId, session?.user?.id || '', sourceId],
        });
      } else {
        primary = {
          sql: `UPDATE development_runs SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
            cancel_requested = 1, revision = revision + 1, updated_at = ${databaseClockSql}
            WHERE id = ? AND revision = ? AND status IN ('queued', 'running') AND ${common}`,
          args: [sourceId, expectedRevision, ...command.args],
        };
      }
    } else {
      targetId = 'service';
      const mode = oneOf(input.mode, SERVICE_MODES);
      if (typeof input.proposalsEnabled !== 'boolean' || typeof input.developmentEnabled !== 'boolean') throw invalid();
      const message = textValue(input.message, 1000, true);
      if (input.confirmation !== undefined && typeof input.confirmation !== 'string') throw invalid();
      targetStatement = { sql: 'SELECT * FROM service_control WHERE id = 1', args: [] };
      const noSensitiveTransition = mode === 'ended' ? "mode = 'ended'" : "mode != 'ended'";
      const confirmation = mode === 'ended' ? '서비스 종료' : '서비스 재개';
      primary = {
        sql: `UPDATE service_control SET mode = ?, proposals_enabled = ?, development_enabled = ?, message = ?,
          revision = revision + 1, updated_at = ${databaseClockSql}
          WHERE id = 1 AND revision = ? AND ${common}
            AND (${noSensitiveTransition} OR EXISTS (${actorSql}
              AND a.authenticated_at > ${databaseClockSql} - ${ADMIN_AUTH_MAX_AGE_MS}
              AND a.authenticated_at <= ${databaseClockSql}))
            AND (${noSensitiveTransition} OR ? = ?)`,
        args: [mode, mode === 'ended' ? 0 : Number(input.proposalsEnabled), mode === 'ended' ? 0 : Number(input.developmentEnabled),
          message, expectedRevision, ...command.args, session?.tokenHash || '', input.confirmation || '', confirmation],
      };
      if (mode !== 'active' || !input.developmentEnabled) afterAudit.push({
        sql: `UPDATE development_runs SET cancel_requested = 1, revision = revision + 1, updated_at = ${databaseClockSql}
          WHERE status = 'running' AND cancel_requested = 0 AND EXISTS (SELECT 1 FROM admin_audit WHERE id = ?)`, args: [auditId],
      });
    }

    const lookup = { sql: 'SELECT * FROM admin_requests WHERE actor_user_id = ? AND request_id = ?',
      args: [session?.user?.id || '', requestId] };
    const results = await writeBatch(client, [
      actorStatement(session), lookup, targetStatement, primary, ...afterPrimary,
      {
        sql: `INSERT INTO admin_audit(id, created_at, action, target_id, reason, actor_user_id, actor_name)
          SELECT ?, ${databaseClockSql}, ?, ?, ?, s.user_id, u.name
          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND changes() = 1`,
        args: [auditId, action, targetId, reason, session?.tokenHash || ''],
      },
      ...afterAudit,
      {
        sql: `INSERT INTO admin_requests(actor_user_id, request_id, payload_hash, response_json, created_at)
          SELECT actor_user_id, ?, ?, json_object('ok', json('true'), 'targetId', target_id), created_at
          FROM admin_audit WHERE id = ?`, args: [requestId, payloadHash, auditId],
      },
      lookup,
    ]);
    const actor = results[0].rows[0];
    adminView(actor);
    if (actor.id !== session?.user?.id) throw new ApiError(403, 'ADMIN_REQUIRED', '관리자 세션을 다시 확인해 주세요.');
    const stored = results.at(-1).rows[0];
    if (stored) {
      if (stored.payload_hash !== payloadHash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', '같은 요청 식별자로 다른 작업을 실행할 수 없습니다.');
      return JSON.parse(stored.response_json);
    }
    const target = results[2].rows[0];
    if (action === 'set_user_status' && input.status === 'suspended' && Number(target?.is_admin) === 1) {
      throw new ApiError(403, 'SELF_SUSPEND_FORBIDDEN', '관리자는 자신의 이용을 정지할 수 없습니다.');
    }
    if (action !== 'create_version' && !target) throw new ApiError(404, 'ADMIN_TARGET_NOT_FOUND', '관리 대상을 찾을 수 없습니다.');
    if (action !== 'create_version' && Number(target.revision) !== expectedRevision) {
      throw new ApiError(409, 'REVISION_CONFLICT', '다른 작업으로 내용이 변경되었습니다. 최신 상태를 확인한 뒤 다시 시도해 주세요.');
    }
    if (action === 'set_service') {
      const sensitive = (target.mode === 'ended') !== (input.mode === 'ended');
      if (sensitive && (Number(actor.authenticated_at) + ADMIN_AUTH_MAX_AGE_MS <= Number(actor.now_ms)
          || Number(actor.authenticated_at) > Number(actor.now_ms))) {
        throw new ApiError(403, 'ADMIN_REAUTH_REQUIRED', '서비스 종료·재개 전에는 15분 이내 Google 재로그인이 필요합니다.');
      }
      if (sensitive && input.confirmation !== (input.mode === 'ended' ? '서비스 종료' : '서비스 재개')) {
        throw new ApiError(422, 'CONFIRMATION_REQUIRED', `확인 문구 '${input.mode === 'ended' ? '서비스 종료' : '서비스 재개'}'를 정확히 입력해 주세요.`);
      }
    }
    throw new ApiError(409, 'ADMIN_ACTION_CONFLICT', '현재 상태에서는 이 작업을 실행할 수 없습니다. 최신 상태를 확인해 주세요.');
  }

  async function listEligibleProposals({ roundId, proposalIds } = {}) {
    oneOf(roundId, ['initial', 'pending']);
    if (proposalIds !== undefined) validateProposalIds(proposalIds);
    const result = await client.execute({
      sql: `SELECT p.* FROM proposals p WHERE p.round_id = ? AND ${eligibleProposalSql()}
        ${proposalIds !== undefined ? 'AND p.id IN (SELECT value FROM json_each(?))' : ''}
        ORDER BY p.created_at ASC, p.id ASC`,
      args: [roundId, ...(proposalIds !== undefined ? [JSON.stringify(proposalIds)] : [])],
    });
    return result.rows.map(row => ({ id: row.id, userId: row.user_id, body: row.body, roundId: row.round_id,
      createdAt: iso(row.created_at), updatedAt: iso(row.updated_at), revision: Number(row.revision) }));
  }

  async function readWorkerState({ runId, proposalIds, roundId } = {}) {
    if (runId !== undefined) identifier(runId);
    if (roundId !== undefined) oneOf(roundId, ['initial', 'pending']);
    if (proposalIds !== undefined) validateProposalIds(proposalIds);
    const statements = [
      'SELECT * FROM service_control WHERE id = 1',
      { sql: 'SELECT * FROM development_runs WHERE id = ?', args: [runId || ''] },
    ];
    if (proposalIds !== undefined) statements.push({
      sql: `SELECT COUNT(*) AS eligible FROM proposals p WHERE p.id IN (SELECT value FROM json_each(?))
        AND ${eligibleProposalSql()} ${roundId === undefined ? '' : 'AND p.round_id = ?'}`,
      args: [JSON.stringify(proposalIds), ...(roundId === undefined ? [] : [roundId])],
    });
    const results = await client.batch(statements, 'read');
    const service = serviceView(results[0].rows[0]);
    const run = versionView(results[1].rows[0]);
    const requestedCount = proposalIds?.length || 0;
    const eligibleCount = proposalIds === undefined ? 0 : Number(results[2].rows[0].eligible);
    const snapshot = { checked: proposalIds !== undefined, allEligible: requestedCount === eligibleCount, requestedCount, eligibleCount };
    const blockedReason = workerBlock(service, run, runId !== undefined, snapshot);
    return { service, run, allowed: blockedReason === null, blockedReason, snapshot };
  }

  async function claimRun({ id, revision: expectedRevision, workerId }) {
    identifier(id); revision(expectedRevision); identifier(workerId);
    const auditId = randomUUID();
    const results = await writeBatch(client, [
      'SELECT * FROM service_control WHERE id = 1',
      { sql: 'SELECT * FROM development_runs WHERE id = ?', args: [id] },
      {
        sql: `UPDATE development_runs SET status = 'running', worker_id = ?, updated_at = ${databaseClockSql}, revision = revision + 1
          WHERE id = ? AND revision = ? AND status = 'queued' AND cancel_requested = 0
            AND EXISTS (SELECT 1 FROM service_control WHERE id = 1 AND mode = 'active' AND development_enabled = 1)`,
        args: [workerId, id, expectedRevision],
      },
      {
        sql: `INSERT INTO admin_audit(id, created_at, action, target_id, reason, actor_name)
          SELECT ?, ${databaseClockSql}, 'worker_claim', ?, '작업자가 개발 요청 실행을 시작했습니다.', '작업자' WHERE changes() = 1`, args: [auditId, id],
      },
      { sql: 'SELECT * FROM development_runs WHERE id = ?', args: [id] },
    ]);
    const service = serviceView(results[0].rows[0]);
    if (results[2].rowsAffected === 1) return versionView(results[4].rows[0]);
    const block = workerBlock(service, null, false, { allEligible: true });
    if (block) throw workerBlocked(block);
    if (!results[1].rows[0]) throw new ApiError(404, 'RUN_NOT_FOUND', '개발 요청을 찾을 수 없습니다.');
    throw new ApiError(409, 'REVISION_CONFLICT', '개발 요청을 다른 작업자가 가져갔거나 상태가 변경되었습니다.');
  }

  async function updateRun({ id, revision: expectedRevision, workerId, status, summary, commitSha,
    proposalIds, roundId, serviceRevision }) {
    identifier(id); revision(expectedRevision); identifier(workerId);
    oneOf(status, ['running', 'failed', 'completed', 'cancelled']);
    if (summary !== undefined) summary = textValue(summary, 2000);
    if (commitSha !== undefined && commitSha !== null && (typeof commitSha !== 'string' || !/^[a-f0-9]{7,64}$/i.test(commitSha))) throw invalid('커밋 식별자를 확인해 주세요.');
    const terminalStop = ['failed', 'cancelled'].includes(status);
    if (proposalIds !== undefined) validateProposalIds(proposalIds);
    if (roundId !== undefined) oneOf(roundId, ['initial', 'pending']);
    if (serviceRevision !== undefined) revision(serviceRevision);
    const snapshotCheck = proposalIds === undefined ? '' : `AND (SELECT COUNT(*) FROM proposals p
      WHERE p.id IN (SELECT value FROM json_each(?)) AND ${eligibleProposalSql()}
      ${roundId === undefined ? '' : 'AND p.round_id = ?'}) = ?`;
    const snapshotArgs = proposalIds === undefined ? [] : [JSON.stringify(proposalIds), ...(roundId === undefined ? [] : [roundId]), proposalIds.length];
    const auditId = randomUUID();
    const results = await writeBatch(client, [
      'SELECT * FROM service_control WHERE id = 1',
      { sql: 'SELECT * FROM development_runs WHERE id = ?', args: [id] },
      {
        sql: `UPDATE development_runs SET status = ?, summary = COALESCE(?, summary), commit_sha = COALESCE(?, commit_sha),
          updated_at = ${databaseClockSql}, revision = revision + 1
          WHERE id = ? AND revision = ? AND worker_id = ? AND status = 'running'
            ${terminalStop ? '' : `AND cancel_requested = 0 AND EXISTS
              (SELECT 1 FROM service_control WHERE id = 1 AND mode = 'active' AND development_enabled = 1
                ${serviceRevision === undefined ? '' : 'AND revision = ?'}) ${snapshotCheck}`}`,
        args: [status, summary ?? null, commitSha ?? null, id, expectedRevision, workerId,
          ...(!terminalStop && serviceRevision !== undefined ? [serviceRevision] : []), ...(!terminalStop ? snapshotArgs : [])],
      },
      {
        sql: `INSERT INTO admin_audit(id, created_at, action, target_id, reason, actor_name)
          SELECT ?, ${databaseClockSql}, ?, ?, '작업자가 개발 진행 상태를 기록했습니다. 게임 공개 여부와는 별개입니다.', '작업자' WHERE changes() = 1`,
        args: [auditId, `worker_${status}`, id],
      },
      { sql: 'SELECT * FROM development_runs WHERE id = ?', args: [id] },
    ]);
    if (results[2].rowsAffected === 1) return versionView(results[4].rows[0]);
    const previous = results[1].rows[0];
    if (!previous) throw new ApiError(404, 'RUN_NOT_FOUND', '개발 요청을 찾을 수 없습니다.');
    if (previous.worker_id !== workerId) throw new ApiError(403, 'WORKER_NOT_OWNER', '실행을 가져간 작업자만 상태를 기록할 수 있습니다.');
    if (!terminalStop) {
      const block = workerBlock(serviceView(results[0].rows[0]), versionView(previous), true, { allEligible: true });
      if (block) throw workerBlocked(block);
    }
    throw new ApiError(409, 'REVISION_CONFLICT', '개발 요청이나 운영·스냅샷 상태가 변경되었습니다. 다시 조회한 뒤 기록해 주세요.');
  }

  async function ensureInitialRun({ workerId }) {
    identifier(workerId);
    const auditId = randomUUID();
    const results = await writeBatch(client, [
      { sql: `SELECT *, ${databaseClockSql} AS now_ms FROM service_control WHERE id = 1`, args: [] },
      {
        sql: `INSERT INTO development_runs(id, label, summary, status, created_at, updated_at, created_by)
          SELECT ?, '첫 회차 개발', '승인된 최초 회차의 고정 제안 스냅샷으로 개발을 진행합니다. 검증·공개 완료를 뜻하지 않습니다.',
            'queued', ${databaseClockSql}, ${databaseClockSql}, NULL
          WHERE ${databaseClockSql} >= ? AND EXISTS
            (SELECT 1 FROM service_control WHERE id = 1 AND mode = 'active' AND development_enabled = 1)
          ON CONFLICT(id) DO NOTHING`, args: [INITIAL_RUN_ID, INITIAL_CUTOFF],
      },
      {
        sql: `INSERT INTO admin_audit(id, created_at, action, target_id, reason, actor_name)
          SELECT ?, ${databaseClockSql}, 'worker_enqueue_initial', ?,
            '이미 승인된 최초 회차 개발 요청을 대기 상태로 등록했습니다.', '작업자' WHERE changes() = 1`, args: [auditId, INITIAL_RUN_ID],
      },
      { sql: 'SELECT * FROM development_runs WHERE id = ?', args: [INITIAL_RUN_ID] },
    ]);
    if (results[3].rows[0]) return versionView(results[3].rows[0]);
    const block = workerBlock(serviceView(results[0].rows[0]), null, false, { allEligible: true });
    if (block) throw workerBlocked(block);
    throw new ApiError(409, 'ROUND_NOT_CLOSED', '최초 모집 마감 뒤에 개발 요청을 등록할 수 있습니다.');
  }

  async function listWorkerRuns({ status = 'queued', limit = 50, cursor } = {}) {
    return list('versions', { status, limit, cursor });
  }

  async function retryFailedRun({ id, revision: expectedRevision, workerId }) {
    identifier(id); revision(expectedRevision); identifier(workerId);
    const childId = randomUUID();
    const auditId = randomUUID();
    const results = await writeBatch(client, [
      'SELECT * FROM service_control WHERE id = 1',
      { sql: 'SELECT * FROM development_runs WHERE id = ?', args: [id] },
      {
        sql: `UPDATE development_runs SET revision = revision + 1, updated_at = ${databaseClockSql}
          WHERE id = ? AND revision = ? AND status = 'failed' AND cancel_requested = 0
            AND EXISTS (SELECT 1 FROM service_control WHERE id = 1 AND mode = 'active' AND development_enabled = 1)
            AND NOT EXISTS (SELECT 1 FROM development_runs child WHERE child.parent_id = development_runs.id)`,
        args: [id, expectedRevision],
      },
      {
        sql: `INSERT INTO development_runs(id, label, summary, status, created_at, updated_at, parent_id, created_by)
          SELECT ?, label, summary, 'queued', ${databaseClockSql}, ${databaseClockSql}, id, created_by
          FROM development_runs WHERE id = ? AND changes() = 1`, args: [childId, id],
      },
      {
        sql: `INSERT INTO admin_audit(id, created_at, action, target_id, reason, actor_name)
          SELECT ?, ${databaseClockSql}, 'worker_retry_failed', ?,
            '중단 요청 없는 실패 작업에 대해 승인된 복구 시도를 대기 상태로 등록했습니다.', '작업자' WHERE changes() = 1`, args: [auditId, childId],
      },
      { sql: 'SELECT * FROM development_runs WHERE id = ?', args: [childId] },
    ]);
    if (results[5].rows[0]) return versionView(results[5].rows[0]);
    const service = serviceView(results[0].rows[0]);
    const block = workerBlock(service, null, false, { allEligible: true });
    if (block) throw workerBlocked(block);
    const previous = results[1].rows[0];
    if (!previous) throw new ApiError(404, 'RUN_NOT_FOUND', '개발 요청을 찾을 수 없습니다.');
    if (Number(previous.cancel_requested) === 1 || previous.status === 'cancelled') throw workerBlocked('cancel_requested');
    throw new ApiError(409, 'REVISION_CONFLICT', '실패 작업 상태가 변경되었거나 이미 재시도 요청이 있습니다. 기존 대기 요청을 확인해 주세요.');
  }

  return { getService, requireAdmin, query, mutate, readWorkerState, claimRun, updateRun, listEligibleProposals,
    ensureInitialRun, listWorkerRuns, retryFailedRun };
}
