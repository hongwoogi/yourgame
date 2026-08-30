import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseWorkerArguments, runWorkerCommand, safeWorkerState } from '../scripts/admin-worker.mjs';

const service = { mode: 'active', proposalsEnabled: true, developmentEnabled: true, revision: 3, message: 'PRIVATE_NOTICE' };
const run = { id: 'test-run-id', status: 'running', revision: 2, label: 'PRIVATE_LABEL', summary: 'PRIVATE_SUMMARY',
  parentId: null, cancelRequested: false, commitSha: null, createdAt: '2026-08-31T14:00:00.000Z', updatedAt: '2026-08-31T14:00:00.000Z' };
const state = { service, run, allowed: true, blockedReason: null, snapshot: { checked: false, allEligible: true } };
const emptySnapshot = { schemaVersion: 1, roundId: 'initial', proposals: [],
  proposalDigest: createHash('sha256').update('[]').digest('hex') };
const proposal = { id: 'proposal-one', participantId: 'participant-one', text: 'touch controls',
  createdAt: run.createdAt, updatedAt: run.createdAt, revision: 1 };
const snapshot = { ...emptySnapshot, proposals: [proposal],
  proposalDigest: createHash('sha256').update(JSON.stringify([proposal])).digest('hex') };
const liveProposal = { id: proposal.id, userId: proposal.participantId, body: proposal.text,
  revision: proposal.revision, createdAt: proposal.createdAt, updatedAt: proposal.updatedAt };

test('worker arguments require explicit revision and ownership and cannot smuggle operational commands', () => {
  for (const args of [[], ['shutdown'], ['status', '--allow', 'true'], ['gate'], ['gate', '--snapshot', 'some.json'], ['claim', '--run-id', '../private'],
    ['update', '--run-id', 'test-run-id', '--revision', '2', '--worker-id', 'test-worker', '--status', 'completed'],
    ['claim', '--run-id', 'test-run-id', '--revision', '2;anything', '--worker-id', 'test-worker']]) {
    assert.throws(() => parseWorkerArguments(args));
  }
  assert.equal(parseWorkerArguments(['claim', '--run-id', 'test-run-id', '--revision', '2', '--worker-id', 'test-worker']).revision, 2);
});

test('status exposes only safe control metadata and preserves intentional closure instead of repairing it', async () => {
  const ended = { ...state, allowed: false, blockedReason: 'service_ended', service: { ...service, mode: 'ended', developmentEnabled: false } };
  const report = await runWorkerCommand({ command: 'status' }, { store: { readWorkerState: async () => ended } });
  assert.equal(report.allowed, false);
  assert.equal(report.blockedReason, 'service_ended');
  assert.equal(report.service.mode, 'ended');
  assert(!JSON.stringify(report).includes('PRIVATE_'));
  assert.throws(() => safeWorkerState({ service }), error => error.workerCode === 'STATE_UNAVAILABLE');
  await assert.rejects(runWorkerCommand({ command: 'status' }, { store: { readWorkerState: async () => { throw new Error('database offline'); } } }));
});

test('gate refuses changed service revision even when service has been reopened', async () => {
  const report = await runWorkerCommand({ command: 'gate', 'service-revision': 2, 'run-id': run.id, snapshot: 'fixture.json' }, {
    store: { readWorkerState: async () => state, listEligibleProposals: async () => [liveProposal] }, loadSnapshot: async () => snapshot });
  assert.equal(report.allowed, false);
  assert.equal(report.blockedReason, 'service_changed');
});

test('cancelled or ended work cannot be completed but its cancellation may still be recorded', async () => {
  let updates = 0;
  const store = {
    readWorkerState: async () => ({ ...state, allowed: false, blockedReason: 'cancel_requested' }),
    updateRun: async input => { updates += 1; return { ...run, status: input.status }; },
  };
  const args = { command: 'update', 'run-id': run.id, revision: 2, 'worker-id': 'test-worker', status: 'completed', snapshot: 'fixture.json' };
  const report = await runWorkerCommand(args, { store, loadSnapshot: async () => emptySnapshot });
  assert.equal(report.updated, false);
  assert.equal(updates, 0);
  const cancelled = await runWorkerCommand({ ...args, status: 'cancelled' }, { store });
  assert.equal(cancelled.updated, true);
  assert.equal(cancelled.run.status, 'cancelled');
  assert.equal(updates, 1);
  assert.equal(cancelled.gamePublishedByThisCommand, false);
});

test('completed record carries current control revision and exact input IDs into the atomic store mutation', async () => {
  let input;
  const store = {
    readWorkerState: async () => state, listEligibleProposals: async () => [liveProposal],
    updateRun: async value => { input = value; return { ...run, status: value.status }; },
  };
  const report = await runWorkerCommand({ command: 'update', 'run-id': run.id, revision: 2, 'worker-id': 'test-worker',
    status: 'completed', snapshot: 'fixture.json' }, { store, loadSnapshot: async () => snapshot });
  assert.deepEqual(input.proposalIds, [proposal.id]);
  assert.equal(input.roundId, 'initial');
  assert.equal(input.serviceRevision, 3);
  assert.equal(report.updated, true);
  assert.equal(report.gamePublishedByThisCommand, false);
  assert(!JSON.stringify(report).includes('PRIVATE_'));
});

test('an empty frozen snapshot never authorizes a completed development record', async () => {
  const report = await runWorkerCommand({ command: 'update', 'run-id': run.id, revision: 2, 'worker-id': 'test-worker',
    status: 'completed', snapshot: 'fixture.json' }, {
    store: { readWorkerState: async () => state, updateRun: async () => assert.fail('empty input must never complete') },
    loadSnapshot: async () => emptySnapshot,
  });
  assert.equal(report.allowed, false);
  assert.equal(report.blockedReason, 'no_eligible_proposals');
  assert.equal(report.updated, false);
});
