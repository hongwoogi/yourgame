import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateGameBundle } from '../public/game-bundle.js';
import { GAME_RUNTIME_FILES } from './game-runtime-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const validVersion = version => typeof version === 'string' && /^v[A-Za-z0-9_-]{1,63}$/.test(version);
const expectedSourcePaths = ['game.json', ...GAME_RUNTIME_FILES.map(file => 'runtime/' + file)].sort();
const record = (name, bytes) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) });

async function directory(target) {
  await mkdir(target, { recursive: true });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('ARCHIVE_UNSAFE_PATH');
}
async function readRegular(target) {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) fail('ARCHIVE_UNSAFE_FILE');
  return readFile(target);
}
async function writeImmutable(target, bytes) {
  try { await writeFile(target, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await readRegular(target)).equals(bytes)) fail('ARCHIVE_VERSION_CONFLICT');
  }
}

// This records source bytes only. It never approves, deploys, or selects a game.
// Production callers must already have passed the trusted release gate.
export async function archiveGameVersion({ content, runtimeFiles, assets = [], archiveRoot = path.join(root, 'game-archive') }) {
  content = Buffer.from(content);
  const bundle = validateGameBundle(JSON.parse(content));
  const version = bundle.config.gameVersion;
  if (!validVersion(version)) fail('ARCHIVE_INVALID_VERSION');
  if (!Array.isArray(runtimeFiles) || runtimeFiles.length !== GAME_RUNTIME_FILES.length
      || new Set(runtimeFiles.map(file => file.path)).size !== GAME_RUNTIME_FILES.length
      || runtimeFiles.some(file => !GAME_RUNTIME_FILES.includes(file.path))) fail('ARCHIVE_RUNTIME_INCOMPLETE');
  const expectedAssets = (bundle.assets || []).map(asset => asset.path).sort();
  if (!Array.isArray(assets) || assets.length !== expectedAssets.length
      || new Set(assets.map(file => file.path)).size !== expectedAssets.length
      || assets.map(file => file.path).sort().join('\n') !== expectedAssets.join('\n')) fail('ARCHIVE_ASSETS_INCOMPLETE');
  const files = [{ path: 'game.json', content }, ...runtimeFiles.map(file => ({
    path: 'runtime/' + file.path, content: Buffer.from(file.content),
  })), ...assets.map(file => ({ path: file.path, content: Buffer.from(file.content) }))].sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (files.some(file => !file.content.length || file.content.length > 4 * 1024 * 1024)) fail('ARCHIVE_INVALID_FILE');
  const manifest = { schemaVersion: assets.length ? 2 : 1, kind: 'game-source-snapshot', version,
    files: files.map(file => record(file.path, file.content)) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await directory(archiveRoot);
  const versionRoot = path.join(archiveRoot, version);
  await directory(versionRoot);
  // Validate parent directories before opening any files; never follow a link.
  for (const relative of ['runtime', 'runtime/public', ...assets.map(file => path.posix.dirname(file.path))]) {
    if (relative !== '.') await directory(path.join(versionRoot, relative));
  }
  // Detect conflicting retries before writing any remaining files.
  for (const file of [...files, { path: 'manifest.json', content: manifestBytes }]) {
    try {
      if (!(await readRegular(path.join(versionRoot, file.path))).equals(file.content)) fail('ARCHIVE_VERSION_CONFLICT');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Claim the entire snapshot first so concurrent same-bundle/different-runtime
  // imports cannot mix files. Missing listed files still fail the build, and an
  // identical interrupted import can resume without rewriting anything.
  await writeImmutable(path.join(versionRoot, 'manifest.json'), manifestBytes);
  await writeImmutable(path.join(versionRoot, 'game.json'), content);
  for (const file of files.filter(file => file.path !== 'game.json')) await writeImmutable(path.join(versionRoot, file.path), file.content);
  return { version, archivedFiles: files.length, sha256: hash(content) };
}

async function inventory(directoryPath, relative = '') {
  if (relative.split('/').length > 4) fail('ARCHIVE_FILE_SET_CHANGED');
  const result = [];
  const entries = await readdir(directoryPath, { withFileTypes: true });
  if (entries.length > 1025) fail('ARCHIVE_FILE_SET_CHANGED');
  for (const entry of entries) {
    const name = relative + entry.name;
    if (entry.isSymbolicLink()) fail('ARCHIVE_UNSAFE_PATH');
    if (entry.isDirectory()) result.push(...await inventory(path.join(directoryPath, entry.name), name + '/'));
    else if (entry.isFile()) result.push(name);
    else fail('ARCHIVE_UNSAFE_FILE');
  }
  return result.sort();
}

export async function checkGameArchive({ archiveRoot = path.join(root, 'game-archive'),
  publicGamesRoot = path.join(root, 'public/games'), registeredGames = [] } = {}) {
  const versions = new Map();
  const entries = await readdir(archiveRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'README.md' && entry.isFile()) continue;
    if (!entry.isDirectory() || !validVersion(entry.name)) fail('ARCHIVE_INVALID_ENTRY');
    const versionRoot = path.join(archiveRoot, entry.name);
    const manifest = JSON.parse(await readRegular(path.join(versionRoot, 'manifest.json')));
    if (![1, 2].includes(manifest.schemaVersion) || manifest.kind !== 'game-source-snapshot' || manifest.version !== entry.name
        || Object.keys(manifest).sort().join(',') !== 'files,kind,schemaVersion,version'
        || !Array.isArray(manifest.files)) fail('ARCHIVE_INVALID_MANIFEST');
    const content = await readRegular(path.join(versionRoot, 'game.json'));
    const parsed = JSON.parse(content);
    const expectedPaths = manifest.schemaVersion === 1 ? expectedSourcePaths
      : [...expectedSourcePaths, ...(validateGameBundle(parsed).assets || []).map(asset => asset.path)].sort();
    if (manifest.files.length !== expectedPaths.length
      || manifest.files.map(file => file.path).sort().join('\n') !== expectedPaths.join('\n')) fail('ARCHIVE_INVALID_MANIFEST');
    const actualPaths = await inventory(versionRoot);
    if (actualPaths.join('\n') !== [...expectedPaths, 'manifest.json'].sort().join('\n')) fail('ARCHIVE_FILE_SET_CHANGED');
    for (const file of manifest.files) {
      if (Object.keys(file).sort().join(',') !== 'bytes,path,sha256') fail('ARCHIVE_INVALID_MANIFEST');
      const bytes = await readRegular(path.join(versionRoot, file.path));
      if (file.bytes !== bytes.length || file.sha256 !== hash(bytes)) fail('ARCHIVE_BYTES_CHANGED');
    }
    // Historical snapshots retain their own validator/runtime. Do not reinterpret
    // an old bundle with a future game's schema during archive verification.
    if (JSON.parse(content).config?.gameVersion !== entry.name) fail('ARCHIVE_VERSION_MISMATCH');
    versions.set(entry.name, hash(content));
  }
  for (const entry of await readdir(publicGamesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validVersion(entry.name)) fail('ARCHIVE_INVALID_PUBLIC_VERSION');
    const bytes = await readRegular(path.join(publicGamesRoot, entry.name, 'game.json'));
    if (!versions.has(entry.name)) fail('GAME_ARCHIVE_MISSING');
    if (versions.get(entry.name) !== hash(bytes)) fail('ARCHIVE_PUBLIC_BYTES_CHANGED');
    const manifest = JSON.parse(await readRegular(path.join(archiveRoot, entry.name, 'manifest.json')));
    for (const file of manifest.files.filter(file => file.path.startsWith('assets/'))) {
      const publicBytes = await readRegular(path.join(publicGamesRoot, entry.name, file.path));
      if (file.bytes !== publicBytes.length || file.sha256 !== hash(publicBytes)) fail('ARCHIVE_PUBLIC_BYTES_CHANGED');
    }
  }
  for (const game of registeredGames) {
    if (versions.get(game.version) !== game.sha256) fail('ARCHIVE_REGISTRY_MISMATCH');
    const bytes = await readRegular(path.join(publicGamesRoot, game.version, 'game.json'));
    if (hash(bytes) !== game.sha256) fail('ARCHIVE_PUBLIC_BYTES_CHANGED');
  }
  return { versions: [...versions.keys()].sort(), archivedVersions: versions.size };
}

// In a checkout, protect snapshots from both the current commit and its parent.
// A fresh git archive has no history: its manifests still receive all byte checks.
export async function checkArchiveRetention({ repositoryRoot = root,
  allowUnavailableHistory = process.env.VERCEL === '1' && ['production', 'preview'].includes(process.env.VERCEL_ENV) } = {}) {
  try { await lstat(path.join(repositoryRoot, '.git')); }
  catch (error) { if (error.code === 'ENOENT') return { historyAvailable: false, protectedFiles: 0 }; throw error; }
  const git = args => execFileSync('git', args, { cwd: repositoryRoot, windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'] });
  const protectedFiles = new Map();
  for (const ref of ['HEAD', 'HEAD^']) {
    try { git(['rev-parse', '--verify', ref]); }
    catch {
      if (ref === 'HEAD^') continue;
      // Vercel can provide a .git marker without a usable Git executable/HEAD.
      // Only that source-only build environment may omit history comparison;
      // checkGameArchive still validates every archived and public artifact.
      if (allowUnavailableHistory) return { historyAvailable: false, protectedFiles: 0, reason: 'source_only_deployment' };
      fail('ARCHIVE_HISTORY_UNAVAILABLE');
    }
    const tree = git(['ls-tree', '-r', '-z', ref, '--', 'game-archive', 'public/games']).toString('utf8');
    for (const line of tree.split('\0').filter(Boolean)) {
      const [metadata, name] = line.split('\t');
      if (name === 'game-archive/README.md') continue;
      const [mode, type, oid] = metadata.split(' ');
      if (mode !== '100644' || type !== 'blob' || !/^(?:game-archive|public\/games)\/v[A-Za-z0-9_-]{1,63}\//.test(name)) fail('ARCHIVE_HISTORY_INVALID');
      if (protectedFiles.has(name) && protectedFiles.get(name) !== oid) fail('ARCHIVE_HISTORY_REWRITTEN');
      protectedFiles.set(name, oid);
    }
  }
  for (const [name, oid] of protectedFiles) {
    let bytes;
    try { bytes = await readRegular(path.join(repositoryRoot, name)); }
    catch (error) { if (error.code === 'ENOENT') fail('ARCHIVE_HISTORY_REMOVED'); throw error; }
    if (!bytes.equals(git(['cat-file', 'blob', oid]))) fail('ARCHIVE_HISTORY_REWRITTEN');
  }
  return { historyAvailable: true, protectedFiles: protectedFiles.size };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { publishedGames } = await import('../server/published-games.mjs');
    console.log(JSON.stringify({ ok: true, ...await checkGameArchive({ registeredGames: publishedGames }), ...await checkArchiveRetention() }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: /^ARCHIVE_|^GAME_ARCHIVE_/.test(error.message) ? error.message : 'GAME_ARCHIVE_INVALID' }));
    process.exitCode = 1;
  }
}
