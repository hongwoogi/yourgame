import { createHash } from 'node:crypto';
import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SAFETY_POLICY_VERSION } from '../server/safety-policy.mjs';
import { readSnapshot, validateSnapshot } from './export-initial-round.mjs';
import { PRIVATE_ROOT, resolvePrivateFile } from './private-records.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ID = /^[A-Za-z0-9_-]{8,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILES = 1024;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_DEPTH = 16;
const candidateError = code => Object.assign(new Error(code), { workerCode: code });
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const within = (base, target) => {
  const relative = path.relative(base, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export function digestArtifactFiles(files, kind) {
  const entries = files.filter(file => file.kind === kind)
    .map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function validArtifactPath(file) {
  if (typeof file.path !== 'string' || !file.path.isWellFormed() || file.path.length > 240
    || /[\\:\x00-\x1f\x7f]/.test(file.path)) return false;
  const segments = file.path.split('/');
  if (segments.length < 2 || segments[0] !== (file.kind === 'source' ? 'source' : 'assets')) return false;
  return segments.every(segment => segment && segment !== '.' && segment !== '..'
    && !segment.startsWith('.') && !/[. ]$/.test(segment)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment));
}

export function validateCandidate(candidate, { snapshot, runId } = {}) {
  validateSnapshot(snapshot);
  const keys = ['schemaVersion', 'kind', 'candidateId', 'runId', 'policyVersion', 'snapshotDigest', 'sourceDigest', 'assetsDigest', 'files'];
  if (!exactKeys(candidate, keys) || candidate.schemaVersion !== 1 || candidate.kind !== 'generated-game-candidate'
    || typeof candidate.candidateId !== 'string' || !ID.test(candidate.candidateId)
    || typeof candidate.runId !== 'string' || !ID.test(candidate.runId)
    || candidate.runId !== runId || candidate.policyVersion !== SAFETY_POLICY_VERSION
    || candidate.snapshotDigest !== snapshot.snapshotDigest
    || !HASH.test(candidate.sourceDigest || '') || !HASH.test(candidate.assetsDigest || '')
    || !Array.isArray(candidate.files) || !candidate.files.length || candidate.files.length > MAX_FILES) {
    throw candidateError('INVALID_GAME_CANDIDATE');
  }
  let total = 0;
  const paths = new Set();
  for (const file of candidate.files) {
    if (!exactKeys(file, ['kind', 'path', 'bytes', 'sha256']) || !['source', 'asset'].includes(file.kind)
      || !validArtifactPath(file) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || file.bytes > MAX_BYTES || !HASH.test(file.sha256 || '')) throw candidateError('INVALID_GAME_CANDIDATE');
    // Windows file names are case insensitive; aliases cannot count as two assets.
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw candidateError('INVALID_GAME_CANDIDATE');
    paths.add(key);
    total += file.bytes;
  }
  if (total > MAX_BYTES || !candidate.files.some(file => file.kind === 'source')
    || digestArtifactFiles(candidate.files, 'source') !== candidate.sourceDigest
    || digestArtifactFiles(candidate.files, 'asset') !== candidate.assetsDigest) throw candidateError('INVALID_GAME_CANDIDATE');
  return candidate;
}

export async function inspectCandidate(file, { snapshot, runId, privateRoot = PRIVATE_ROOT } = {}) {
  const resolved = await resolvePrivateFile(file, { privateRoot });
  const info = await lstat(resolved);
  if (!info.isFile() || info.size > 1024 * 1024) throw candidateError('INVALID_GAME_CANDIDATE');
  let candidate;
  try { candidate = JSON.parse(await readFile(resolved, 'utf8')); }
  catch { throw candidateError('INVALID_GAME_CANDIDATE'); }
  validateCandidate(candidate, { snapshot, runId });
  const candidateRoot = path.dirname(resolved);
  const expected = path.resolve(privateRoot, 'game-candidates', candidate.candidateId, 'candidate.json');
  if (path.relative(expected, resolved) !== '') throw candidateError('INVALID_CANDIDATE_PATH');
  const actualFiles = [];
  let entriesVisited = 0;
  async function scan(directory, depth = 0) {
    if (depth > MAX_DEPTH) throw candidateError('INVALID_GAME_CANDIDATE');
    for await (const entry of await opendir(directory)) {
      entriesVisited += 1;
      if (entriesVisited > MAX_ENTRIES) throw candidateError('INVALID_GAME_CANDIDATE');
      const target = path.join(directory, entry.name);
      const relative = path.relative(candidateRoot, target).split(path.sep).join('/');
      if (entry.isSymbolicLink() || !within(candidateRoot, target)
        || path.relative(target, await realpath(target)) !== '') throw candidateError('INVALID_CANDIDATE_PATH');
      if (entry.isDirectory()) {
        if (!['source', 'assets'].includes(relative.split('/')[0])) throw candidateError('INVALID_CANDIDATE_PATH');
        await scan(target, depth + 1);
      } else if (entry.isFile()) {
        if (relative !== 'candidate.json') actualFiles.push(relative);
      } else throw candidateError('INVALID_CANDIDATE_PATH');
      if (actualFiles.length > MAX_FILES) throw candidateError('INVALID_GAME_CANDIDATE');
    }
  }
  await scan(candidateRoot);
  const declared = new Set(candidate.files.map(entry => entry.path));
  if (actualFiles.length !== declared.size || actualFiles.some(name => !declared.has(name))) {
    throw candidateError('UNDECLARED_CANDIDATE_FILE');
  }
  for (const entry of candidate.files) {
    const target = path.resolve(candidateRoot, ...entry.path.split('/'));
    if (!within(candidateRoot, target)) throw candidateError('INVALID_CANDIDATE_PATH');
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1
      || metadata.size !== entry.bytes || path.relative(target, await realpath(target)) !== '') {
      throw candidateError('CANDIDATE_BYTES_CHANGED');
    }
    const bytes = await readFile(target);
    if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw candidateError('CANDIDATE_BYTES_CHANGED');
    }
  }
  return { candidateId: candidate.candidateId, runId: candidate.runId, policyVersion: candidate.policyVersion,
    snapshotDigest: candidate.snapshotDigest, sourceDigest: candidate.sourceDigest, assetsDigest: candidate.assetsDigest,
    fileCount: candidate.files.length, artifactBytesChecked: true };
}

