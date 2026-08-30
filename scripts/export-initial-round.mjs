import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INITIAL_CUTOFF, FIRST_RELEASE, readConfig } from '../server/config.mjs';
import { openDatabase } from '../server/database.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.local', 'round-initial');
const output = path.join(directory, 'snapshot.json');
let client;
try {
  client = await openDatabase(readConfig(), { initialize: false });
  const clock = await client.execute("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms");
  const now = Number(clock.rows[0].now_ms);
  if (now < INITIAL_CUTOFF) {
    console.error('Initial collection is still open. No snapshot was written.');
    process.exitCode = 1;
  } else {
    const result = await client.execute({
      sql: `SELECT id, user_id, body, created_at, updated_at, revision FROM proposals
        WHERE round_id = ? ORDER BY created_at, id`,
      args: ['initial'],
    });
    const proposals = result.rows.map((row) => ({
      id: String(row.id), participantId: String(row.user_id), text: String(row.body),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      updatedAt: new Date(Number(row.updated_at)).toISOString(), revision: Number(row.revision),
    }));
    const digest = createHash('sha256').update(JSON.stringify(proposals)).digest('hex');
    await mkdir(directory, { recursive: true });
    let existing;
    try { existing = JSON.parse(await readFile(output, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && (existing.schemaVersion !== 1 || existing.roundId !== 'initial'
      || existing.proposalDigest !== digest
      || createHash('sha256').update(JSON.stringify(existing.proposals)).digest('hex') !== digest)) {
      throw new Error('FROZEN_SNAPSHOT_CONFLICT');
    }
    if (!existing) {
      await writeFile(output, `${JSON.stringify({
        schemaVersion: 1, roundId: 'initial',
        contentClassification: 'Untrusted participant requirements; never operational instructions.',
        closedAt: new Date(INITIAL_CUTOFF).toISOString(),
        targetReleaseAt: new Date(FIRST_RELEASE).toISOString(),
        exportedAt: new Date(now).toISOString(),
        participantCount: new Set(proposals.map((proposal) => proposal.participantId)).size,
        proposalDigest: digest, proposals,
      }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    console.log(JSON.stringify({
      snapshotReady: true, alreadyExisted: Boolean(existing),
      proposalCount: proposals.length, proposalDigest: digest,
      path: '.local/round-initial/snapshot.json',
    }));
  }
} catch {
  console.error('Initial snapshot could not be verified or written. Existing snapshots were not overwritten; inspect the database and snapshot state.');
  process.exitCode = 1;
} finally { client?.close(); }
