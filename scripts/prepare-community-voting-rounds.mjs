// Trusted local migration only: retain every existing proposal, vote and round.
import { parseArgs } from 'node:util';
import { readConfig } from '../server/config.mjs';
import { openDatabase } from '../server/database.mjs';
import { prepareCommunityVotingRounds } from '../server/community-schema.mjs';

const usage = 'Usage: node [--env-file=PATH] scripts/prepare-community-voting-rounds.mjs --expected-service-revision NUMBER';
let expectedServiceRevision;
let help = false;
try {
  const parsed = parseArgs({ options: { 'expected-service-revision': { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: false, strict: true, tokens: true });
  help = parsed.values.help === true;
  if (help && parsed.tokens.length !== 1) throw new Error('Help must be used alone.');
  if (!help) {
    const value = parsed.values['expected-service-revision'];
    if (parsed.tokens.length !== 1 || !/^[1-9][0-9]{0,15}$/.test(value || '') || !Number.isSafeInteger(Number(value))) {
      throw new Error('An exact revision is required.');
    }
    expectedServiceRevision = Number(value);
  }
} catch {
  console.error(usage);
  process.exitCode = 2;
}

if (help && !process.exitCode) console.log(usage);
else if (!process.exitCode) {
  let client;
  try {
    // No automatic DB initialization, policy activation or local-DB fallback.
    // An explicitly configured existing database and exact service revision are required.
    client = await openDatabase(readConfig(), { initialize: false });
    const result = await prepareCommunityVotingRounds(client, { expectedServiceRevision });
    if (result.prepared !== true || result.schemaVersion !== 1 || result.serviceRevision !== expectedServiceRevision
        || !Number.isSafeInteger(result.roundsAdded) || result.roundsAdded < 0
        || result.existingVotesChanged !== false || result.proposalsChanged !== false || result.pointsIssued !== false) {
      throw new Error('Unverified preparation result.');
    }
    console.log(JSON.stringify({ prepared: true, schemaVersion: result.schemaVersion,
      serviceRevision: result.serviceRevision, roundsAdded: result.roundsAdded,
      existingVotesChanged: false, proposalsChanged: false, pointsIssued: false }));
  } catch (error) {
    const known = ['INVALID_COMMUNITY_INPUT', 'REVISION_CONFLICT', 'PROPOSALS_PAUSED', 'COMMUNITY_SCHEMA_UNAVAILABLE',
      'DATABASE_UNCONFIGURED', 'DATABASE_CONFIGURATION_ERROR'];
    const code = known.includes(error?.code) ? error.code : 'DATABASE_ERROR';
    // Preserve an uncertain commit for operator reconciliation. Never print a
    // provider error, URL, environment value or claim an unverified rollback.
    console.error(JSON.stringify({ prepared: null, code,
      message: 'Preparation could not be confirmed. Inspect storage and service controls before retrying.' }));
    process.exitCode = 1;
  } finally { try { client?.close(); } catch { /* No raw provider diagnostics. */ } }
}
