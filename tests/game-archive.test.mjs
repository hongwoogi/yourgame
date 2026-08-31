import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, unlink, link } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { archiveGameVersion, checkGameArchive, checkArchiveRetention } from '../scripts/game-archive.mjs';
import { GAME_RUNTIME_FILES } from '../scripts/game-runtime-files.mjs';
import { fixtureBundle } from './fixtures/game-bundle.mjs';

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yourgame-archive-test-'));
  const archiveRoot = path.join(base, 'game-archive'), publicGamesRoot = path.join(base, 'public/games');
  await mkdir(publicGamesRoot, { recursive: true });
  t.after(async () => {
    assert.equal(path.dirname(base), os.tmpdir());
    assert.ok(path.basename(base).startsWith('yourgame-archive-test-'));
    await rm(base, { recursive: true, force: true });
  });
  const make = (version = 'v-test-1', suffix = '') => {
    const bundle = fixtureBundle(); bundle.config.gameVersion = version;
    return { archiveRoot, content: Buffer.from(JSON.stringify(bundle)),
      runtimeFiles: GAME_RUNTIME_FILES.map(file => ({ path: file, content: Buffer.from('source:' + file + suffix) })) };
  };
  const publishFixture = async input => {
    const result = await archiveGameVersion(input);
    await mkdir(path.join(publicGamesRoot, result.version), { recursive: true });
    await writeFile(path.join(publicGamesRoot, result.version, 'game.json'), input.content);
    return result;
  };
  const git = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args],
    { cwd: base, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = () => { git('add', '.'); git('-c', 'user.name=Archive Test', '-c', 'user.email=archive@example.test', 'commit', '-m', 'Synthetic archive fixture'); };
  return { base, archiveRoot, publicGamesRoot, make, publishFixture, git, commit };
}

test('successive versions retain their independent original runtime and public bundle', async t => {
  const s = await setup(t), first = s.make(), second = s.make('v-test-2', ':new-runtime');
  const a = await s.publishFixture(first);
  const original = await readFile(path.join(s.archiveRoot, a.version, 'manifest.json'));
  const b = await s.publishFixture(second);
  assert.deepEqual(await readFile(path.join(s.archiveRoot, a.version, 'manifest.json')), original);
  assert.equal(await readFile(path.join(s.archiveRoot, a.version, 'runtime/public/game-runtime-engine.js'), 'utf8'),
    'source:public/game-runtime-engine.js');
  const result = await checkGameArchive({ ...s, registeredGames: [a, b] });
  assert.deepEqual(result.versions, ['v-test-1', 'v-test-2']);
  assert.equal(a.archivedFiles, 13);
});

test('identical retry is idempotent, but same-version data or runtime replacement is rejected', async t => {
  const s = await setup(t), input = s.make();
  assert.deepEqual(await archiveGameVersion(input), await archiveGameVersion(input));
  await assert.rejects(archiveGameVersion(s.make('v-test-1', ':changed')), /ARCHIVE_VERSION_CONFLICT/);
  const changed = JSON.parse(input.content); changed.copy.story.en = 'Different story';
  await assert.rejects(archiveGameVersion({ ...input, content: JSON.stringify(changed) }), /ARCHIVE_VERSION_CONFLICT/);
  assert.deepEqual(await readFile(path.join(s.archiveRoot, 'v-test-1/game.json')), input.content);
});

test('incomplete, duplicate, or foreign runtime entries cannot create an archive', async t => {
  const s = await setup(t), input = s.make();
  for (const files of [input.runtimeFiles.slice(1), [...input.runtimeFiles.slice(1), input.runtimeFiles[1]],
    input.runtimeFiles.map((file, index) => index ? file : { ...file, path: '../secret' })]) {
    await assert.rejects(archiveGameVersion({ ...input, runtimeFiles: files }), /ARCHIVE_RUNTIME_INCOMPLETE/);
  }
  await assert.rejects(readdir(s.archiveRoot), { code: 'ENOENT' });
});

test('concurrent imports cannot mix different runtimes under the same game version', async t => {
  const s = await setup(t);
  const outcomes = await Promise.allSettled([archiveGameVersion(s.make('v-race', ':a')),
    archiveGameVersion(s.make('v-race', ':b'))]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(result => result.status === 'rejected').reason.message, /ARCHIVE_VERSION_CONFLICT/);
  assert.equal((await checkGameArchive(s)).archivedVersions, 1);
  const suffixes = new Set(await Promise.all(GAME_RUNTIME_FILES.map(async file =>
    (await readFile(path.join(s.archiveRoot, 'v-race/runtime', file), 'utf8')).slice(-2))));
  assert.equal(suffixes.size, 1);
});

