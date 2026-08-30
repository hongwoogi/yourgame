import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseWorkerArguments, runWorkerCommand, safeWorkerState } from '../scripts/admin-worker.mjs';
import { createSnapshot, snapshotBindings, snapshotRows } from '../scripts/export-initial-round.mjs';
import { SAFETY_POLICY_VERSION } from '../server/safety-policy.mjs';

const service = { mode: 'active', proposalsEnabled: true, developmentEnabled: true, revision: 3, message: 'PRIVATE_NOTICE' };
const run = { id: 'test-run-id', status: 'running', revision: 2, label: 'PRIVATE_LABEL', summary: 'PRIVATE_SUMMARY',
  parentId: null, cancelRequested: false, commitSha: null, createdAt: '2026-08-31T14:00:00.000Z', updatedAt: '2026-08-31T14:00:00.000Z' };
const state = { service, run, allowed: true, blockedReason: null,
  snapshot: { checked: true, allEligible: true, bindingsChecked: true, allBindingsMatch: true } };
const textHash = value => createHash('sha256').update(value).digest('hex');
const liveProposal = { id: 'proposal-one', userId: 'participant-one', roundId: 'initial',
  createdAt: run.createdAt, updatedAt: run.createdAt, revision: 1,
  bodyHash: textHash('PRIVATE_ORIGINAL'), policyVersion: SAFETY_POLICY_VERSION,
  safetyReviewId: 'safety-review-one', safetyRevision: 1,
  developmentBrief: 'touch controls', developmentBriefHash: textHash('touch controls') };
const emptySnapshot = createSnapshot([], { exportedAt: run.createdAt });
const snapshot = createSnapshot(snapshotRows([liveProposal]), { exportedAt: run.createdAt });
const proposal = snapshot.proposals[0];

test('worker arguments require explicit revision and ownership and cannot smuggle operational commands', () => {
  for (const args of [[], ['shutdown'], ['status', '--allow', 'true'], ['gate'], ['gate', '--snapshot', 'some.json'], ['claim', '--run-id', '../private'],
    ['status', '--round', 'another'], ['status', '--round', 'initial', '--run-id', run.id], ['status', '--round', 'pending', '--snapshot', 'some.json'],
    ['input-gate'], ['release-gate'], ['release-gate', '--run-id', run.id, '--snapshot', 'some.json', '--approved', 'true'],
    ['update', '--run-id', 'test-run-id', '--revision', '2', '--worker-id', 'test-worker', '--status', 'completed'],
    ['claim', '--run-id', 'test-run-id', '--revision', '2;anything', '--worker-id', 'test-worker']]) {
    assert.throws(() => parseWorkerArguments(args));
  }
  assert.equal(parseWorkerArguments(['claim', '--run-id', 'test-run-id', '--revision', '2', '--worker-id', 'test-worker']).revision, 2);
});

test('status can explicitly select one intake round without claiming input or publication readiness', async () => {
  const counts = { total: 3, eligible: 1, pendingSafety: 1, heldSafety: 1, blockedSafety: 0, approvedSafety: 1 };
  const options = parseWorkerArguments(['status', '--round', 'initial']);
  let queried;
  const report = await runWorkerCommand(options, { store: { readWorkerState: async args => {
    queried = args;
    return { ...state, run: null, intake: { ...counts, sourceBody: 'PRIVATE_BODY' } };
  } } });
  assert.equal(queried.roundId, 'initial');
  assert.equal(queried.runId, undefined);
  assert.deepEqual(report.intake, counts);
  assert.equal(report.roundId, 'initial');
  assert.equal(report.inputReady, false);
  assert.equal(report.releaseAllowed, false);
  assert.equal(report.scope, 'operational_state_only');
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  const pending = await runWorkerCommand({ command: 'status', round: 'pending' }, { store: { readWorkerState: async args => {
    assert.equal(args.roundId, 'pending');
    return { ...state, run: null, intake: counts };
  } } });
  assert.equal(pending.roundId, 'pending');
});

