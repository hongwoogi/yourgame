import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseContributionSettlementArgs, loadContributionSettlementPlan,
  contributionReviewGroupDigest } from '../scripts/operator-contribution-settlement.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hash = digit => digit.repeat(64);
const code = expected => error => (error.operatorCode || error.workerCode || error.code) === expected;

async function removeFixture(target, root) {
  const relative = path.relative(root, path.resolve(target));
  assert.ok(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)));
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const child = path.resolve(target, entry.name);
    assert.equal(path.dirname(child), path.resolve(target));
    if (entry.isDirectory() && !entry.isSymbolicLink()) await removeFixture(child, root);
    else await unlink(child);
  }
  await rmdir(target);
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'yourgame-settlement-cli-'));
  t.after(() => removeFixture(directory, directory));
  const privateRoot = path.join(directory, 'private');
  await mkdir(privateRoot);
  const planFile = path.join(privateRoot, 'plan.json');
  const reviewFile = path.join(privateRoot, 'review.json');
  const artifactFile = path.join(privateRoot, 'evidence.json');
  const artifactBytes = Buffer.from('{"syntheticPlayback":"verified locally in fixture"}\n');
  await writeFile(artifactFile, artifactBytes);
  const releaseBinding = { candidateId: 'fixture-candidate', policyVersion: 'teen-v1', snapshotDigest: hash('a'),
    sourceDigest: hash('b'), assetsDigest: hash('c'), gameVersion: 'fixture-v1', contentSha256: hash('d'),
    runtimeDigest: hash('e'), evidenceDigest: hash('f') };
  const proposalId = randomUUID();
  const finding = { requirementGroupId: 'mobile-exploration', fulfillmentId: 'mobile-exploration-v1',
    proposalIds: [proposalId], fulfillment: 'partial', finding: 'Touch navigation is implemented in the synthetic candidate.',
    implementation: ['Drag movement follows the touch position.'], evidenceRefs: [0], limitations: ['No controller support.'] };
  const review = { schemaVersion: 1, kind: 'operator_contribution_fulfillment_review', operatorId: 'fixture-operator',
    authorizationRef: 'fixture:contribution', reviewId: randomUUID(), runId: randomUUID(), releaseBinding,
    reviewedAt: '2026-09-01T01:10:00+09:00', artifacts: [{ path: 'private/evidence.json', sha256: sha256(artifactBytes) }],
    groups: [finding] };
  const plan = { schemaVersion: 1, requestId: randomUUID(), operatorId: review.operatorId, authorizationRef: review.authorizationRef,
    serviceRevision: 1, publicationRevision: 2, reviewId: review.reviewId, runId: review.runId, runRevision: 3,
    releaseBinding: structuredClone(releaseBinding), bindings: [{ id: proposalId, revision: 1, bodyHash: hash('1'),
      policyVersion: 'teen-v1', safetyReviewId: randomUUID(), safetyRevision: 2, developmentBriefHash: hash('2') }],
    formula: 'weighted', reviewEvidenceDigest: '', groups: [{ requirementGroupId: finding.requirementGroupId,
      fulfillmentId: finding.fulfillmentId, proposalIds: [...finding.proposalIds], fulfillment: finding.fulfillment,
      evidenceDigest: contributionReviewGroupDigest(finding) }] };
  async function save({ rebindReview = true, rebindGroups = false } = {}) {
    const bytes = Buffer.from(JSON.stringify(review, null, 2));
    if (rebindReview) plan.reviewEvidenceDigest = sha256(bytes);
    if (rebindGroups) for (const group of plan.groups) {
      const current = review.groups.find(item => item.requirementGroupId === group.requirementGroupId);
      if (current) group.evidenceDigest = contributionReviewGroupDigest(current);
    }
    await writeFile(reviewFile, bytes);
    await writeFile(planFile, JSON.stringify(plan, null, 2));
  }
  await save();
  return { directory, privateRoot, planFile, reviewFile, artifactFile, artifactBytes, plan, review, save,
    options: { privateRoot, projectRoot: directory },
    load: () => loadContributionSettlementPlan(planFile, reviewFile, { privateRoot, projectRoot: directory }) };
}

