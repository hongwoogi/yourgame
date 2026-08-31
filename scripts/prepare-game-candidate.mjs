import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preparePrivateFile, resolvePrivateFile } from './private-records.mjs';
import { readSnapshot } from './export-initial-round.mjs';
import { digestArtifactFiles, inspectCandidate } from './check-game-release.mjs';
import { validateGameBundle } from '../public/game-bundle.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export const GAME_RUNTIME_FILES = Object.freeze([
  'public/game-runtime-engine.js', 'public/game-runtime-frame.js', 'public/game-bundle.js',
  'public/game-runtime.css', 'public/game-frame.html', 'public/game-host.js',
  'public/game-save-store.js', 'public/game-save-bridge.js', 'public/app.js',
  'public/styles.css', 'public/index.html', 'vercel.json',
]);
export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export async function runtimeInventory() {
  const files = [];
  for (const name of GAME_RUNTIME_FILES) {
    const bytes = await readFile(path.join(root, name));
    files.push({ path: name, bytes: bytes.length, sha256: hashBytes(bytes) });
  }
  return files;
}
export const runtimeInventoryDigest = files => hashBytes(JSON.stringify([...files].sort((a, b) => a.path.localeCompare(b.path))));

export async function prepareCandidate({ bundleFile, snapshotFile, runId, candidateId }) {
  if (![runId, candidateId].every(value => /^[A-Za-z0-9_-]{8,128}$/.test(value))) throw new Error('INVALID_CANDIDATE');
  const input = await resolvePrivateFile(path.resolve(root, bundleFile));
  const info = await lstat(input);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 98304) throw new Error('INVALID_BUNDLE_FILE');
  const content = await readFile(input);
  const bundle = validateGameBundle(JSON.parse(content.toString('utf8')));
  const snapshot = await readSnapshot(await resolvePrivateFile(path.resolve(root, snapshotFile)));
  const directory = path.join(root, '.local/game-candidates', candidateId);
  const candidateFile = await preparePrivateFile(path.join(directory, 'candidate.json'));
  const files = [];
  const copy = async (relative, bytes) => {
    const target = await preparePrivateFile(path.join(directory, relative));
    await writeFile(target, bytes, { flag: 'wx' });
    files.push({ kind: 'source', path: relative, bytes: bytes.length, sha256: hashBytes(bytes) });
  };
  await copy('source/game.json', content);
  const runtimeFiles = await runtimeInventory();
  for (const file of runtimeFiles) await copy('source/runtime/' + file.path, await readFile(path.join(root, file.path)));
  const candidate = { schemaVersion: 1, kind: 'generated-game-candidate', candidateId, runId,
    policyVersion: snapshot.policyVersion, snapshotDigest: snapshot.snapshotDigest,
    sourceDigest: digestArtifactFiles(files, 'source'), assetsDigest: digestArtifactFiles(files, 'asset'), files };
  await writeFile(candidateFile, JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  await inspectCandidate(candidateFile, { snapshot, runId });
  return { candidateFile, gameVersion: bundle.config.gameVersion, contentSha256: hashBytes(content),
    runtimeDigest: runtimeInventoryDigest(runtimeFiles), candidate };
}

// Caller is the trusted operator after authenticating the immutable DB receipt.
export async function copyReviewedGame({ candidateFile, snapshot, runId, release }) {
  const checked = await inspectCandidate(candidateFile, { snapshot, runId });
  if (release?.releaseAllowed !== true || release.reviewId === undefined
      || release.releaseBinding?.sourceDigest !== checked.sourceDigest || release.releaseBinding?.snapshotDigest !== snapshot.snapshotDigest) throw new Error('RELEASE_REQUIRED');
  const content = await readFile(path.join(path.dirname(candidateFile), 'source/game.json'));
  const bundle = validateGameBundle(JSON.parse(content));
  if (hashBytes(content) !== release.releaseBinding.contentSha256 || bundle.config.gameVersion !== release.releaseBinding.gameVersion
      || runtimeInventoryDigest(await runtimeInventory()) !== release.releaseBinding.runtimeDigest) throw new Error('REVIEW_BYTES_CHANGED');
  const target = path.join(root, 'public/games', bundle.config.gameVersion, 'game.json');
  await mkdir(path.dirname(target), { recursive: true });
  try { await writeFile(target, content, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || hashBytes(await readFile(target)) !== hashBytes(content)) throw error; }
  return { version: bundle.config.gameVersion, sha256: hashBytes(content), reviewId: release.reviewId };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.split('=')));
    const result = await prepareCandidate({ bundleFile: args['--bundle'], snapshotFile: args['--snapshot'],
      runId: args['--run-id'], candidateId: args['--candidate-id'] });
    console.log(JSON.stringify({ ok: true, packagedFiles: result.candidate.files.length, releaseAllowed: false }));
  } catch { console.log('{"ok":false,"error":"CANDIDATE_IMPORT_FAILED","releaseAllowed":false}'); process.exitCode = 1; }
}
