import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readConfig } from '../server/config.mjs';
import { openDatabase } from '../server/database.mjs';
import { activateCommunityPublicDefaults } from '../server/community-schema.mjs';

const usage = 'Usage: node [--env-file=PATH] scripts/activate-public-defaults.mjs --expected-service-revision NUMBER';
let expectedServiceRevision;
let help = false;
try {
  const parsed = parseArgs({ options: { 'expected-service-revision': { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: false, strict: true, tokens: true });
  help = parsed.values.help === true;
  if (help && parsed.tokens.length !== 1) throw new Error('Help must be used alone.');
  if (!help) {
    const revision = parsed.values['expected-service-revision'];
    if (parsed.tokens.length !== 1 || !/^[1-9]\d{0,15}$/.test(revision || '')
      || !Number.isSafeInteger(Number(revision))) throw new Error('An exact revision is required.');
    expectedServiceRevision = Number(revision);
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
    // Schema preparation and policy activation are separate, explicit operations.
    // The activation transaction checks the exact active service revision again.
    client = await openDatabase(readConfig(env), { initialize: false });
    const result = await activateCommunityPublicDefaults(client, { expectedServiceRevision });
    const counts = [result.profilesAdded, result.publicationsAdded, result.defaultEventsAdded];
    if (result.active !== true || result.serviceRevision !== expectedServiceRevision
      || result.policyVersion !== 'public-default-v1'
      || !counts.every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Unverified activation result.');
    console.log(JSON.stringify({ policyVersion: result.policyVersion, active: true,
      serviceRevision: result.serviceRevision, profilesAdded: result.profilesAdded,
      publicationsAdded: result.publicationsAdded, defaultEventsAdded: result.defaultEventsAdded }));
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,50}$/.test(error?.code || '') ? error.code : 'DATABASE_ERROR';
    // A network error can leave an uncertain commit. Never print raw provider
    // errors or assume that retrying should roll back or overwrite existing data.
    console.error(JSON.stringify({ active: null, code,
      message: 'Activation could not be confirmed. Inspect the current policy and service controls before retrying.' }));
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}