test('the CLI accepts only explicit prepare, preview and apply commands with complete unique flags', () => {
  assert.deepEqual(parseContributionSettlementArgs(['--help']), { help: true });
  assert.deepEqual(parseContributionSettlementArgs(['prepare', '--service-revision', '12']), { command: 'prepare', 'service-revision': '12' });
  for (const command of ['preview', 'apply']) assert.deepEqual(parseContributionSettlementArgs([command,
    '--review', '.local/review.json', '--output', '.local/result.json', '--plan', '.local/plan with spaces.json']), {
    command, review: '.local/review.json', output: '.local/result.json', plan: '.local/plan with spaces.json',
  });
  for (const args of [[], ['apply'], ['settle', '--plan', 'p', '--review', 'r', '--output', 'o'],
    ['--help', '--plan', 'p'], ['preview', '--plan', 'p', '--review', 'r'],
    ['apply', '--plan', 'p', '--plan', 'r', '--output', 'o'],
    ['apply', '--plan', 'p', '--review', 'r', '--unknown', 'o'],
    ['apply', '--plan', '', '--review', 'r', '--output', 'o'],
    ['apply', '--plan', '--help', '--review', 'r', '--output', 'o'],
    ['prepare', '--service-revision', '1', '--plan', 'p'],
    ...['0', '-1', '01', '+1', '1.0', '1e2', 'Infinity', '9007199254740992'].map(value => ['prepare', '--service-revision', value])]) {
    assert.throws(() => parseContributionSettlementArgs(args), code('CONTRIBUTION_INVALID_COMMAND'));
  }
});

test('unchanged private files bind the exact plan without DB access, output files, or file mutations', async t => {
  const f = await fixture(t);
  const files = await readdir(f.privateRoot);
  const before = await Promise.all(files.map(name => readFile(path.join(f.privateRoot, name))));
  assert.deepEqual(await f.load(), f.plan);
  assert.deepEqual(await readdir(f.privateRoot), files);
  assert.deepEqual(await Promise.all(files.map(name => readFile(path.join(f.privateRoot, name)))), before);
});

test('group evidence digest is canonical for object order but binds findings, limitations and proposal order', () => {
  const group = { requirementGroupId: 'navigation', fulfillmentId: 'navigation-v1', proposalIds: ['proposal-a', 'proposal-b'],
    fulfillment: 'full', finding: 'Synthetic reviewed finding', implementation: ['Touch controls'], evidenceRefs: [0], limitations: [] };
  const digest = contributionReviewGroupDigest(group);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(contributionReviewGroupDigest(Object.fromEntries(Object.entries(group).reverse())), digest);
  for (const change of [{ fulfillmentId: 'navigation-v2' }, { fulfillment: 'partial' },
    { finding: 'Different finding' }, { limitations: ['Unverified save behavior'] }, { evidenceRefs: [1] },
    { proposalIds: ['proposal-b', 'proposal-a'] }]) assert.notEqual(contributionReviewGroupDigest({ ...group, ...change }), digest);
});

test('review byte changes are rejected even when their parsed JSON is equivalent', async t => {
  const f = await fixture(t);
  const bytes = await readFile(f.reviewFile);
  await writeFile(f.reviewFile, Buffer.concat([bytes, Buffer.from('\n')]));
  await assert.rejects(f.load(), code('CONTRIBUTION_REVIEW_MISMATCH'));
});

test('changed artifact bytes do not inherit a previously reviewed hash', async t => {
  const f = await fixture(t);
  await writeFile(f.artifactFile, '{"syntheticPlayback":"changed but not reviewed"}');
  await assert.rejects(f.load(), code('CONTRIBUTION_REVIEW_MISMATCH'));
});

test('a new review hash cannot substitute another operator, authorization, run, review or release', async t => {
  for (const [key, value] of [['operatorId', 'different-operator'], ['authorizationRef', 'other:authorization'],
    ['reviewId', randomUUID()], ['runId', randomUUID()], ['releaseBinding', { sourceDigest: hash('9') }]]) await t.test(key, async t => {
    const f = await fixture(t);
    f.review[key] = key === 'releaseBinding' ? { ...f.review.releaseBinding, ...value } : value;
    await f.save();
    await assert.rejects(f.load(), code('CONTRIBUTION_REVIEW_MISMATCH'));
  });
});

