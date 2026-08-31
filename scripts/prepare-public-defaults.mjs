import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readConfig } from '../server/config.mjs';
import { initializeDatabase, openDatabase } from '../server/database.mjs';
import { checkCommunitySchema } from '../server/community-schema.mjs';
import { COMMUNITY_DEFAULT_TRIGGER_NAMES, PUBLICATION_POLICY_VERSION } from '../server/community-policy.mjs';

// Operational preparation only. Activation/backfill uses the separate committed
// CLI. Never call application health here: the new application requires ACTIVE.
const usage = 'Usage: node [--env-file=PATH] scripts/prepare-public-defaults.mjs --expected-service-revision NUMBER';
const CONTROL_SQL = `SELECT id, mode, proposals_enabled, development_enabled, message, revision, updated_at
  FROM service_control WHERE id = 1`;
const BASE_COUNTS_SQL = `SELECT
  (SELECT COUNT(*) FROM users) AS users,
  (SELECT COUNT(*) FROM proposals) AS proposals,
  (SELECT COUNT(*) FROM proposal_body_revisions) AS bodyHistory,
  (SELECT COUNT(*) FROM proposal_safety_reviews) AS safetyReviews,
  (SELECT COUNT(*) FROM contribution_ledger) AS contributionAwards,
  (SELECT COUNT(*) FROM community_profiles) AS profiles,
  (SELECT COUNT(*) FROM community_publications) AS publications,
  (SELECT COUNT(*) FROM community_votes) AS votes`;
const SHAPE_SQL = `SELECT
  (SELECT COUNT(*) FROM sqlite_master WHERE type = 'table') AS tables,
  (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger') AS triggers`;
const SAFE_CODES = new Set(['INVALID_ARGUMENTS', 'DATABASE_UNCONFIGURED', 'DATABASE_CONFIGURATION_ERROR',
  'CONFIGURATION_ERROR', 'SCHEMA_UNAVAILABLE', 'ADMIN_SCHEMA_UNAVAILABLE', 'SAFETY_SCHEMA_UNAVAILABLE',
  'COMMUNITY_SCHEMA_UNAVAILABLE', 'CONTRIBUTION_SCHEMA_UNAVAILABLE', 'SERVICE_CONTROL_UNAVAILABLE',
  'SERVICE_REVISION_CONFLICT', 'SERVICE_NOT_ACTIVE', 'SERVICE_CONTROL_CHANGED', 'POLICY_ALREADY_ACTIVE',
  'POLICY_NOT_INACTIVE', 'PREPARATION_VERIFICATION_FAILED', 'DATABASE_ERROR']);

class PreparationError extends Error {
  constructor(code, transactionOutcome = 'not_started') {
    super(code);
    this.code = SAFE_CODES.has(code) ? code : 'DATABASE_ERROR';
    this.transactionOutcome = transactionOutcome;
  }
}

function reject(code) { throw new PreparationError(code); }
function counts(row) {
  if (!row || !Object.keys(row).length) reject('PREPARATION_VERIFICATION_FAILED');
  const result = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  if (!Object.values(result).every(value => Number.isSafeInteger(value) && value >= 0)) reject('PREPARATION_VERIFICATION_FAILED');
  return result;
}

function verifyControl(row, expectedServiceRevision) {
  if (!row || Number(row.id) !== 1 || !Number.isSafeInteger(Number(row.revision))) reject('SERVICE_CONTROL_UNAVAILABLE');
  if (Number(row.revision) !== expectedServiceRevision) reject('SERVICE_REVISION_CONFLICT');
  if (row.mode !== 'active' || Number(row.proposals_enabled) !== 1 || Number(row.development_enabled) !== 1) reject('SERVICE_NOT_ACTIVE');
}

