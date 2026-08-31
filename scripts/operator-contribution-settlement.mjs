// Trusted local operator only. This is not an HTTP action or a game-agent tool.
// Fulfillment findings must come from an operator's actual review of the bound
// game and execution evidence; a generated report cannot approve itself.
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readConfig } from '../server/config.mjs';
import { openDatabase } from '../server/database.mjs';
import { releaseBindingDigest } from '../server/game-release-store.mjs';
import { createContributionSettlementStore, prepareContributionSettlementSchema } from '../server/contribution-settlement.mjs';
import { preparePrivateFile, resolvePrivateFile } from './private-records.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const textValue = value => typeof value === 'string' && value.length > 0 && value.length <= 2000
  && value.isWellFormed() && !value.includes('\0');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const contributionReviewGroupDigest = group => sha256(canonical(group));
const fail = code => { throw Object.assign(new Error(code), { operatorCode: code }); };

export function parseContributionSettlementArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const [command, ...values] = args;
  const fields = command === 'prepare' ? ['service-revision'] : ['plan', 'review', 'output'];
  if (!['prepare', 'preview', 'apply'].includes(command) || values.length !== fields.length * 2) {
    fail('CONTRIBUTION_INVALID_COMMAND');
  }
  const result = { command };
  for (let i = 0; i < values.length; i += 2) {
    const name = values[i]?.slice(2);
    if (!values[i]?.startsWith('--') || !fields.includes(name) || Object.hasOwn(result, name)
      || typeof values[i + 1] !== 'string' || !values[i + 1] || values[i + 1].startsWith('--')) {
      fail('CONTRIBUTION_INVALID_COMMAND');
    }
    result[name] = values[i + 1];
  }
  if (command === 'prepare' && (!/^[1-9][0-9]{0,14}$/.test(result['service-revision'])
    || !Number.isSafeInteger(Number(result['service-revision'])))) fail('CONTRIBUTION_INVALID_COMMAND');
  return result;
}

async function privateBytes(file, { privateRoot, maxBytes = MAX_PLAN_BYTES } = {}) {
  const target = await resolvePrivateFile(file, privateRoot ? { privateRoot } : {});
  const metadata = await stat(target);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > maxBytes) fail('CONTRIBUTION_INVALID_REVIEW_FILE');
  const bytes = await readFile(target);
  if (bytes.length !== metadata.size || bytes.length > maxBytes) fail('CONTRIBUTION_INVALID_REVIEW_FILE');
  return bytes;
}

function json(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail('CONTRIBUTION_INVALID_REVIEW_FILE'); }
}

// This binds a manually reviewed finding to unchanged private evidence files.
// It does not turn the file's prose or a boolean into proof of adoption. The
// store independently checks the immutable release receipt and live DB state.
export async function loadContributionSettlementPlan(planFile, reviewFile, { privateRoot, projectRoot = root } = {}) {
  const plan = json(await privateBytes(planFile, { privateRoot }));
  const reviewBytes = await privateBytes(reviewFile, { privateRoot });
  const review = json(reviewBytes);
  if (sha256(reviewBytes) !== plan?.reviewEvidenceDigest
    || !exact(review, ['schemaVersion', 'kind', 'operatorId', 'authorizationRef', 'reviewId', 'runId',
      'releaseBinding', 'reviewedAt', 'artifacts', 'groups'])
    || review.schemaVersion !== 1 || review.kind !== 'operator_contribution_fulfillment_review'
    || !['operatorId', 'authorizationRef', 'reviewId', 'runId'].every(key => review[key] === plan[key])
    || !textValue(review.reviewedAt) || !Number.isSafeInteger(Date.parse(review.reviewedAt))
    || releaseBindingDigest(review.releaseBinding) !== releaseBindingDigest(plan.releaseBinding)
    || !Array.isArray(review.artifacts) || !review.artifacts.length || review.artifacts.length > 16
    || !Array.isArray(plan.groups) || !Array.isArray(review.groups) || !review.groups.length
    || review.groups.length !== plan.groups.length || review.groups.length > 200) fail('CONTRIBUTION_REVIEW_MISMATCH');
  const artifacts = new Set();
  for (const artifact of review.artifacts) {
    if (!exact(artifact, ['path', 'sha256']) || !textValue(artifact.path) || !HASH.test(artifact.sha256 || '')) {
      fail('CONTRIBUTION_REVIEW_MISMATCH');
    }
    const target = path.resolve(projectRoot, artifact.path);
    const canonicalPath = await resolvePrivateFile(target, privateRoot ? { privateRoot } : {});
    if (artifacts.has(canonicalPath)) fail('CONTRIBUTION_REVIEW_MISMATCH');
    artifacts.add(canonicalPath);
    const bytes = await privateBytes(canonicalPath, { privateRoot, maxBytes: MAX_ARTIFACT_BYTES });
    if (sha256(bytes) !== artifact.sha256) fail('CONTRIBUTION_REVIEW_MISMATCH');
  }
  const groups = new Map();
  for (const group of review.groups) {
    if (!exact(group, ['requirementGroupId', 'fulfillmentId', 'proposalIds', 'fulfillment',
      'finding', 'implementation', 'evidenceRefs', 'limitations'])
      || !textValue(group.finding) || !Array.isArray(group.implementation) || !group.implementation.length
      || group.implementation.length > 20 || !group.implementation.every(textValue)
      || !Array.isArray(group.limitations) || group.limitations.length > 20 || !group.limitations.every(textValue)
      || !Array.isArray(group.evidenceRefs) || !group.evidenceRefs.length || group.evidenceRefs.length > review.artifacts.length
      || new Set(group.evidenceRefs).size !== group.evidenceRefs.length
      || group.evidenceRefs.some(index => !Number.isSafeInteger(index) || index < 0 || index >= review.artifacts.length)
      || groups.has(group.requirementGroupId)) fail('CONTRIBUTION_REVIEW_MISMATCH');
    groups.set(group.requirementGroupId, group);
  }
  for (const group of plan.groups) {
    const finding = groups.get(group.requirementGroupId);
    if (!finding || finding.fulfillmentId !== group.fulfillmentId || finding.fulfillment !== group.fulfillment
      || canonical(finding.proposalIds) !== canonical(group.proposalIds)
      || contributionReviewGroupDigest(finding) !== group.evidenceDigest) fail('CONTRIBUTION_REVIEW_MISMATCH');
  }
  return plan;
}