test('interrupted snapshot is invalid until an identical retry finishes it', async t => {
  const s = await setup(t), input = s.make();
  await s.publishFixture(input);
  await unlink(path.join(s.archiveRoot, 'v-test-1/manifest.json'));
  await assert.rejects(checkGameArchive(s), { code: 'ENOENT' });
  await archiveGameVersion(input);
  assert.equal((await checkGameArchive(s)).archivedVersions, 1);
});

test('modified archived bytes, extra files, and missing runtime files fail integrity checks', async t => {
  const s = await setup(t), input = s.make(); await s.publishFixture(input);
  const target = path.join(s.archiveRoot, 'v-test-1/runtime/public/game-runtime-engine.js');
  const original = await readFile(target);
  await writeFile(target, 'changed');
  await assert.rejects(checkGameArchive(s), /ARCHIVE_BYTES_CHANGED/);
  await writeFile(target, original);
  const extra = path.join(s.archiveRoot, 'v-test-1/private.txt');
  await writeFile(extra, 'synthetic unexpected file');
  await assert.rejects(checkGameArchive(s), /ARCHIVE_FILE_SET_CHANGED/);
  await unlink(extra); await unlink(target);
  await assert.rejects(checkGameArchive(s), /ARCHIVE_FILE_SET_CHANGED/);
});

test('unarchived public games, mismatched public bytes, and stale registry hashes block the build', async t => {
  const s = await setup(t), input = s.make(); const result = await s.publishFixture(input);
  await assert.rejects(checkGameArchive({ ...s, registeredGames: [{ ...result, sha256: '0'.repeat(64) }] }), /ARCHIVE_REGISTRY_MISMATCH/);
  const publicFile = path.join(s.publicGamesRoot, 'v-test-1/game.json');
  await writeFile(publicFile, 'different');
  await assert.rejects(checkGameArchive(s), /ARCHIVE_PUBLIC_BYTES_CHANGED/);
  await writeFile(publicFile, input.content);
  await mkdir(path.join(s.publicGamesRoot, 'v-missing'));
  await writeFile(path.join(s.publicGamesRoot, 'v-missing/game.json'), input.content);
  await assert.rejects(checkGameArchive(s), /GAME_ARCHIVE_MISSING/);
});

test('hard-linked artifacts are rejected without modifying the linked target', async t => {
  const s = await setup(t), input = s.make(); await s.publishFixture(input);
  const target = path.join(s.archiveRoot, 'v-test-1/game.json');
  await link(target, path.join(s.base, 'linked-game.json'));
  await assert.rejects(archiveGameVersion(input), /ARCHIVE_UNSAFE_FILE/);
  assert.deepEqual(await readFile(target), input.content);
});

test('Git retention catches coordinated source-and-manifest rewrites before and after committing', async t => {
  const s = await setup(t); s.git('init'); await s.publishFixture(s.make()); s.commit();
  assert.equal((await checkArchiveRetention({ repositoryRoot: s.base })).protectedFiles, 15);
  const file = path.join(s.archiveRoot, 'v-test-1/runtime/public/game-runtime-engine.js');
  const bytes = Buffer.from('rewritten historical runtime'); await writeFile(file, bytes);
  const manifestPath = path.join(s.archiveRoot, 'v-test-1/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  const row = manifest.files.find(row => row.path === 'runtime/public/game-runtime-engine.js');
  row.bytes = bytes.length; row.sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await checkGameArchive(s)).archivedVersions, 1);
  await assert.rejects(checkArchiveRetention({ repositoryRoot: s.base }), /ARCHIVE_HISTORY_REWRITTEN/);
  s.commit();
  await assert.rejects(checkArchiveRetention({ repositoryRoot: s.base }), /ARCHIVE_HISTORY_REWRITTEN/);
});

test('Git retention catches removal of an entire historical version even when removed from the index', async t => {
  const s = await setup(t); s.git('init'); await s.publishFixture(s.make()); s.commit();
  const target = path.resolve(s.archiveRoot, 'v-test-1');
  assert.ok(target.startsWith(path.resolve(s.base) + path.sep));
  assert.equal(path.dirname(target), s.archiveRoot);
  await rm(target, { recursive: true });
  await assert.rejects(checkArchiveRetention({ repositoryRoot: s.base }), /ARCHIVE_HISTORY_REMOVED/);
  s.commit();
  await assert.rejects(checkArchiveRetention({ repositoryRoot: s.base }), /ARCHIVE_HISTORY_REMOVED/);
});

test('history absence is explicit for fresh source archives, without disabling byte validation', async t => {
  const s = await setup(t); await s.publishFixture(s.make());
  assert.deepEqual(await checkArchiveRetention({ repositoryRoot: s.base }), { historyAvailable: false, protectedFiles: 0 });
  assert.equal((await checkGameArchive(s)).archivedVersions, 1);
});