async function readPolicy(transaction, { allowMissing = false } = {}) {
  const exists = (await transaction.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'community_public_policy'")).rows[0];
  if (Number(exists?.n) === 0 && allowMissing) return null;
  if (Number(exists?.n) !== 1) reject('COMMUNITY_SCHEMA_UNAVAILABLE');
  const row = (await transaction.execute('SELECT id, version, state, activated_at, service_revision FROM community_public_policy WHERE id = 1')).rows[0];
  if (row?.state === 'active') reject('POLICY_ALREADY_ACTIVE');
  if (!row || row.version !== PUBLICATION_POLICY_VERSION || row.state !== 'inactive'
    || row.activated_at !== null || row.service_revision !== null) reject('POLICY_NOT_INACTIVE');
  return row;
}

export function parsePreparationArgs(args) {
  try {
    const parsed = parseArgs({ args, options: { 'expected-service-revision': { type: 'string' }, help: { type: 'boolean' } },
      strict: true, allowPositionals: false, tokens: true });
    if (parsed.values.help === true && parsed.tokens.length === 1) return { help: true };
    const raw = parsed.values['expected-service-revision'];
    if (parsed.values.help || parsed.tokens.length !== 1 || !/^[1-9]\d{0,15}$/.test(raw || '')
      || !Number.isSafeInteger(Number(raw))) reject('INVALID_ARGUMENTS');
    return { help: false, expectedServiceRevision: Number(raw) };
  } catch { reject('INVALID_ARGUMENTS'); }
}

export async function preparePublicDefaultSchema(client, { expectedServiceRevision } = {}) {
  if (!Number.isSafeInteger(expectedServiceRevision) || expectedServiceRevision < 1) reject('INVALID_ARGUMENTS');
  let transaction;
  let commitStarted = false;
  try {
    transaction = await client.transaction('write');
    // Read controls inside the write transaction before ANY initializer/DDL.
    const beforeControl = (await transaction.execute(CONTROL_SQL)).rows[0];
    verifyControl(beforeControl, expectedServiceRevision);
    await readPolicy(transaction, { allowMissing: true });
    const beforeShape = counts((await transaction.execute(SHAPE_SQL)).rows[0]);
    const beforeCounts = counts((await transaction.execute(BASE_COUNTS_SQL)).rows[0]);

    await initializeDatabase(transaction);
    await checkCommunitySchema(transaction);
    await readPolicy(transaction);
    const triggerRow = (await transaction.execute({ sql: `SELECT COUNT(*) AS n FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${COMMUNITY_DEFAULT_TRIGGER_NAMES.map(() => '?').join(',')})`,
      args: COMMUNITY_DEFAULT_TRIGGER_NAMES })).rows[0];
    if (Number(triggerRow?.n) !== COMMUNITY_DEFAULT_TRIGGER_NAMES.length) reject('COMMUNITY_SCHEMA_UNAVAILABLE');
    const afterCounts = counts((await transaction.execute(BASE_COUNTS_SQL)).rows[0]);
    const afterShape = counts((await transaction.execute(SHAPE_SQL)).rows[0]);
    // These established objects cannot be created/removed by inactive public
    // preparation. Missing legacy history/reviews may be additively recovered by
    // the committed initializer, so report those counts without fabricating approval.
    for (const key of ['users', 'proposals', 'contributionAwards', 'profiles', 'publications', 'votes']) {
      if (afterCounts[key] !== beforeCounts[key]) reject('PREPARATION_VERIFICATION_FAILED');
    }
    if (afterCounts.bodyHistory < beforeCounts.bodyHistory || afterCounts.safetyReviews < beforeCounts.safetyReviews
      || afterShape.tables < beforeShape.tables || afterShape.triggers < beforeShape.triggers) reject('PREPARATION_VERIFICATION_FAILED');
    const policyCounts = counts((await transaction.execute(`SELECT
      (SELECT COUNT(*) FROM community_profile_defaults) AS defaultProfiles,
      (SELECT COUNT(*) FROM community_publication_defaults) AS defaultPublications,
      (SELECT COUNT(*) FROM community_default_events) AS defaultEvents,
      (SELECT COUNT(*) FROM community_policy_transitions) AS policyTransitions`)).rows[0]);
    if (Object.values(policyCounts).some(value => value !== 0)) reject('POLICY_NOT_INACTIVE');

    const afterControl = (await transaction.execute(CONTROL_SQL)).rows[0];
    verifyControl(afterControl, expectedServiceRevision);
    if (!afterControl || Object.keys(beforeControl).some(key => beforeControl[key] !== afterControl[key])) reject('SERVICE_CONTROL_CHANGED');
    const result = { prepared: true, committed: true, policyVersion: PUBLICATION_POLICY_VERSION, policyState: 'inactive',
      service: { mode: 'active', proposalsEnabled: true, developmentEnabled: true, revision: expectedServiceRevision },
      serviceControlPreserved: true, counts: afterCounts, policyCounts,
      schemaAdded: { tables: afterShape.tables - beforeShape.tables, triggers: afterShape.triggers - beforeShape.triggers } };
    commitStarted = true;
    await transaction.commit();
    return result;
  } catch (error) {
    let transactionOutcome = transaction ? 'unknown' : 'not_started';
    if (transaction) {
      try {
        await transaction.rollback();
        // A lost commit response is never proof that a rollback undid it.
        if (!commitStarted) transactionOutcome = 'rolled_back';
      } catch { /* Report uncertainty, never raw network/provider details. */ }
    }
    throw new PreparationError(error?.code, transactionOutcome);
  } finally {
    try { transaction?.close(); } catch { /* Closing is not confirmation of commit. */ }
  }
}

export function preparationFailure(error) {
  const transactionOutcome = ['not_started', 'rolled_back', 'unknown'].includes(error?.transactionOutcome)
    ? error.transactionOutcome : 'unknown';
  return { prepared: null, committed: null, transactionOutcome,
    code: SAFE_CODES.has(error?.code) ? error.code : 'DATABASE_ERROR',
    message: transactionOutcome === 'rolled_back' ? 'This preparation attempt was rolled back and did not activate the policy.'
      : transactionOutcome === 'not_started' ? 'Preparation did not start.'
        : 'Preparation could not be confirmed. Inspect the current schema, policy and service controls before retrying.' };
}

async function main() {
  let options;
  try { options = parsePreparationArgs(process.argv.slice(2)); }
  catch { console.error(usage); process.exitCode = 2; return; }
  if (options.help) { console.log(usage); return; }
  let client;
  try {
    // Require an explicit database URL in every environment; never guess a
    // production target or fall back to another local database.
    client = await openDatabase(readConfig(), { initialize: false });
    console.log(JSON.stringify(await preparePublicDefaultSchema(client, options)));
  } catch (error) {
    const failure = client ? preparationFailure(error) : preparationFailure(new PreparationError(error?.code));
    console.error(JSON.stringify(failure));
    process.exitCode = 1;
  } finally {
    try { client?.close(); } catch { /* Do not print raw close errors. */ }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
