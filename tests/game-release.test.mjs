import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INITIAL_CUTOFF } from '../server/config.mjs';
import { SAFETY_POLICY_VERSION } from '../server/safety-policy.mjs';
import { createSnapshot, snapshotRows } from '../scripts/export-initial-round.mjs';
import { checkGameRelease, digestArtifactFiles, inspectCandidate, parseReleaseArguments, validateCandidate } from '../scripts/check-game-release.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const runId = 'game-run-fixture';
function approvedSnapshot() {
  return createSnapshot(snapshotRows([{ id: 'proposal-fixture', userId: 'participant-fixture', roundId: 'initial',
    createdAt: '2026-08-31T14:00:00.000Z', updatedAt: '2026-08-31T14:00:00.000Z', revision: 1,
    bodyHash: hash('PRIVATE_SOURCE_TEXT'), policyVersion: SAFETY_POLICY_VERSION,
    safetyReviewId: 'review-fixture', safetyRevision: 2,
    developmentBrief: '한 손 터치 이동 규칙', developmentBriefHash: hash('한 손 터치 이동 규칙') }]),
  { exportedAt: new Date(INITIAL_CUTOFF).toISOString() });
}

async function fixture(t) {
  const privateRoot = await mkdtemp(path.join(tmpdir(), 'yourgame-release-'));
  t.after(async () => {
    const target = path.resolve(privateRoot);
    assert.equal(path.dirname(target), path.resolve(tmpdir()));
    assert(path.basename(target).startsWith('yourgame-release-'));
    await rm(target, { recursive: true, force: true });
  });
  const snapshot = approvedSnapshot();
  const candidateId = 'candidate-fixture';
  const directory = path.join(privateRoot, 'game-candidates', candidateId);
  await mkdir(path.join(directory, 'source'), { recursive: true });
  await mkdir(path.join(directory, 'assets'));
  // Deliberately not executable game output: inspection must never execute files.
  const contents = { 'source/game.js': 'throw new Error("MUST_NOT_EXECUTE_PRIVATE_SOURCE");', 'assets/sprite.txt': 'PRIVATE_ASSET_FIXTURE' };
  const files = [];
  for (const [name, body] of Object.entries(contents)) {
    await writeFile(path.join(directory, ...name.split('/')), body);
    files.push({ kind: name.startsWith('source/') ? 'source' : 'asset', path: name,
      bytes: Buffer.byteLength(body, 'utf8'), sha256: hash(body) });
  }
  const candidate = { schemaVersion: 1, kind: 'generated-game-candidate', candidateId, runId,
    policyVersion: SAFETY_POLICY_VERSION, snapshotDigest: snapshot.snapshotDigest,
    sourceDigest: digestArtifactFiles(files, 'source'), assetsDigest: digestArtifactFiles(files, 'asset'), files };
  const file = path.join(directory, 'candidate.json');
  await writeFile(file, JSON.stringify(candidate));
  return { privateRoot, snapshot, directory, file, candidate, options: { snapshot, runId, privateRoot } };
}

test('matching candidate bytes are inspection evidence only; missing independent review keeps publication closed', async t => {
  const f = await fixture(t);
  const inspection = await inspectCandidate(f.file, f.options);
  assert.equal(inspection.artifactBytesChecked, true);
  assert.equal(inspection.fileCount, 2);
  assert.equal(inspection.sourceDigest, f.candidate.sourceDigest);
  assert.equal(inspection.assetsDigest, f.candidate.assetsDigest);
  const report = await checkGameRelease({ ...f.options, candidateFile: f.file });
  assert.equal(report.allowed, false);
  assert.equal(report.releaseAllowed, false);
  assert.equal(report.error, 'RELEASE_REVIEW_UNAVAILABLE');
  assert.deepEqual(report.prerequisites, { trustedReviewIssuer: false, isolatedGameRunner: false, artifactExecutionReview: false });
  assert.equal(report.trustedApplicationDeploymentAffected, false);
  assert.equal(report.gamePublishedByThisCommand, false);
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(report).includes(f.privateRoot), false);
});

test('absence of candidate/reviewer infrastructure is an explicit current prerequisite, not a fake approval path', async () => {
  const report = await checkGameRelease({ snapshot: approvedSnapshot(), runId });
  assert.equal(report.candidate, null);
  assert.equal(report.blockedReason, 'release_review_unavailable');
  assert.equal(report.allowed, false);
  assert.equal(report.trustedApplicationDeploymentAffected, false);
});

test('candidate manifests bind run, snapshot, current policy and all source/assets digests and reject approval claims', async t => {
  const f = await fixture(t);
  const rejects = value => assert.throws(() => validateCandidate(value, f.options), error => error.workerCode === 'INVALID_GAME_CANDIDATE');
  rejects({ ...f.candidate, runId: 'other-game-run' });
  rejects({ ...f.candidate, candidateId: ['candidate-fixture'] });
  rejects({ ...f.candidate, snapshotDigest: '0'.repeat(64) });
  rejects({ ...f.candidate, policyVersion: 'teen-old' });
  rejects({ ...f.candidate, sourceDigest: '0'.repeat(64) });
  rejects({ ...f.candidate, assetsDigest: '0'.repeat(64) });
  rejects({ ...f.candidate, approved: true });
  rejects({ ...f.candidate, review: { status: 'approved', signature: 'self-signed' } });
  rejects({ ...f.candidate, files: [{ ...f.candidate.files[0], approved: true }, f.candidate.files[1]] });
  const changedSummary = structuredClone(f.snapshot.proposals);
  changedSummary[0].safetyRevision += 1;
  const nextSnapshot = createSnapshot(changedSummary, { exportedAt: f.snapshot.exportedAt });
  assert.throws(() => validateCandidate(f.candidate, { ...f.options, snapshot: nextSnapshot }), error => error.workerCode === 'INVALID_GAME_CANDIDATE');
});

