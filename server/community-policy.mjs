import { isValidProfileAlias } from '../public/profile-policy.js';

// Public participation policy is separate from the Teen game-input policy.
export const PUBLICATION_POLICY_VERSION = 'public-default-v1';
export const COMMUNITY_VOTE_LIMIT = 3;
export const COMMUNITY_PROFILE_NAMES_VERSION = 1;
export const COMMUNITY_PROFILE_NAMES_READY_SQL = `((SELECT value FROM community_meta
  WHERE key = 'profile_names_schema_version') = ${COMMUNITY_PROFILE_NAMES_VERSION}
  AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (
    'community_profile_name_identity_immutable', 'community_profile_names_no_delete')) = 2)`;

export function profileDisplayAlias(generatedAlias, customAlias) {
  // Preserve the original generated-identity invariant even when an override
  // exists. Never substitute a Google account name or arbitrary account field.
  if (typeof generatedAlias !== 'string' || !/^Player-[0-9a-f]{12}$/.test(generatedAlias)) return null;
  if (customAlias == null) return generatedAlias;
  return isValidProfileAlias(customAlias) ? customAlias : null;
}

export const COMMUNITY_DEFAULT_TRIGGER_NAMES = [
  'community_default_user', 'community_default_profile', 'community_default_body',
  'community_visibility_choice', 'community_default_vote_insert_cap', 'community_default_vote_update_cap',
  'community_default_events_no_update', 'community_default_events_no_delete', 'community_default_events_no_replace',
  'community_policy_transitions_no_update', 'community_policy_transitions_no_delete', 'community_policy_transitions_no_replace',
];
export const COMMUNITY_DEFAULT_ACTIVE_SQL = `EXISTS (SELECT 1 FROM community_public_policy
  WHERE id = 1 AND version = '${PUBLICATION_POLICY_VERSION}' AND state = 'active')`;
export const COMMUNITY_DEFAULT_READY_SQL = `(${COMMUNITY_DEFAULT_ACTIVE_SQL} AND
  (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN
    (${COMMUNITY_DEFAULT_TRIGGER_NAMES.map(name => `'${name}'`).join(',')})) = ${COMMUNITY_DEFAULT_TRIGGER_NAMES.length})`;

// The review columns remain provenance for the legacy NOT NULL/FK vote schema.
// Neither review status nor its revision/policy determines public visibility or
// vote validity. Development/export uses approvedSafetySql independently.
export const PUBLIC_PUBLICATIONS_SQL = `eligible_publications AS (
  SELECT cp.*, p.user_id AS author_user_id, p.body, p.created_at AS proposal_created_at, p.round_id AS proposal_round_id,
    pr.public_id AS author_public_id, pr.alias, sr.id AS safety_review_id, sr.revision AS safety_revision,
    COALESCE(ma.revision, 1) AS current_author_revision, COALESCE(pm.revision, 1) AS moderation_revision
  FROM community_publications cp JOIN proposals p ON p.id = cp.proposal_id
  JOIN community_profiles pr ON pr.user_id = p.user_id
  JOIN community_publication_defaults pd ON pd.proposal_id = p.id AND pd.proposal_revision = p.revision
    AND pd.policy_version = '${PUBLICATION_POLICY_VERSION}'
  LEFT JOIN community_visibility_choices choice ON choice.kind = 'publication' AND choice.target_id = p.id
  LEFT JOIN member_access ma ON ma.user_id = p.user_id
  LEFT JOIN proposal_moderation pm ON pm.proposal_id = p.id
  JOIN proposal_body_revisions h ON h.proposal_id = p.id AND h.body_revision = p.revision AND h.body = p.body COLLATE BINARY
  LEFT JOIN proposal_safety_reviews sr ON sr.id = (SELECT s.id FROM proposal_safety_reviews s
    WHERE s.proposal_id = p.id AND s.body_revision = p.revision AND s.body_hash = h.body_hash
    ORDER BY s.created_at, s.id LIMIT 1)
  WHERE ${COMMUNITY_DEFAULT_ACTIVE_SQL} AND COALESCE(choice.visible, 1) = 1
    AND cp.proposal_revision = p.revision AND cp.body_hash = h.body_hash
    AND COALESCE(ma.status, 'active') = 'active' AND COALESCE(pm.moderation, 'pending') != 'excluded'
)`;
export const PUBLIC_VOTES_SQL = `valid_votes AS (
  SELECT v.* FROM community_votes v JOIN eligible_publications ep ON ep.public_id = v.public_id
  JOIN community_rounds r ON r.id = v.round_id AND r.proposal_round_id = ep.proposal_round_id
  LEFT JOIN member_access va ON va.user_id = v.user_id
  WHERE v.direction IN ('up', 'down') AND v.user_id != ep.author_user_id
    AND v.proposal_revision = ep.proposal_revision AND v.publication_revision = ep.revision
    AND v.body_hash = ep.body_hash AND v.policy_version = ep.policy_version
    AND v.author_control_revision = ep.current_author_revision AND v.moderation_revision = ep.moderation_revision
    AND v.voter_control_revision = COALESCE(va.revision, 1) AND COALESCE(va.status, 'active') = 'active'
    AND v.updated_at >= r.opens_at AND v.updated_at < r.closes_at
)`;

export const PUBLICATION_POLICY_DTO = Object.freeze({ version: PUBLICATION_POLICY_VERSION, defaultPublic: true });
