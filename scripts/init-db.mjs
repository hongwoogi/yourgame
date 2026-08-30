import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../server/config.mjs';
import { initializeDatabase, openDatabase, SCHEMA_VERSION } from '../server/database.mjs';

// Node's --env-file flag loads explicit credentials before this script runs.
// No production data or credentials are printed, and no rows are seeded.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
if (!process.env.TURSO_DATABASE_URL) {
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') {
    console.error('Database initialization stopped: TURSO_DATABASE_URL is required in production.');
    process.exitCode = 1;
  } else {
    const directory = resolve(projectRoot, '.local');
    await mkdir(directory, { recursive: true });
    process.env.TURSO_DATABASE_URL = `file:${resolve(directory, 'development.db').replaceAll('\\', '/')}`;
  }
}

if (!process.exitCode) {
  let client;
  try {
    client = await openDatabase(readConfig(), { initialize: false });
    await initializeDatabase(client);
    console.log(`Database schema v${SCHEMA_VERSION} is ready. Existing data was preserved.`);
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,50}$/.test(error.code || '') ? error.code : 'DATABASE_ERROR';
    console.error(`Database initialization failed (${code}). Check the connection and database permissions.`);
    process.exitCode = 1;
  } finally {
    client?.close();
  }
}
