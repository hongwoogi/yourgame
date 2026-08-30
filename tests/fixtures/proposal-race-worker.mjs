import { parentPort, workerData } from 'node:worker_threads';
import { readConfig } from '../../server/config.mjs';
import { openDatabase } from '../../server/database.mjs';
import { createStore } from '../../server/store.mjs';

const client = await openDatabase(readConfig({ TURSO_DATABASE_URL: workerData.databaseUrl }), { initialize: Boolean(workerData.seed) });
if (workerData.seed) {
  await client.batch([
    'CREATE TABLE test_clock(id INTEGER PRIMARY KEY, now_ms INTEGER NOT NULL)',
    { sql: 'INSERT INTO test_clock(id, now_ms) VALUES (1, ?)', args: [workerData.now] },
    {
      sql: 'INSERT INTO users(id, google_sub, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      args: [workerData.userId, 'race-user', 'Race participant', workerData.now, workerData.now],
    },
  ], 'write');
}
const store = createStore(client, { databaseClockSql: '(SELECT now_ms FROM test_clock WHERE id = 1)' });
parentPort.postMessage({ ready: true });
parentPort.once('message', async () => {
  const results = [];
  for (let index = 0; index < 8; index += 1) {
    try {
      await store.createProposal(workerData.userId, {
        body: `parallel ${workerData.number}-${index}`,
        requestId: `worker-${workerData.number}-request-${index}`,
      });
      results.push(201);
    } catch (error) {
      results.push(error.status || error.code || 'unknown');
    }
  }
  const count = (await store.listProposals(workerData.userId)).proposals.length;
  client.close();
  parentPort.postMessage({ results, count });
  parentPort.close();
});