const SAFE_ERRORS = new Set([
  'CONTRIBUTION_INVALID_COMMAND', 'CONTRIBUTION_INVALID_REVIEW_FILE', 'CONTRIBUTION_REVIEW_MISMATCH',
  'CONTRIBUTION_OUTPUT_EXISTS',
  'INVALID_PRIVATE_FILE', 'INVALID_CONTRIBUTION_SETTLEMENT', 'INVALID_RELEASE_BINDING',
  'CONTRIBUTION_POLICY_UNCONFIRMED', 'CONTRIBUTION_POLICY_MISMATCH', 'CONTRIBUTION_PUBLICATION_UNVERIFIED',
  'CONTRIBUTION_RUN_UNAVAILABLE', 'CONTRIBUTION_SETTLEMENT_CONFLICT', 'CONTRIBUTION_ALREADY_ISSUED',
  'CONTRIBUTION_INPUT_BINDING_MISMATCH', 'CONTRIBUTION_REVIEW_UNAVAILABLE', 'CONTRIBUTION_CAPACITY_EXCEEDED',
  'CONTRIBUTION_SETTLEMENT_SCHEMA_UNAVAILABLE', 'CONTRIBUTION_SCHEMA_UNAVAILABLE', 'WORKER_BLOCKED',
  'CONTRIBUTION_VOTE_HISTORY_UNAVAILABLE', 'CONTRIBUTION_ROUND_UNAVAILABLE', 'CONTRIBUTION_VOTE_CONFLICT',
  'PUBLICATION_UNAVAILABLE', 'RELEASE_REVIEW_UNAVAILABLE', 'RELEASE_REVIEW_BINDING_MISMATCH',
]);

async function main() {
  let client, command, reservedOutput, requestId, mutationStarted = false;
  try {
    const options = parseContributionSettlementArgs(process.argv.slice(2));
    if (options.help) {
      console.log('Trusted local contribution settlement. Run only after manual fulfillment review and read-only admin-worker status.\n'
        + 'prepare --service-revision N\npreview|apply --plan .local/plan.json --review .local/review.json --output .local/new-result.json\n'
        + 'Preview is a private, read-only simulation. Apply requires the confirmed scoring policy and real publication/input/vote proof. '
        + 'Output files are exclusive: never overwrite a receipt. On an uncertain result, preserve the old output and reconcile the same plan/request '
        + 'using a fresh unused --output path; do not invent a new request.');
      return;
    }
    command = options.command;
    let plan, output;
    if (command !== 'prepare') {
      plan = await loadContributionSettlementPlan(path.resolve(root, options.plan), path.resolve(root, options.review));
      output = await preparePrivateFile(path.resolve(root, options.output));
      // Reserve the private receipt before any DB writes; never discover an
      // existing output only after committing an irreversible award.
      try {
        await writeFile(output, JSON.stringify({ schemaVersion: 1, status: 'started', command,
          requestId: plan.requestId, startedAt: new Date().toISOString() }, null, 2), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code === 'EEXIST') fail('CONTRIBUTION_OUTPUT_EXISTS');
        throw error;
      }
      reservedOutput = output;
      requestId = plan.requestId;
    }
    client = await openDatabase(readConfig(), { initialize: false });
    if (command === 'prepare') {
      mutationStarted = true;
      const result = await prepareContributionSettlementSchema(client, { expectedServiceRevision: Number(options['service-revision']) });
      console.log(JSON.stringify(result));
      return;
    }
    const store = createContributionSettlementStore(client);
    mutationStarted = command === 'apply';
    const result = await store[command === 'apply' ? 'settle' : 'preview'](plan);
    await writeFile(output, JSON.stringify({ schemaVersion: 1, status: 'completed', command,
      requestId: plan.requestId, recordedAt: new Date().toISOString(), result }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(command === 'apply' ? { ...result, savedPrivateRecord: true }
      : { ok: true, kind: result.kind, awardable: false, formula: result.formula,
        groupCount: result.groupCount, awardCount: result.awardCount, totalPoints: result.totalPoints, savedPrivateRecord: true }));
  } catch (error) {
    const code = error.operatorCode || error.workerCode || error.code;
    const known = SAFE_ERRORS.has(code);
    const failure = { ok: false, error: known ? code : 'CONTRIBUTION_SETTLEMENT_UNAVAILABLE',
      effectUncertain: mutationStarted && !known,
      reconcileRequired: code === 'CONTRIBUTION_OUTPUT_EXISTS' || (mutationStarted && !known) };
    if (reservedOutput) {
      try {
        await writeFile(reservedOutput, JSON.stringify({ schemaVersion: 1,
          status: failure.effectUncertain ? 'uncertain' : 'failed', command, requestId,
          recordedAt: new Date().toISOString(), result: failure }, null, 2), { mode: 0o600 });
      } catch { /* Preserve the original failure and any started record. */ }
    }
    // effectUncertain describes this attempt only. OUTPUT_EXISTS never proves
    // that an earlier attempt failed or that its award was not committed.
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  } finally { client?.close(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
