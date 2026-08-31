import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, link, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { init } from '../public/game-runtime-engine.js';
import { fixtureBundle } from './fixtures/game-bundle.mjs';
import { runtimeInventory, runtimeInventoryDigest } from '../scripts/prepare-game-candidate.mjs';
import { chooseStrategyAction, evaluateGameBalance, parseQaArguments, resolveQaPath, collectRuntimeEvidence, runCandidateBrowser } from '../scripts/validate-game-candidate.mjs';

test('synthetic balance compares both policies for every fixed seed without mutating data', () => {
  const bundle = fixtureBundle(), before = JSON.stringify(bundle);
  const result = evaluateGameBalance(bundle);
  assert.equal(result.passed, true);
  assert.equal(result.seeds, 32);
  assert.equal(result.heroes[0].runs.length, 64);
  assert.equal(result.heroes[0].strategicWins, 32);
  assert.equal(result.heroes[0].idleLosses, 32);
  assert.deepEqual(result, evaluateGameBalance(bundle));
  assert.equal(JSON.stringify(bundle), before);
});

test('every hero needs a strategic win and a genuine idle loss independently', () => {
  const bundle = fixtureBundle();
  bundle.config.heroes.push({ ...structuredClone(bundle.config.heroes[0]), id: 'hero-b', stats: { health: 999, food: 3, gold: 3, morale: 3 } });
  bundle.copy.heroes.push({ ...structuredClone(bundle.copy.heroes[0]), id: 'hero-b' });
  bundle.art.heroIcons.push({ id: 'hero-b', icon: 'leaf' });
  const result = evaluateGameBalance(bundle);
  assert.equal(result.passed, false);
  assert.deepEqual(result.failures, [{ heroId: 'hero-b', code: 'NO_IDLE_LOSS' }]);
  assert.ok(result.heroes[0].strategicWins > 0 && result.heroes[0].idleLosses > 0);
});

test('unwinnable candidates fail instead of interpreting attempted actions as success', () => {
  const bundle = fixtureBundle();
  bundle.config.cards[0].effect.defense = 0;
  const result = evaluateGameBalance(bundle);
  assert.equal(result.passed, false);
  assert.equal(result.heroes[0].strategicWins, 0);
  assert.ok(result.failures.some(failure => failure.code === 'NO_STRATEGIC_WIN'));
});

test('the hard action budget fails unfinished runs and rejects unbounded options', () => {
  const result = evaluateGameBalance(fixtureBundle(), { seeds: 2, maxActions: 1 });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(failure => failure.code === 'ACTION_LIMIT'));
  for (const options of [{ seeds: 0 }, { seeds: 33 }, { maxActions: 81 }, { maxActions: 0 }, { seeds: 1.5 }]) {
    assert.throws(() => evaluateGameBalance(fixtureBundle(), options), /INVALID_QA_OPTIONS/);
  }
});

test('greedy defense chooses the largest residual incoming threat, avoiding zero-morale costs', () => {
  const { config } = fixtureBundle();
  const state = init(config, 1, 'hero-a');
  state.incoming = [{ enemyId: 'enemy-a', tileId: 1 }, { enemyId: 'enemy-a', tileId: 2 }, { enemyId: 'enemy-a', tileId: 2 }];
  state.tiles[1] = 3;
  assert.deepEqual(chooseStrategyAction(config, state), { type: 'play', cardId: 'guard', tileId: 2 });
  config.cards[0].cost.morale = state.stats.morale;
  assert.notEqual(chooseStrategyAction(config, state).cardId, 'guard');
});

test('unused resources and excess healing do not produce useless card spam', () => {
  const { config } = fixtureBundle();
  const state = init(config, 1, 'hero-a');
  state.hand = ['harvest']; state.stats.food = 999; state.stats.gold = 999;
  assert.deepEqual(chooseStrategyAction(config, state), { type: 'endTurn' });
});

test('bundle HTML or code fields are rejected before any simulation', () => {
  const html = fixtureBundle(); html.copy.story.en = '<script>never</script>';
  assert.throws(() => evaluateGameBalance(html), /GAME_BUNDLE_INVALID/);
  const code = fixtureBundle(); code.config.run = 'never';
  assert.throws(() => evaluateGameBalance(code), /GAME_CONFIG_INVALID/);
});

