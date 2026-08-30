import { parentPort, workerData } from 'node:worker_threads';
import { readConfig } from '../../server/config.mjs';
import { openDatabase } from '../../server/database.mjs';
import { createCommunityStore } from '../../server/community-store.mjs';

const client = await openDatabase(readConfig({ TURSO_DATABASE_URL: workerData.databaseUrl }), { initialize: false });
const store = createCommunityStore(client, { databaseClockSql: '(SELECT now_ms FROM test_clock WHERE id = 1)' });
parentPort.postMessage({ ready: true });
parentPort.once('message', async () => {
  const outcomes = [];
  try {
    for (const input of workerData.inputs) {
      try {
        await store.mutate(workerData.session, input);
        outcomes.push('accepted');
      } catch (error) {
        outcomes.push(error.code || 'unknown');
      }
    }
    const state = await store.privateState(workerData.session);
    parentPort.postMessage({ outcomes, used: state.voteQuota.used });
  } finally {
    client.close();
    parentPort.close();
  }
});