export async function checkGameRelease({ snapshot, runId, candidateFile, privateRoot = PRIVATE_ROOT } = {}) {
  validateSnapshot(snapshot);
  if (!ID.test(runId || '')) throw candidateError('INVALID_ARGUMENTS');
  const candidate = candidateFile ? await inspectCandidate(candidateFile, { snapshot, runId, privateRoot }) : null;
  // Deliberately no caller-supplied "approved" flag, unsigned review JSON,
  // self-signature, or CLI override. Those are not independent safety evidence.
  // A future trusted issuer must bind policy + snapshot + source/assets bytes to
  // content review, execution verification and an enforced isolation boundary.
  // That issuer and the game runner do not exist yet. This is a prerequisite,
  // not a permanent prohibition on game publication or a block on trusted app fixes.
  return { ok: true, scope: 'generated_game_release', allowed: false, releaseAllowed: false,
    error: 'RELEASE_REVIEW_UNAVAILABLE', blockedReason: 'release_review_unavailable',
    candidate, policyVersion: SAFETY_POLICY_VERSION, snapshotDigest: snapshot.snapshotDigest,
    prerequisites: { trustedReviewIssuer: false, isolatedGameRunner: false, artifactExecutionReview: false },
    trustedApplicationDeploymentAffected: false, gamePublishedByThisCommand: false };
}

export function parseReleaseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--snapshot', '--run-id', '--candidate'].includes(name) || !args[index + 1]
      || args[index + 1].startsWith('--') || Object.hasOwn(options, name.slice(2))) throw candidateError('INVALID_ARGUMENTS');
    options[name.slice(2)] = args[index + 1];
  }
  if (!options.snapshot || !ID.test(options['run-id'] || '')) throw candidateError('INVALID_ARGUMENTS');
  return options;
}

async function main() {
  try {
    const options = parseReleaseArguments(process.argv.slice(2));
    if (options.help) {
      console.log('Usage: node scripts/check-game-release.mjs --snapshot .local/.../snapshot.json --run-id ID [--candidate .local/game-candidates/ID/candidate.json]\nRead-only artifact binding check. It does not execute source code or authorize publication. Until independent review/runner prerequisites are implemented, exit 2 with RELEASE_REVIEW_UNAVAILABLE. Trusted application deployments are outside this game gate.');
      return;
    }
    const snapshot = await readSnapshot(await resolvePrivateFile(path.resolve(root, options.snapshot)));
    const report = await checkGameRelease({ snapshot, runId: options['run-id'],
      candidateFile: options.candidate ? path.resolve(root, options.candidate) : undefined });
    console.log(JSON.stringify(report));
    process.exitCode = 2;
  } catch (error) {
    const allowed = ['INVALID_ARGUMENTS', 'INVALID_PRIVATE_FILE', 'INVALID_SNAPSHOT', 'UNREVIEWED_SNAPSHOT',
      'SNAPSHOT_POLICY_CHANGED', 'INVALID_GAME_CANDIDATE', 'INVALID_CANDIDATE_PATH', 'UNDECLARED_CANDIDATE_FILE', 'CANDIDATE_BYTES_CHANGED'];
    const code = allowed.includes(error.workerCode) ? error.workerCode : 'RELEASE_REVIEW_UNAVAILABLE';
    console.error(JSON.stringify({ ok: false, scope: 'generated_game_release', allowed: false,
      releaseAllowed: false, error: code, trustedApplicationDeploymentAffected: false }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