test('CLI options are exact, mandatory, and cannot be repeated', () => {
  assert.deepEqual(parseQaArguments(['--bundle=.local/input.json', '--evidence=.local/evidence.json', '--screenshots=.local/shots']),
    { bundle: '.local/input.json', evidence: '.local/evidence.json', screenshots: '.local/shots' });
  for (const args of [[], ['--approve=true'], ['--bundle=x'], ['--bundle=x', '--bundle=y', '--evidence=z', '--screenshots=q']]) {
    assert.throws(() => parseQaArguments(args), /INVALID_QA_ARGUMENTS/);
  }
});

async function sandbox(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'yourgame-qa-test-'));
  const privateRoot = path.join(base, '.local'); await mkdir(privateRoot);
  t.after(async () => {
    assert.ok(path.dirname(base) === os.tmpdir() && path.basename(base).startsWith('yourgame-qa-test-'));
    await rm(base, { recursive: true, force: true });
  });
  return { base, privateRoot };
}

test('QA paths stay under the private root and permit missing output parents without changing files', async t => {
  const { base, privateRoot } = await sandbox(t);
  const input = path.join(privateRoot, 'fixture.json'); await writeFile(input, '{}');
  assert.equal(await resolveQaPath(input, { privateRoot }), input);
  const output = path.join(privateRoot, 'new', 'evidence.json');
  assert.equal(await resolveQaPath(output, { privateRoot, mustExist: false }), output);
  for (const target of [base, privateRoot, path.join(base, 'public.json'), path.join(privateRoot, 'bad:name'),
    path.join(privateRoot, 'CON.json'), path.join(privateRoot, 'tail.'), privateRoot + '/nested/../fixture.json']) {
    await assert.rejects(resolveQaPath(target, { privateRoot, mustExist: false }), /INVALID_QA_PATH/);
  }
});

test('directory junctions and hardlinked inputs are refused even when they point within the private tree', async t => {
  const { privateRoot } = await sandbox(t);
  const actual = path.join(privateRoot, 'actual'); await mkdir(actual);
  const input = path.join(actual, 'fixture.json'); await writeFile(input, '{}');
  const alias = path.join(privateRoot, 'alias'); await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveQaPath(path.join(alias, 'fixture.json'), { privateRoot }), /INVALID_QA_PATH/);
  const hardlink = path.join(privateRoot, 'hardlink.json'); await link(input, hardlink);
  await assert.rejects(resolveQaPath(hardlink, { privateRoot }), /INVALID_QA_PATH/);
});

test('runtime evidence binds trusted engine, frame, host, browser storage, app and CSP files without approval', async () => {
  const evidence = await collectRuntimeEvidence();
  assert.match(evidence.runtimeDigest, /^[a-f0-9]{64}$/);
  for (const name of ['public/game-runtime-engine.js', 'public/game-runtime-frame.js', 'public/game-frame.html',
    'public/game-host.js', 'public/game-save-store.js', 'public/app.js', 'public/styles.css', 'public/index.html', 'vercel.json']) {
    const file = evidence.runtimeFiles.find(file => file.path === name);
    assert.ok(file?.bytes > 0, name); assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(evidence.approved, undefined);
  assert.deepEqual(evidence.runtimeFiles, await runtimeInventory());
  assert.equal(evidence.runtimeDigest, runtimeInventoryDigest(evidence.runtimeFiles));
  assert.deepEqual(evidence, await collectRuntimeEvidence());
});

// Opt-in smoke test uses an already-running local static/dev server on port3000.
// Every API and external origin is intercepted; only synthetic content is supplied.
test('synthetic browser QA exercises the real frame, storage, screenshots and served byte bindings',
  { skip: process.env.RUN_GAME_CANDIDATE_BROWSER !== '1', timeout: 60000 }, async t => {
    const { privateRoot } = await sandbox(t);
    const result = await runCandidateBrowser(JSON.stringify(fixtureBundle()), { privateRoot, screenshots: path.join(privateRoot, 'screenshots') });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.deepEqual(result.results.map(row => row.width), [390, 1440]);
    for (const row of result.results) {
      assert.ok(row.checks.includes('served_runtime_bytes'));
      assert.match(row.screenshotSha256, /^[a-f0-9]{64}$/);
      assert.equal(path.basename(row.gameScreenshot), `runtime-game-${row.width}.png`);
      const gameCapture = await readFile(path.join(privateRoot, row.gameScreenshot));
      assert.deepEqual([...gameCapture.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(row.gameScreenshotSha256, createHash('sha256').update(gameCapture).digest('hex'));
      assert.ok(gameCapture.length > 1000);
      assert.ok(row.seed >= 1 && row.seed <= 32);
    }
  });