test('round intake status fails closed on missing or inconsistent counts and conflicting run/snapshot options', async () => {
  const dependencies = { store: { readWorkerState: async () => state } };
  await assert.rejects(runWorkerCommand({ command: 'status', round: 'initial' }, dependencies), error => error.workerCode === 'STATE_UNAVAILABLE');
  for (const values of [{ snapshot: 'some.json' }, { 'run-id': run.id }, { round: 'unknown' }]) {
    await assert.rejects(runWorkerCommand({ command: 'status', round: 'initial', ...values }, dependencies), error => error.workerCode === 'INVALID_ARGUMENTS');
  }
  assert.throws(() => safeWorkerState({ ...state, intake: { total: 1, eligible: 0, pendingSafety: 1,
    heldSafety: 1, blockedSafety: 0, approvedSafety: 0 } }), error => error.workerCode === 'STATE_UNAVAILABLE');
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

test('input-gate refuses changed service revision even when service has been reopened', async () => {
  const report = await runWorkerCommand({ command: 'input-gate', 'service-revision': 2, 'run-id': run.id, snapshot: 'fixture.json' }, {
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

test('running progress carries current control revision and exact safety bindings into the atomic store mutation', async () => {
  let input;
  const store = {
    readWorkerState: async () => state, listEligibleProposals: async () => [liveProposal],
    updateRun: async value => { input = value; return { ...run, status: value.status }; },
  };
  const report = await runWorkerCommand({ command: 'update', 'run-id': run.id, revision: 2, 'worker-id': 'test-worker',
    status: 'running', snapshot: 'fixture.json' }, { store, loadSnapshot: async () => snapshot });
  assert.deepEqual(input.proposalIds, [proposal.id]);
  assert.equal(input.roundId, 'initial');
  assert.equal(input.serviceRevision, 3);
  assert.deepEqual(input.bindings, snapshotBindings(snapshot));
  assert.equal(report.updated, true);
  assert.equal(report.gamePublishedByThisCommand, false);
  assert.equal(report.releaseAllowed, false);
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

test('the legacy gate fails closed with an explicit migration instead of silently becoming publication permission', async () => {
  const report = await runWorkerCommand({ command: 'gate', 'run-id': run.id, snapshot: 'fixture.json' }, {
    store: { readWorkerState: async () => assert.fail('legacy migration needs no DB authority') },
  });
  assert.equal(report.allowed, false);
  assert.equal(report.error, 'LEGACY_GATE_REQUIRES_EXPLICIT_STAGE');
  assert.match(report.migration, /input-gate/);
  assert.match(report.migration, /release-gate/);
});

test('approved input readiness is separate from unavailable generated-game release verification', async () => {
  const dependencies = { store: { readWorkerState: async () => state, listEligibleProposals: async () => [liveProposal] },
    loadSnapshot: async () => snapshot };
  const input = await runWorkerCommand({ command: 'input-gate', 'run-id': run.id, snapshot: 'fixture.json' }, dependencies);
  assert.equal(input.allowed, true);
  assert.equal(input.inputReady, true);
  assert.equal(input.releaseAllowed, false);
  const release = await runWorkerCommand({ command: 'release-gate', 'run-id': run.id, snapshot: 'fixture.json' }, dependencies);
  assert.equal(release.inputReady, true);
  assert.equal(release.allowed, false);
  assert.equal(release.error, 'RELEASE_REVIEW_UNAVAILABLE');
  assert.equal(release.prerequisites.trustedReviewIssuer, false);
  assert.equal(release.trustedApplicationDeploymentAffected, false);
});

test('completed cannot be recorded without independent artifact review even when every source approval is current', async () => {
  let updates = 0;
  const report = await runWorkerCommand({ command: 'update', 'run-id': run.id, revision: 2,
    'worker-id': 'test-worker', status: 'completed', snapshot: 'fixture.json' }, {
    store: { readWorkerState: async () => state, listEligibleProposals: async () => [liveProposal],
      updateRun: async () => { updates += 1; } }, loadSnapshot: async () => snapshot,
  });
  assert.equal(report.updated, false);
  assert.equal(report.error, 'RELEASE_REVIEW_UNAVAILABLE');
  assert.equal(report.releaseAllowed, false);
  assert.equal(updates, 0);
  assert(!JSON.stringify(report).includes('PRIVATE_'));
});

test('old stores that ignore exact safety bindings cannot authorize input use', async () => {
  const report = await runWorkerCommand({ command: 'input-gate', 'run-id': run.id, snapshot: 'fixture.json' }, {
    store: { readWorkerState: async () => ({ ...state, snapshot: { checked: true, allEligible: true } }),
      listEligibleProposals: async () => assert.fail('missing binding verification stops before reading summaries') },
    loadSnapshot: async () => snapshot,
  });
  assert.equal(report.allowed, false);
  assert.equal(report.blockedReason, 'safety_binding_unverified');
});

test('an approval changed after reading summaries is rejected at the final exact binding checkpoint', async () => {
  let reads = 0;
  const report = await runWorkerCommand({ command: 'input-gate', 'run-id': run.id, snapshot: 'fixture.json' }, {
    store: {
      readWorkerState: async args => {
        assert.deepEqual(args.bindings, snapshotBindings(snapshot));
        reads += 1;
        return reads === 1 ? state : { ...state, allowed: false, blockedReason: 'safety_binding_changed',
          snapshot: { ...state.snapshot, allBindingsMatch: false } };
      },
      listEligibleProposals: async () => [liveProposal],
    }, loadSnapshot: async () => snapshot,
  });
  assert.equal(reads, 2);
  assert.equal(report.allowed, false);
  assert.equal(report.blockedReason, 'safety_binding_changed');
});
