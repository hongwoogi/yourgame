import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { stageContractFor, runStage, assertStageCycle, assertStageBinding } from '../scripts/run-game-team-stage.mjs';
import { dailyCycleForDate } from '../server/daily-schedule.mjs';

test('daily stages continue the verified baseline without first-game fixed requests', () => {
  for (const stage of ['plan','scenario','art','gameplay','assets','validation']) {
    const contract = stageContractFor({ stage, gameVersion:'v20260902', baselineVersion:'v1-20260901' });
    assert.equal(typeof contract, 'string');
    assert.doesNotMatch(contract, /Exactly six|Six founder|Sam health|Yann|gameVersion MUST be v1-/);
  }
  assert.match(stageContractFor({ stage:'gameplay', gameVersion:'v20260902', baselineVersion:'v1-20260901' }), /gameVersion MUST be v20260902/);
  assert.match(stageContractFor({ stage:'scenario', gameVersion:'v20260902', baselineVersion:'v1-20260901' }), /Unsupported requirements/);
});

test('first-release repair instructions cannot run against a daily baseline', () => {
  for (const stage of ['copyfix','balancefix','assetsfix','validationfix']) {
    assert.throws(() => stageContractFor({ stage, gameVersion:'v20260902', baselineVersion:'v1-20260901' }), /INVALID_STAGE/);
  }
  assert.match(stageContractFor({ stage:'balancefix', gameVersion:'v1-20260901' }), /Sam health/);
});

test('immutable version changes and bounded retry arguments fail before I/O', async () => {
  for (const gameVersion of ['v1-20260901','../outside','']) {
    assert.throws(() => stageContractFor({ stage:'gameplay', gameVersion, baselineVersion:'v1-20260901' }), /INVALID_STAGE/);
  }
  await assert.rejects(runStage({ stage:'plan',runId:'daily-synthetic',workerId:'worker-synthetic',attempt:4 }), /INVALID_STAGE/);
});

test('daily production binds snapshot timing and immutable source dates to the actual run ancestry', () => {
  const cycle = dailyCycleForDate('2026-09-01');
  const snapshot = { roundId:'pending',closedAt:cycle.closesAt,targetReleaseAt:cycle.releaseAt,
    proposals:[{createdAt:cycle.opensAt,updatedAt:cycle.opensAt}] };
  assert.doesNotThrow(() => assertStageCycle(snapshot, cycle));
  assert.doesNotThrow(() => assertStageCycle({roundId:'initial'}, null));
  for (const invalid of [
    {...snapshot,roundId:'initial'}, {...snapshot,closedAt:'2026-09-02T14:00:00.000Z'},
    {...snapshot,targetReleaseAt:'2026-09-01T14:00:00.000Z'},
    {...snapshot,proposals:[{createdAt:cycle.closesAt,updatedAt:cycle.closesAt}]},
    {...snapshot,proposals:[{createdAt:cycle.opensAt,updatedAt:cycle.closesAt}]},
  ]) assert.throws(() => assertStageCycle(invalid, cycle), /INPUT_GATE_BLOCKED/);
  assert.throws(() => assertStageCycle(snapshot, dailyCycleForDate('2026-09-02')), /INPUT_GATE_BLOCKED/);
  assert.throws(() => assertStageCycle(snapshot, null), /INPUT_GATE_BLOCKED/);
});

test('upstream bytes and baseline lineage cannot be mixed on resume', () => {
  const bytes=Buffer.from('{"synthetic":true}\n');
  const binding={runId:'synthetic-run',snapshotDigest:'snapshot',sha256:createHash('sha256').update(bytes).digest('hex'),
    bytes:bytes.length,actualGeneration:true,tools:0,roleComplete:true,baselineDigest:'pinned'};
  const expected={runId:binding.runId,snapshotDigest:binding.snapshotDigest,bytes,baselineDigest:'pinned'};
  assert.doesNotThrow(()=>assertStageBinding(binding,expected));
  for(const invalid of [{...binding,baselineDigest:'other'},{...binding,runId:'other'},{...binding,snapshotDigest:'other'},
    {...binding,sha256:'changed'},{...binding,actualGeneration:false},{...binding,tools:1},null]) {
    assert.throws(()=>assertStageBinding(invalid,expected),/ARTIFACT_INVALID/);
  }
});