test('group bindings reject renamed requirements, changed fulfillment, proposals, status and stale finding digests', async t => {
  const changes = [{ requirementGroupId: 'unreviewed-group' }, { fulfillmentId: 'unreviewed-change' },
    { proposalIds: [randomUUID()] }, { fulfillment: 'full' }, { evidenceDigest: hash('9') }];
  for (const change of changes) await t.test(Object.keys(change)[0], async t => {
    const f = await fixture(t);
    Object.assign(f.plan.groups[0], change);
    await f.save();
    await assert.rejects(f.load(), code('CONTRIBUTION_REVIEW_MISMATCH'));
  });
});

test('self-approval fields, incomplete findings and invalid evidence references fail despite freshly rebound hashes', async t => {
  const changes = [{ approved: true }, { finding: '' }, { finding: 'invalid\0finding' },
    { implementation: [] }, { implementation: [''] }, { limitations: [null] },
    { evidenceRefs: [] }, { evidenceRefs: [1] }, { evidenceRefs: [-1] }, { evidenceRefs: [0.5] }, { evidenceRefs: [0, 0] }];
  for (const [index, change] of changes.entries()) await t.test(`invalid finding ${index + 1}`, async t => {
    const f = await fixture(t);
    Object.assign(f.review.groups[0], change);
    await f.save({ rebindGroups: true });
    await assert.rejects(f.load(), code('CONTRIBUTION_REVIEW_MISMATCH'));
  });
});

test('duplicate artifact aliases and duplicate reviewed groups cannot inflate reviewed evidence', async t => {
  const f = await fixture(t);
  f.review.artifacts.push({ ...f.review.artifacts[0], path: 'private/./evidence.json' });
  await f.save();
  await assert.rejects(f.load(), code('CONTRIBUTION_REVIEW_MISMATCH'));
  f.review.artifacts.pop();
  f.review.groups.push(structuredClone(f.review.groups[0]));
  f.plan.groups.push(structuredClone(f.plan.groups[0]));
  await f.save();
  await assert.rejects(f.load(), code('CONTRIBUTION_REVIEW_MISMATCH'));
});

test('plan and review paths cannot escape the private root', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside.json');
  await writeFile(outside, await readFile(f.planFile));
  await assert.rejects(loadContributionSettlementPlan(outside, f.reviewFile, f.options), code('INVALID_PRIVATE_FILE'));
  await writeFile(outside, await readFile(f.reviewFile));
  await assert.rejects(loadContributionSettlementPlan(f.planFile, outside, f.options), code('INVALID_PRIVATE_FILE'));
});

test('artifact traversal, absolute outside paths and junction escapes are rejected before loading their contents', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside');
  await mkdir(outside);
  const outsideFile = path.join(outside, 'canary.json');
  await writeFile(outsideFile, f.artifactBytes);
  for (const artifactPath of ['private/../outside/canary.json', outsideFile]) {
    f.review.artifacts[0].path = artifactPath;
    await f.save();
    await assert.rejects(f.load(), code('INVALID_PRIVATE_FILE'));
  }
  const link = path.join(f.privateRoot, 'external-link');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  f.review.artifacts[0].path = 'private/external-link/canary.json';
  await f.save();
  await assert.rejects(f.load(), code('INVALID_PRIVATE_FILE'));
  assert.deepEqual(await readFile(outsideFile), f.artifactBytes);
});

test('a redirected private root cannot weaken the path boundary', async t => {
  const f = await fixture(t);
  const alias = path.join(f.directory, 'private-alias');
  await symlink(f.privateRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(loadContributionSettlementPlan(path.join(alias, 'plan.json'), path.join(alias, 'review.json'), {
    privateRoot: alias, projectRoot: f.directory,
  }), code('INVALID_PRIVATE_FILE'));
});

test('malformed JSON, directories and oversized files fail before any DB operation', async t => {
  const f = await fixture(t);
  const original = await readFile(f.planFile);
  for (const bytes of [Buffer.from('x'), Buffer.from('{malformed json'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20)]) {
    await writeFile(f.planFile, bytes);
    await assert.rejects(f.load(), code('CONTRIBUTION_INVALID_REVIEW_FILE'));
  }
  await writeFile(f.planFile, original);
  const directory = path.join(f.privateRoot, 'not-a-file');
  await mkdir(directory);
  await assert.rejects(loadContributionSettlementPlan(directory, f.reviewFile, f.options), code('CONTRIBUTION_INVALID_REVIEW_FILE'));
  await writeFile(f.artifactFile, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
  await assert.rejects(f.load(), code('CONTRIBUTION_INVALID_REVIEW_FILE'));
});