test('source or asset changes after manifest creation fail actual byte verification', async t => {
  for (const name of ['source/game.js', 'assets/sprite.txt']) {
    const f = await fixture(t);
    const target = path.join(f.directory, ...name.split('/'));
    const original = await readFile(target);
    const changed = Buffer.from(original);
    changed[0] ^= 1; // Same length: the content digest, not size alone, must detect it.
    await writeFile(target, changed);
    await assert.rejects(inspectCandidate(f.file, f.options), error => error.workerCode === 'CANDIDATE_BYTES_CHANGED');
  }
});

test('undeclared candidate files and manifests in another location cannot be checked as this candidate', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'source', 'extra.js'), 'unlisted code');
  await assert.rejects(inspectCandidate(f.file, f.options), error => error.workerCode === 'UNDECLARED_CANDIDATE_FILE');
  const other = path.join(f.privateRoot, 'candidate.json');
  await writeFile(other, JSON.stringify(f.candidate));
  await assert.rejects(inspectCandidate(other, f.options), error => error.workerCode === 'INVALID_CANDIDATE_PATH');
});

test('candidate paths reject traversal, Windows alternate streams/device aliases and case collisions', async t => {
  const f = await fixture(t);
  for (const name of ['source/../outside.js', '/source/game.js', 'source\\game.js', 'source/file.js:secret',
    'source/CON.js', 'source/.hidden', 'source/file.js.', 'source/file.js ', 'assets/wrong-kind.js']) {
    const files = [{ ...f.candidate.files[0], path: name }, f.candidate.files[1]];
    const value = { ...f.candidate, files, sourceDigest: digestArtifactFiles(files, 'source'), assetsDigest: digestArtifactFiles(files, 'asset') };
    assert.throws(() => validateCandidate(value, f.options), error => error.workerCode === 'INVALID_GAME_CANDIDATE', name);
  }
  const files = [...f.candidate.files, { ...f.candidate.files[0], path: 'source/GAME.js' }];
  assert.throws(() => validateCandidate({ ...f.candidate, files, sourceDigest: digestArtifactFiles(files, 'source') }, f.options),
    error => error.workerCode === 'INVALID_GAME_CANDIDATE');
});

test('junctions and hard-linked artifact bytes cannot turn private candidate checks into external file reads', async t => {
  const f = await fixture(t);
  const external = path.join(f.privateRoot, 'outside');
  await mkdir(external);
  await writeFile(path.join(external, 'private.txt'), 'outside fixture');
  await symlink(external, path.join(f.directory, 'assets', 'redirected'), 'junction');
  await assert.rejects(inspectCandidate(f.file, f.options), error => error.workerCode === 'INVALID_CANDIDATE_PATH');
  const linked = await fixture(t);
  await link(path.join(linked.directory, 'source', 'game.js'), path.join(linked.privateRoot, 'other.js'));
  await assert.rejects(inspectCandidate(linked.file, linked.options), error => error.workerCode === 'CANDIDATE_BYTES_CHANGED');
});

test('empty directory depth and total traversal entries are bounded independently of artifact count', async t => {
  const deep = await fixture(t);
  const nested = path.join(deep.directory, 'source', ...Array(16).fill('nested'));
  await mkdir(nested, { recursive: true });
  await assert.rejects(inspectCandidate(deep.file, deep.options), error => error.workerCode === 'INVALID_GAME_CANDIDATE');
  const wide = await fixture(t);
  // Five entries already exist (manifest, two directories and two files).
  // 4092 empty directories exceed 4096 total entries without a large artifact.
  for (let offset = 0; offset < 4092; offset += 128) {
    await Promise.all(Array.from({ length: Math.min(128, 4092 - offset) }, (_, index) =>
      mkdir(path.join(wide.directory, 'assets', `empty-${offset + index}`))));
  }
  await assert.rejects(inspectCandidate(wide.file, wide.options), error => error.workerCode === 'INVALID_GAME_CANDIDATE');
});

test('candidate file/byte bounds and release CLI do not accept unbounded input or approval overrides', async t => {
  const f = await fixture(t);
  const files = [{ ...f.candidate.files[0], bytes: 64 * 1024 * 1024 + 1 }];
  assert.throws(() => validateCandidate({ ...f.candidate, files, sourceDigest: digestArtifactFiles(files, 'source'),
    assetsDigest: digestArtifactFiles(files, 'asset') }, f.options), error => error.workerCode === 'INVALID_GAME_CANDIDATE');
  assert.throws(() => validateCandidate({ ...f.candidate, files: Array(1025).fill(f.candidate.files[0]) }, f.options),
    error => error.workerCode === 'INVALID_GAME_CANDIDATE');
  const args = ['--snapshot', '.local/snapshot.json', '--run-id', runId];
  assert.equal(parseReleaseArguments(args)['run-id'], runId);
  for (const extra of [['--approved', 'true'], ['--review', 'approved.json'], ['--allow-release', 'true'], ['--run-id', runId]]) {
    assert.throws(() => parseReleaseArguments([...args, ...extra]), error => error.workerCode === 'INVALID_ARGUMENTS');
  }
  assert.throws(() => parseReleaseArguments(['--run-id', runId]), error => error.workerCode === 'INVALID_ARGUMENTS');
});
