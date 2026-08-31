import { createHash } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { DATABASE_NOW_SQL } from './database-clock.mjs';
import { COMMUNITY_SCHEMA } from './community-schema.mjs';
import { ADMIN_SCHEMA } from './admin-schema.mjs';
import { PUBLICATION_POLICY_VERSION, COMMUNITY_VOTE_LIMIT } from './community-policy.mjs';

export const MAX_CONTRIBUTION_VOTE_ROWS = 50000;
export const MAX_CONTRIBUTION_INPUTS = 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const ERRORS = {
  history: ['CONTRIBUTION_VOTE_HISTORY_UNAVAILABLE', 'The voting history cannot establish an exact cutoff snapshot.'],
  binding: ['CONTRIBUTION_INPUT_BINDING_MISMATCH', 'The contribution input does not match its stored proposal revision.'],
  round: ['CONTRIBUTION_ROUND_UNAVAILABLE', 'A real, closed contribution round is required.'],
};
const fail = kind => { throw new ApiError(kind === 'history' ? 503 : 409, ...ERRORS[kind]); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const revision = value => integer(value) && value > 0;
const identifier = value => typeof value === 'string' && ID.test(value);
const normalizeSql = value => value.toLowerCase().replace(/\s+/g, '').replaceAll('ifnotexists', '').replace(/;$/, '');
const immutableNames = ['community_events_no_update', 'community_events_no_delete', 'community_events_no_replace',
  'community_requests_no_update', 'community_requests_no_delete', 'community_requests_no_replace',
  'admin_audit_no_update', 'admin_audit_no_delete', 'admin_requests_no_update', 'admin_requests_no_delete'];
const immutableSql = new Map(immutableNames.map(name => [name,
  normalizeSql([...COMMUNITY_SCHEMA, ...ADMIN_SCHEMA].find(statement => typeof statement === 'string' && statement.includes(` ${name} `))),
]));

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const key = (userId, publicId) => `${userId}\0${publicId}`;
const sorted = values => [...values].sort();
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

// Each collection is bounded, and the final compound SELECT has a shared bound.
// One execute() gives both a plain client and an existing transaction one SQLite
// read snapshot. No proposal body/name/session fields or mutations are selected.
// A bounded private moderation reason is used only to recheck its request hash.
function statement(bindings, roundId, clock) {
  const limit = MAX_CONTRIBUTION_VOTE_ROWS + 1;
  const record = (kind, fields, from) => `SELECT '${kind}' AS kind, json_object(${Object.entries(fields)
    .map(([name, expression]) => `'${name}', ${expression}`).join(', ')}) AS value FROM ${from}`;
  return {
    sql: `WITH input_ids AS (SELECT json_extract(value, '$.id') AS id FROM json_each(?)),
      collection AS (SELECT *, ${clock} AS now_ms FROM community_rounds WHERE id = ?),
      votes AS (SELECT * FROM community_votes WHERE round_id = (SELECT id FROM collection)
        ORDER BY user_id, public_id LIMIT ${limit}),
      publications AS (SELECT cp.* FROM community_publications cp WHERE cp.proposal_id IN (SELECT id FROM input_ids)
        OR cp.public_id IN (SELECT public_id FROM votes) ORDER BY cp.proposal_id LIMIT ${limit}),
      proposals_scope AS (SELECT p.id, p.user_id, p.round_id, p.revision, p.created_at, p.updated_at FROM proposals p WHERE p.id IN (SELECT id FROM input_ids)
        OR p.id IN (SELECT proposal_id FROM publications) ORDER BY p.id LIMIT ${limit}),
      people AS (SELECT u.id, u.created_at, m.status, m.revision, m.updated_at FROM users u
        LEFT JOIN member_access m ON m.user_id = u.id
        WHERE u.id IN (SELECT user_id FROM votes UNION SELECT user_id FROM proposals_scope)
        ORDER BY u.id LIMIT ${limit}),
      events AS (SELECT e.rowid AS event_rowid, e.* FROM community_events e WHERE
        (e.action = 'vote' AND (e.target_id IN (SELECT public_id FROM publications)
          OR (CASE WHEN json_valid(e.details_json) THEN json_extract(e.details_json, '$.roundId') END) = (SELECT id FROM collection)))
        OR (e.action = 'set_publication' AND e.target_id IN (SELECT public_id FROM publications))
        ORDER BY e.rowid LIMIT ${limit}),
      receipts AS (SELECT r.* FROM community_requests r WHERE EXISTS (SELECT 1 FROM events e
        WHERE e.actor_user_id = r.user_id AND e.payload_hash = r.payload_hash)
        ORDER BY r.user_id, r.request_id LIMIT ${limit}),
      moderation_history AS (SELECT a.id, a.created_at, a.target_id, a.reason, a.actor_user_id
        FROM admin_audit a WHERE a.action = 'moderate_proposal' AND a.target_id IN (SELECT id FROM proposals_scope)
        ORDER BY a.target_id, a.created_at, a.id LIMIT ${limit}),
      moderation_requests AS (SELECT r.* FROM admin_requests r WHERE EXISTS (SELECT 1 FROM moderation_history a
        WHERE a.actor_user_id = r.actor_user_id AND a.created_at = r.created_at)
        ORDER BY r.actor_user_id, r.request_id LIMIT ${limit})
      ${record('round', { id: 'r.id', proposalRoundId: 'r.proposal_round_id', opensAt: 'r.opens_at',
      cutoff: 'r.closes_at', now: 'r.now_ms', policyVersion: 'policy.version', policyState: 'policy.state',
      policyActivatedAt: 'policy.activated_at' }, 'collection r LEFT JOIN community_public_policy policy ON policy.id = 1')}
      UNION ALL ${record('trigger', { name: 'name', sql: 'sql' },
      `sqlite_master WHERE type = 'trigger' AND name IN (${immutableNames.map(name => `'${name}'`).join(',')})`)}
      UNION ALL ${record('proposal', {
      id: 'p.id', authorId: 'p.user_id', roundId: 'p.round_id', revision: 'p.revision',
      createdAt: 'p.created_at', updatedAt: 'p.updated_at', bodyRevision: 'h.body_revision', bodyHash: 'h.body_hash',
      bodyCreatedAt: 'h.created_at', latestBodyAt: '(SELECT MAX(created_at) FROM proposal_body_revisions WHERE proposal_id = p.id)',
      publicId: 'cp.public_id', publicationRevision: 'cp.revision', publicationProposalRevision: 'cp.proposal_revision',
      publicationBodyHash: 'cp.body_hash', publicationPolicy: 'cp.policy_version',
      publicationCreatedAt: 'cp.created_at', publicationUpdatedAt: 'cp.updated_at',
      defaultRevision: 'pd.proposal_revision', defaultPolicy: 'pd.policy_version', defaultCreatedAt: 'pd.created_at',
      defaultUpdatedAt: 'pd.updated_at', latestDefaultAt: "(SELECT MAX(created_at) FROM community_default_events WHERE kind = 'publication' AND target_id = p.id)",
      profileCreatedAt: 'pr.created_at', visible: 'choice.visible', visibilityEventId: 'choice.event_id',
      visibilityRowid: 'choice.event_rowid', visibilityAt: 'choice.created_at',
      moderation: 'pm.moderation', moderationRevision: 'pm.revision', moderationAt: 'pm.updated_at',
      moderationReason: 'pm.reason',
      latestModerationAt: "(SELECT MAX(created_at) FROM admin_audit WHERE action = 'moderate_proposal' AND target_id = p.id)",
    }, `proposals_scope p LEFT JOIN proposal_body_revisions h ON h.proposal_id = p.id AND h.body_revision = p.revision
        LEFT JOIN publications cp ON cp.proposal_id = p.id
        LEFT JOIN community_publication_defaults pd ON pd.proposal_id = p.id
        LEFT JOIN community_profiles pr ON pr.user_id = p.user_id
        LEFT JOIN community_visibility_choices choice ON choice.kind = 'publication' AND choice.target_id = p.id
        LEFT JOIN proposal_moderation pm ON pm.proposal_id = p.id`)}
      UNION ALL ${record('person', { id: 'u.id', createdAt: 'u.created_at', status: 'u.status', revision: 'u.revision', updatedAt: 'u.updated_at',
      latestControlAt: "(SELECT MAX(created_at) FROM admin_audit WHERE action = 'set_user_status' AND target_id = u.id)" }, 'people u')}
      UNION ALL ${record('vote', { userId: 'user_id', roundId: 'round_id', publicId: 'public_id', direction: 'direction',
      proposalRevision: 'proposal_revision', publicationRevision: 'publication_revision', bodyHash: 'body_hash',
      policyVersion: 'policy_version', safetyReviewId: 'safety_review_id', safetyRevision: 'safety_revision',
      authorControlRevision: 'author_control_revision', voterControlRevision: 'voter_control_revision',
      moderationRevision: 'moderation_revision', revision: 'revision', createdAt: 'created_at', updatedAt: 'updated_at' }, 'votes')}
      UNION ALL ${record('event', { id: 'id', rowid: 'event_rowid', userId: 'actor_user_id', action: 'action', publicId: 'target_id',
      details: 'details_json', payloadHash: 'payload_hash', createdAt: 'created_at' }, 'events')}
      UNION ALL ${record('receipt', { userId: 'user_id', requestId: 'request_id', payloadHash: 'payload_hash',
      response: 'response_json', createdAt: 'created_at' }, 'receipts')}
      UNION ALL ${record('moderationAudit', { id: 'id', proposalId: 'target_id', userId: 'actor_user_id',
      reason: 'reason', createdAt: 'created_at' }, 'moderation_history')}
      UNION ALL ${record('moderationReceipt', { userId: 'actor_user_id', requestId: 'request_id', payloadHash: 'payload_hash',
      response: 'response_json', createdAt: 'created_at' }, 'moderation_requests')}
      LIMIT ${limit}`,
    args: [JSON.stringify(bindings.map(({ id }) => ({ id }))), roundId],
  };
}

function decode(value) {
  if (typeof value !== 'string' || value.length > 16384) fail('history');
  try { return JSON.parse(value); } catch { fail('history'); }
}
function object(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(name => Object.hasOwn(value, name));
}
function unchangedAtCutoff(value, cutoff, optional = false) {
  if (value === null && optional) return;
  if (!integer(value) || value >= cutoff) fail('history');
}
const voteFields = ['roundId', 'direction', 'proposalRevision', 'publicationRevision', 'bodyHash', 'policyVersion',
  'safetyReviewId', 'safetyRevision', 'authorControlRevision', 'voterControlRevision', 'moderationRevision', 'revision'];
function validVoteShape(value) {
  return identifier(value.roundId) && ['up', 'down', 'none'].includes(value.direction) && HASH.test(value.bodyHash || '')
    && identifier(value.policyVersion) && identifier(value.safetyReviewId)
    && ['proposalRevision', 'publicationRevision', 'safetyRevision', 'authorControlRevision',
      'voterControlRevision', 'moderationRevision', 'revision'].every(name => revision(value[name]));
}

function moderationAtCutoff(proposal, audits, receipts, { cutoff, now }) {
  if (proposal.moderation !== null && (!['pending', 'reviewed', 'excluded'].includes(proposal.moderation)
    || !revision(proposal.moderationRevision))) fail('history');
  const changedAfterCutoff = [proposal.moderationAt, proposal.latestModerationAt]
    .some(value => integer(value) && value >= cutoff);
  if (!changedAfterCutoff) {
    unchangedAtCutoff(proposal.moderationAt, cutoff, true);
    unchangedAtCutoff(proposal.latestModerationAt, cutoff, true);
    return { status: proposal.moderation ?? 'pending', revision: proposal.moderationRevision ?? 1, proof: null };
  }
  // Normal moderation starts from the absent/default pending revision 1. Only
  // its first recorded transition has a provable prior state without inventing
  // a general history model. Later transitions/member/visibility changes stay
  // unavailable. The caller still enforces today's selection and safety gates.
  if (proposal.moderationRevision !== 2 || audits.length !== 1 || !integer(proposal.moderationAt)
    || proposal.moderationAt < cutoff || proposal.moderationAt > now) fail('history');
  const audit = audits[0];
  // The primary write and its later audit evaluate the database clock in
  // separate SQL statements. Prove their causal order, not an invented equal
  // millisecond or tolerance window. The request copies the audit time exactly.
  if (!identifier(audit.id) || !identifier(audit.userId) || audit.proposalId !== proposal.id
    || !integer(audit.createdAt) || audit.createdAt < proposal.moderationAt || audit.createdAt > now
    || audit.createdAt !== proposal.latestModerationAt
    || typeof audit.reason !== 'string' || !audit.reason.isWellFormed() || !audit.reason.trim()
    || [...audit.reason].length > 500 || audit.reason.includes('\0') || audit.reason !== proposal.moderationReason) fail('history');
  const matches = receipts.filter(receipt => {
    if (receipt.userId !== audit.userId || receipt.createdAt !== audit.createdAt) return false;
    if (!identifier(receipt.requestId) || !HASH.test(receipt.payloadHash || '')) fail('history');
    const response = decode(receipt.response);
    if (!object(response, ['ok', 'targetId']) || response.ok !== true || response.targetId !== proposal.id) return false;
    // admin.mutate hashes the original input, while storing a trimmed reason.
    // Do not guess omitted whitespace: an unprovable original hash must fail.
    return receipt.payloadHash === digest({ action: 'moderate_proposal', requestId: receipt.requestId,
      reason: audit.reason, proposalId: proposal.id, moderation: proposal.moderation, revision: 1 });
  });
  if (matches.length !== 1) fail('history');
  const receipt = matches[0];
  return { status: 'pending', revision: 1, proof: {
    kind: 'first_moderation_transition', proposalId: proposal.id, auditId: audit.id,
    actorId: audit.userId, requestId: receipt.requestId, payloadHash: receipt.payloadHash,
    changedAt: proposal.moderationAt, auditedAt: audit.createdAt, from: { status: 'pending', revision: 1 },
    to: { status: proposal.moderation, revision: 2 },
  } };
}

// This is a private accounting input, never a public DTO or an issuance gate.
// Safety status is intentionally absent: only the caller validates current game
// approvals; changing a safety review after cutoff cannot erase a valid vote.
export async function readContributionVotes(client, { roundId, bindings, databaseClockSql = DATABASE_NOW_SQL } = {}) {
  try {
    if (!identifier(roundId)) fail('round');
    if (!Array.isArray(bindings) || !bindings.length || bindings.length > MAX_CONTRIBUTION_INPUTS
      || bindings.some(row => !row || !identifier(row.id) || !revision(row.revision) || !HASH.test(row.bodyHash || ''))
      || new Set(bindings.map(row => row.id)).size !== bindings.length) fail('binding');
    // Clock SQL is trusted operator/test configuration, never proposal content.
    if (typeof databaseClockSql !== 'string' || databaseClockSql.length > 512 || /;|--|\/\*|\*\//.test(databaseClockSql)) fail('round');
    const result = await client.execute(statement(bindings, roundId, databaseClockSql));
    if (!Array.isArray(result?.rows) || result.rows.length > MAX_CONTRIBUTION_VOTE_ROWS) fail('history');
    const rows = { round: [], trigger: [], proposal: [], person: [], vote: [], event: [], receipt: [],
      moderationAudit: [], moderationReceipt: [] };
    for (const row of result.rows) {
      if (!Object.hasOwn(rows, row.kind)) fail('history');
      rows[row.kind].push(decode(row.value));
    }
    const round = rows.round[0];
    if (rows.round.length !== 1 || round?.id !== roundId || !identifier(round.proposalRoundId)
      || !integer(round.opensAt) || !integer(round.cutoff) || round.cutoff <= round.opensAt
      || !integer(round.now) || round.now < round.cutoff) fail('round');
    const cutoff = round.cutoff;
    if (round.policyVersion !== PUBLICATION_POLICY_VERSION || round.policyState !== 'active') fail('history');
    unchangedAtCutoff(round.policyActivatedAt, cutoff);
    if (rows.trigger.length !== immutableNames.length || new Set(rows.trigger.map(row => row.name)).size !== immutableNames.length
      || rows.trigger.some(row => !immutableSql.has(row.name)
      || typeof row.sql !== 'string' || normalizeSql(row.sql) !== immutableSql.get(row.name))) fail('history');
    const people = new Map();
    for (const person of rows.person) {
      if (!identifier(person.id) || people.has(person.id)
        || (person.status !== null && !['active', 'suspended'].includes(person.status))
        || (person.status === null) !== (person.revision === null)
        || (person.revision !== null && !revision(person.revision))) fail('history');
      unchangedAtCutoff(person.createdAt, cutoff);
      unchangedAtCutoff(person.updatedAt, cutoff, person.status === null && person.revision === null);
      unchangedAtCutoff(person.latestControlAt, cutoff, true);
      people.set(person.id, { ...person, status: person.status ?? 'active', revision: person.revision ?? 1 });
    }
    const proposals = new Map();
    const byPublicId = new Map();
    const moderationProofs = [];
    for (const proposal of rows.proposal) {
      if (!identifier(proposal.id) || proposals.has(proposal.id) || !people.has(proposal.authorId)
        || !revision(proposal.revision) || proposal.bodyRevision !== proposal.revision || !HASH.test(proposal.bodyHash || '')) fail('history');
      for (const name of ['createdAt', 'updatedAt', 'bodyCreatedAt', 'latestBodyAt']) unchangedAtCutoff(proposal[name], cutoff);
      for (const name of ['visibilityAt', 'latestDefaultAt']) unchangedAtCutoff(proposal[name], cutoff, true);
      const moderation = moderationAtCutoff(proposal, rows.moderationAudit.filter(row => row.proposalId === proposal.id),
        rows.moderationReceipt, round);
      proposal.cutoffModeration = moderation.status;
      proposal.cutoffModerationRevision = moderation.revision;
      if (moderation.proof) moderationProofs.push(moderation.proof);
      if (proposal.publicId !== null) {
        if (!identifier(proposal.publicId) || byPublicId.has(proposal.publicId)
          || !revision(proposal.publicationRevision) || !revision(proposal.publicationProposalRevision)
          || !HASH.test(proposal.publicationBodyHash || '')) fail('history');
        for (const name of ['publicationCreatedAt', 'publicationUpdatedAt']) unchangedAtCutoff(proposal[name], cutoff);
        for (const name of ['defaultCreatedAt', 'defaultUpdatedAt', 'profileCreatedAt']) unchangedAtCutoff(proposal[name], cutoff, true);
        byPublicId.set(proposal.publicId, proposal);
      }
      proposals.set(proposal.id, proposal);
    }
    for (const binding of bindings) {
      const proposal = proposals.get(binding.id);
      if (!proposal || proposal.roundId !== round.proposalRoundId || proposal.revision !== binding.revision || proposal.bodyHash !== binding.bodyHash
        || ['participantId', 'userId', 'authorId'].some(field => Object.hasOwn(binding, field) && binding[field] !== proposal.authorId)) fail('binding');
    }
    const receiptGroups = new Map();
    for (const receipt of rows.receipt) {
      if (!identifier(receipt.userId) || !identifier(receipt.requestId) || !HASH.test(receipt.payloadHash || '')) fail('history');
      unchangedAtCutoff(receipt.createdAt, cutoff);
      const group = key(receipt.userId, receipt.payloadHash);
      if (!receiptGroups.has(group)) receiptGroups.set(group, []);
      receiptGroups.get(group).push(receipt);
    }
    const voteEvents = new Map();
    const visibilityEvents = new Map();
    const eventIds = new Set();
    for (const event of rows.event) {
      if (!identifier(event.id) || eventIds.has(event.id) || !identifier(event.userId) || !identifier(event.publicId)
        || !revision(event.rowid) || !HASH.test(event.payloadHash || '')) fail('history');
      eventIds.add(event.id);
      unchangedAtCutoff(event.createdAt, cutoff);
      const details = decode(event.details);
      let input;
      if (event.action === 'vote') {
        if (!object(details, voteFields) || !validVoteShape(details) || details.roundId !== roundId) fail('history');
        input = { action: 'vote', publicId: event.publicId, roundId, direction: details.direction,
          proposalRevision: details.proposalRevision, publicationRevision: details.publicationRevision };
        const identity = key(event.userId, event.publicId);
        if (!voteEvents.has(identity)) voteEvents.set(identity, []);
        voteEvents.get(identity).push({ ...event, details });
      } else if (event.action === 'set_publication') {
        const proposal = byPublicId.get(event.publicId);
        if (!proposal || !object(details, ['proposalId', 'proposalRevision', 'publicationRevision', 'bodyHash',
          'policyVersion', 'requested', 'authorControlRevision']) || details.proposalId !== proposal.id
          || event.userId !== proposal.authorId || ![0, 1].includes(details.requested)
          || !revision(details.proposalRevision) || !revision(details.publicationRevision)
          || !revision(details.authorControlRevision) || !HASH.test(details.bodyHash || '') || !identifier(details.policyVersion)) fail('history');
        input = { action: 'set_publication', proposalId: proposal.id, proposalRevision: details.proposalRevision,
          publicationRevision: details.publicationRevision - 1, visible: details.requested === 1 };
        const last = visibilityEvents.get(proposal.id);
        if (!last || last.rowid < event.rowid) visibilityEvents.set(proposal.id, { ...event, details });
      } else fail('history');
      const receipts = receiptGroups.get(key(event.userId, event.payloadHash)) || [];
      if (receipts.length !== 1) fail('history');
      const receipt = receipts[0];
      const response = decode(receipt.response);
      if (receipt.createdAt !== event.createdAt || !object(response, ['ok', 'targetId']) || response.ok !== true
        || response.targetId !== event.publicId || digest({ ...input, requestId: receipt.requestId }) !== event.payloadHash) fail('history');
    }
    for (const proposal of proposals.values()) {
      const last = visibilityEvents.get(proposal.id);
      if (proposal.visibilityEventId !== null || last) {
        if (!last || proposal.visibilityEventId !== last.id || proposal.visibilityRowid !== last.rowid
          || proposal.visibilityAt !== last.createdAt || proposal.visible !== last.details.requested
          || last.details.publicationRevision > proposal.publicationRevision) fail('history');
      } else if (proposal.visible !== null || proposal.visibilityAt !== null || proposal.visibilityRowid !== null) fail('history');
    }
    const activeVotes = new Map();
    const seenVotes = new Set();
    const results = new Map(bindings.map(binding => [binding.id, { proposalId: binding.id,
      authorId: proposals.get(binding.id).authorId, upvoterIds: new Set(), downvoterIds: new Set() }]));
    for (const vote of rows.vote) {
      const identity = key(vote.userId, vote.publicId);
      if (!identifier(vote.userId) || !identifier(vote.publicId) || seenVotes.has(identity) || !validVoteShape(vote)
        || vote.roundId !== roundId || !people.has(vote.userId)) fail('history');
      seenVotes.add(identity);
      unchangedAtCutoff(vote.createdAt, cutoff);
      unchangedAtCutoff(vote.updatedAt, cutoff);
      const events = (voteEvents.get(identity) || []).sort((left, right) => left.details.revision - right.details.revision);
      if (!events.length || events.length !== vote.revision || events.some((event, index) => event.details.revision !== index + 1
        || (index > 0 && event.createdAt < events[index - 1].createdAt))) fail('history');
      const last = events.at(-1);
      // The writer timestamps the primary change before the event statement;
      // earlier completed revisions must precede the latest primary change.
      // Event/request identity and times remain exact, and every vote/event
      // must still be before cutoff. No elapsed-time tolerance is guessed.
      if (vote.createdAt > vote.updatedAt || events[0].createdAt < vote.createdAt || last.createdAt < vote.updatedAt
        || events.slice(0, -1).some(event => event.createdAt > vote.updatedAt)
        || voteFields.some(name => last.details[name] !== vote[name])) fail('history');
      const proposal = byPublicId.get(vote.publicId);
      if (!proposal) fail('history');
      const author = people.get(proposal.authorId);
      const voter = people.get(vote.userId);
      // Known-invalid pre-cutoff choices remain in the evidence, but never in
      // recipients or the active-vote budget. No current safety fields are used.
      if (vote.direction === 'none' || vote.userId === proposal.authorId || vote.updatedAt < round.opensAt
        || proposal.roundId !== round.proposalRoundId || author.status !== 'active' || voter.status !== 'active'
        || proposal.cutoffModeration === 'excluded' || proposal.visible === 0 || proposal.profileCreatedAt === null
        || proposal.defaultPolicy !== PUBLICATION_POLICY_VERSION || proposal.defaultRevision !== proposal.revision
        || proposal.publicationProposalRevision !== proposal.revision || proposal.publicationBodyHash !== proposal.bodyHash
        || vote.proposalRevision !== proposal.publicationProposalRevision || vote.publicationRevision !== proposal.publicationRevision
        || vote.bodyHash !== proposal.publicationBodyHash || vote.policyVersion !== proposal.publicationPolicy
        || vote.authorControlRevision !== author.revision || vote.voterControlRevision !== voter.revision
        || vote.moderationRevision !== proposal.cutoffModerationRevision) continue;
      const count = (activeVotes.get(vote.userId) || 0) + 1;
      if (count > COMMUNITY_VOTE_LIMIT) fail('history');
      activeVotes.set(vote.userId, count);
      results.get(proposal.id)?.[vote.direction === 'up' ? 'upvoterIds' : 'downvoterIds'].add(vote.userId);
    }
    if ([...voteEvents.keys()].some(identity => !seenVotes.has(identity))) fail('history');
    const output = { roundId, cutoff, proposals: [...results.values()].sort((a, b) => compare(a.proposalId, b.proposalId))
      .map(row => ({ ...row, upvoterIds: sorted(row.upvoterIds), downvoterIds: sorted(row.downvoterIds) })) };
    return { ...output, snapshotDigest: digest({ schemaVersion: 1, ...output,
      bindings: bindings.map(({ id, revision: value, bodyHash }) => ({ id, revision: value, bodyHash }))
        .sort((a, b) => compare(a.id, b.id)),
      votes: rows.vote.sort((a, b) => compare(key(a.userId, a.publicId), key(b.userId, b.publicId))),
      events: rows.event.sort((a, b) => compare(a.id, b.id)),
      receipts: rows.receipt.sort((a, b) => compare(key(a.userId, a.requestId), key(b.userId, b.requestId))),
      moderationProofs: moderationProofs.sort((a, b) => compare(a.proposalId, b.proposalId)),
    }) };
  } catch (error) {
    if (error instanceof ApiError && Object.values(ERRORS).some(([code]) => code === error.code)) throw error;
    fail('history');
  }
}
