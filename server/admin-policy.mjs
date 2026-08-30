import { ApiError } from './errors.mjs';

export const ADMIN_EMAIL = 'hso1025@gmail.com';
export const ADMIN_AUTH_MAX_AGE_MS = 15 * 60 * 1000;
export const SERVICE_MODES = ['active', 'maintenance', 'ended'];

export function normalizedEmail(value) {
  // Never turn dot/plus aliases or surrounding whitespace into administrator credentials.
  return typeof value === 'string' && value.length <= 320
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.isWellFormed()
    ? value.toLowerCase() : null;
}

export function serviceView(row, { publicOnly = false } = {}) {
  if (!row || !SERVICE_MODES.includes(row.mode)) {
    throw new ApiError(503, 'ADMIN_SCHEMA_UNAVAILABLE', '운영 상태를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
  }
  return {
    mode: row.mode,
    proposalsEnabled: Number(row.proposals_enabled) === 1,
    developmentEnabled: Number(row.development_enabled) === 1,
    message: row.message,
    ...(!publicOnly ? { revision: Number(row.revision), updatedAt: new Date(Number(row.updated_at)).toISOString() } : {}),
  };
}

export function publicService(service) {
  const { mode, proposalsEnabled, developmentEnabled, message } = service;
  return { mode, proposalsEnabled, developmentEnabled, message };
}

export function proposalsAllowed(service) {
  return service.mode === 'active' && service.proposalsEnabled;
}

export function assertProposalAccess(row) {
  if (!row || !row.mode) {
    throw new ApiError(503, 'ADMIN_SCHEMA_UNAVAILABLE', '운영 상태를 확인할 수 없습니다.');
  }
  if (!row.user_exists) throw new ApiError(401, 'LOGIN_REQUIRED', '로그인 상태를 다시 확인해 주세요.');
  if (row.member_status === 'suspended') {
    throw new ApiError(403, 'USER_SUSPENDED', '이 계정은 이용이 정지되어 제안을 제출하거나 수정할 수 없습니다.');
  }
  if (row.mode === 'ended') throw new ApiError(409, 'SERVICE_ENDED', '서비스가 종료되어 제안을 제출하거나 수정할 수 없습니다.');
  if (row.mode === 'maintenance') throw new ApiError(409, 'SERVICE_MAINTENANCE', '점검 중에는 제안을 제출하거나 수정할 수 없습니다. 입력 내용은 보관됩니다.');
  if (Number(row.proposals_enabled) !== 1) throw new ApiError(409, 'PROPOSALS_PAUSED', '현재 제안 접수가 일시 중지되어 있습니다. 입력 내용은 보관됩니다.');
}

export const PROPOSAL_ACCESS_SQL = `EXISTS (SELECT 1 FROM service_control WHERE id = 1 AND mode = 'active' AND proposals_enabled = 1)
  AND EXISTS (SELECT 1 FROM users WHERE id = ?)
  AND NOT EXISTS (SELECT 1 FROM member_access WHERE user_id = ? AND status = 'suspended')`;

export function proposalAccessStatement(userId) {
  return {
    sql: `SELECT s.*, EXISTS(SELECT 1 FROM users WHERE id = ?) AS user_exists,
      COALESCE((SELECT status FROM member_access WHERE user_id = ?), 'active') AS member_status
      FROM service_control s WHERE id = 1`,
    args: [userId, userId],
  };
}
