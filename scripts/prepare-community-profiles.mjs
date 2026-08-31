import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readConfig } from '../server/config.mjs';
import { openDatabase } from '../server/database.mjs';
import { prepareCommunityProfiles } from '../server/community-schema.mjs';

const usage = 'Usage: node [--env-file=PATH] scripts/prepare-community-profiles.mjs --expected-service-revision NUMBER';
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
    const env = { ...process.env };
    if (!env.TURSO_DATABASE_URL && env.NODE_ENV !== 'production' && env.VERCEL !== '1') {
      const root = fileURLToPath(new URL('..', import.meta.url));
      env.TURSO_DATABASE_URL = 'file:' + resolve(root, '.local', 'development.db').replaceAll('\\', '/');
    }
    // This operation cannot initialize the base schema, activate a publication
    // policy, generate an account/alias, change participation, or issue points.
    client = await openDatabase(readConfig(env), { initialize: false });
    const result = await prepareCommunityProfiles(client, { expectedServiceRevision });
    if (result.prepared !== true || result.schemaVersion !== 1 || result.serviceRevision !== expectedServiceRevision
        || !Number.isSafeInteger(result.displayNames) || result.displayNames < 0
        || result.generatedAliasesChanged !== false || result.pointsIssued !== false) throw new Error('Unverified preparation result.');
    console.log(JSON.stringify({ prepared: true, schemaVersion: result.schemaVersion, serviceRevision: result.serviceRevision,
      displayNames: result.displayNames, generatedAliasesChanged: false, pointsIssued: false }));
  } catch (error) {
    const known = ['INVALID_COMMUNITY_INPUT', 'REVISION_CONFLICT', 'PROPOSALS_PAUSED', 'COMMUNITY_SCHEMA_UNAVAILABLE',
      'DATABASE_UNCONFIGURED', 'DATABASE_CONFIGURATION_ERROR'];
    const code = known.includes(error?.code) ? error.code : 'DATABASE_ERROR';
    // A network failure can leave an uncertain commit. Never expose provider
    // messages/URLs or declare that a rollback or retry must have succeeded.
    console.error(JSON.stringify({ prepared: null, code,
      message: 'Preparation could not be confirmed. Inspect the schema and current service controls before retrying.' }));
    process.exitCode = 1;
  } finally { try { client?.close(); } catch { /* No raw provider diagnostics. */ } }
}
