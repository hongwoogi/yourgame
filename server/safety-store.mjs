import { createHash, randomUUID } from 'node:crypto';
import { SAFETY_POLICY_VERSION, SAFETY_STATUSES, safetyMessage, screenProposalBody } from './safety-policy.mjs';

export const bodyDigest = value => createHash('sha256').update(value).digest('hex');
export const SAFETY_COLUMNS = `sr.id AS safe_id, sr.status AS safe_status, sr.revision AS safe_revision,
  sr.body_hash AS safe_body_hash, sr.body_revision AS safe_body_revision, sr.policy_version AS safe_policy_version,
  sr.reason AS safe_reason, sr.development_brief AS safe_development_brief,
  sr.development_brief_hash AS safe_development_brief_hash, sr.checklist_confirmed AS safe_checklist,
  sr.reviewed_at AS safe_reviewed_at`;
export const SAFETY_JOINS = `LEFT JOIN proposal_body_revisions sh ON sh.proposal_id = p.id
  AND sh.body_revision = p.revision AND sh.body = p.body COLLATE BINARY
  LEFT JOIN proposal_safety_reviews sr ON sr.proposal_id = p.id AND sr.body_revision = p.revision
    AND sr.body_hash = sh.body_hash AND sr.policy_version = '${SAFETY_POLICY_VERSION}'
    AND EXISTS (SELECT 1 FROM safety_meta WHERE key = 'policy_version' AND value = '${SAFETY_POLICY_VERSION}')`;

export function safetyView(row, { admin = false } = {}) {
  const bodyHash = bodyDigest(row.body);
  const current = row.safe_body_hash === bodyHash && Number(row.safe_body_revision) === Number(row.revision)
    && row.safe_policy_version === SAFETY_POLICY_VERSION;
  const status = current && SAFETY_STATUSES.includes(row.safe_status) ? row.safe_status : 'pending';
  if (!admin) return { status, message: safetyMessage(status) };
  return { status, revision: current ? Number(row.safe_revision) : 1, proposalRevision: Number(row.revision),
    bodyHash, policyVersion: SAFETY_POLICY_VERSION, reviewId: current ? row.safe_id : null,
    reason: current ? row.safe_reason : '', developmentBrief: current ? row.safe_development_brief : '',
    developmentBriefHash: current ? row.safe_development_brief_hash : '', checklistConfirmed: current && Number(row.safe_checklist) === 1,
    reviewedAt: current && row.safe_reviewed_at != null ? new Date(Number(row.safe_reviewed_at)).toISOString() : null,
    hardBlocked: screenProposalBody(row.body).hardBlocked };
}

export function pendingSafetyStatements({ proposalId, body, databaseClockSql }) {
  const hash = bodyDigest(body);
  return [
    { sql: `INSERT INTO proposal_body_revisions(proposal_id, body_revision, body_hash, body, created_at)
        SELECT id, revision, ?, body, ${databaseClockSql} FROM proposals WHERE id = ? AND body = ? AND changes() = 1`,
      args: [hash, proposalId, body] },
    { sql: `INSERT INTO proposal_safety_reviews(id, proposal_id, body_revision, body_hash, policy_version, status, created_at)
        SELECT ?, p.id, p.revision, h.body_hash, ?, 'pending', ${databaseClockSql}
        FROM proposals p JOIN proposal_body_revisions h ON h.proposal_id = p.id AND h.body_revision = p.revision
        WHERE p.id = ? AND changes() = 1`, args: [randomUUID(), SAFETY_POLICY_VERSION, proposalId] },
  ];
}

export function approvedSafetySql(alias = 'p') {
  return `EXISTS (SELECT 1 FROM proposal_safety_reviews ss
    JOIN proposal_body_revisions hh ON hh.proposal_id = ss.proposal_id AND hh.body_revision = ss.body_revision
      AND hh.body_hash = ss.body_hash
    WHERE ss.proposal_id = ${alias}.id AND ss.body_revision = ${alias}.revision AND hh.body = ${alias}.body COLLATE BINARY
      AND ss.policy_version = '${SAFETY_POLICY_VERSION}' AND ss.status = 'approved' AND ss.checklist_confirmed = 1
      AND length(CAST(ss.development_brief AS BLOB)) BETWEEN 1 AND 2000
      AND length(ss.development_brief_hash) = 64
      AND EXISTS (SELECT 1 FROM safety_meta WHERE key = 'policy_version' AND value = '${SAFETY_POLICY_VERSION}'))`;
}

export function safetyBindingsSql(alias = 'p', bindingsAlias = 'binding') {
  return `EXISTS (SELECT 1 FROM proposal_safety_reviews sb
    JOIN proposal_body_revisions hb ON hb.proposal_id = sb.proposal_id AND hb.body_revision = sb.body_revision
      AND hb.body_hash = sb.body_hash
    WHERE sb.proposal_id = ${alias}.id AND sb.body_revision = ${alias}.revision AND hb.body = ${alias}.body COLLATE BINARY
      AND ${alias}.id = json_extract(${bindingsAlias}.value, '$.id')
      AND ${alias}.revision = json_extract(${bindingsAlias}.value, '$.revision')
      AND sb.body_hash = json_extract(${bindingsAlias}.value, '$.bodyHash')
      AND sb.policy_version = json_extract(${bindingsAlias}.value, '$.policyVersion')
      AND sb.id = json_extract(${bindingsAlias}.value, '$.safetyReviewId')
      AND sb.revision = json_extract(${bindingsAlias}.value, '$.safetyRevision')
      AND sb.development_brief_hash = json_extract(${bindingsAlias}.value, '$.developmentBriefHash'))`;
}
