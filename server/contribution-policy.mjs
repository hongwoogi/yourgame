import { createHash } from 'node:crypto';

// No interpretation of the user's ** notation has been activated. These
// calculators are explicit previews; they never establish release evidence or
// authorize ledger writes. The voter formula is unambiguous in both previews.
export const CONTRIBUTION_POLICY_VERSION = null;
export const CONTRIBUTION_ISSUANCE_BLOCK = 'RELEASE_REVIEW_UNAVAILABLE';
export const MAX_VOTE_COUNT = 9223372036854775807n;
const FORMULAS = new Set(['weighted', 'exponent']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function publicContributionPolicy() {
  return {
    policyVersion: CONTRIBUTION_POLICY_VERSION,
    status: 'pending_confirmation',
    issuanceEnabled: false,
    blockedReason: CONTRIBUTION_ISSUANCE_BLOCK,
    proposer: { base: '100', upvote: { operation: null, value: '5' }, downvote: { operation: null, value: '2' } },
    voter: { base: '10', upvote: { operation: 'multiply', value: '1' }, downvote: { operation: 'multiply', value: '0.5' } },
    negativeAllowed: true,
    pointStep: '0.5',
  };
}

function voteCount(value, name) {
  let parsed;
  if (typeof value === 'bigint') parsed = value;
  else if (typeof value === 'number' && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)) parsed = BigInt(value);
  else throw new TypeError(`${name} must be a nonnegative integer vote count.`);
  // A representation limit matching database counts, not a points cap. Reject
  // unrepresentable input instead of rounding or clamping a legitimate score.
  if (parsed < 0n || parsed > MAX_VOTE_COUNT) throw new RangeError(`${name} is outside the supported vote-count range.`);
  return parsed;
}

function identifier(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError(`${name} must be a bounded identifier.`);
  return value;
}

export function formatHalfPoints(units) {
  if (typeof units !== 'bigint') throw new TypeError('Point units must be a BigInt.');
  const absolute = units < 0n ? -units : units;
  return `${units < 0n ? '-' : ''}${absolute / 2n}${absolute % 2n ? '.5' : ''}`;
}

export function previewContribution({ formula, role, upvotes, downvotes } = {}) {
  if (!FORMULAS.has(formula)) throw new TypeError('Choose an explicit weighted or exponent preview; no score policy is active.');
  if (!['proposer', 'voter'].includes(role)) throw new TypeError('Choose a proposer or voter role.');
  const up = voteCount(upvotes, 'upvotes');
  const down = voteCount(downvotes, 'downvotes');
  const units = role === 'voter' ? 20n + 2n * up - down
    : formula === 'weighted' ? 200n + 10n * up - 4n * down
      : 2n * (100n + up ** 5n - down ** 2n);
  return {
    kind: 'contribution_preview', awardable: false, policyVersion: null,
    formula, role, upvotes: String(up), downvotes: String(down),
    halfPointUnits: String(units), points: formatHalfPoints(units),
  };
}

// The caller must already have identified a real requirement group and the
// eligible authors / pre-cutoff supporters. This helper does not infer semantic
// similarity, safety, adoption, vote validity, or actual publication from text.
export function previewRequirementContributions({ requirementGroupId, proposerIds, upvoterIds,
  formula, upvotes, downvotes } = {}) {
  identifier(requirementGroupId, 'requirementGroupId');
  if (!Array.isArray(proposerIds) || !Array.isArray(upvoterIds)
    || proposerIds.length > 10000 || upvoterIds.length > 10000) {
    throw new TypeError('Participant lists must be bounded arrays.');
  }
  const authors = new Set(proposerIds.map(id => identifier(id, 'proposerId')));
  const voters = new Set(upvoterIds.map(id => identifier(id, 'upvoterId')));
  const proposalScore = previewContribution({ formula, role: 'proposer', upvotes, downvotes });
  const voteScore = previewContribution({ formula, role: 'voter', upvotes, downvotes });
  const items = [...new Set([...authors, ...voters])].sort().map(userId => {
    const authored = authors.has(userId);
    const voted = voters.has(userId);
    // A participant can receive one contribution per actual change. This also
    // handles negative scores: choose the larger value, without a zero clamp.
    const selected = authored && (!voted || BigInt(proposalScore.halfPointUnits) >= BigInt(voteScore.halfPointUnits))
      ? proposalScore : voteScore;
    return { userId, role: selected.role, adopted: authored, halfPointUnits: selected.halfPointUnits, points: selected.points };
  });
  return { kind: 'contribution_preview', awardable: false, policyVersion: null, requirementGroupId, formula, items };
}

export function contributionAwardKey({ requirementGroupId, fulfillmentId, userId } = {}) {
  // A fulfillment identity represents a newly verified change, not a deployment
  // attempt. Re-publication or rollback of the same change cannot create a new
  // award key. A future trusted issuer must establish these semantic identities.
  const fields = [identifier(requirementGroupId, 'requirementGroupId'),
    identifier(fulfillmentId, 'fulfillmentId'), identifier(userId, 'userId')];
  return createHash('sha256').update(JSON.stringify(['yourgame.contribution.award.v1', ...fields])).digest('hex');
}
