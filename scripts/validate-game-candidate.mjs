import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateGameBundle } from '../public/game-bundle.js';
import { init, act } from '../public/game-runtime-engine.js';
import { GAME_RUNTIME_FILES, runtimeInventory, runtimeInventoryDigest } from './prepare-game-candidate.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRIVATE = path.join(ROOT, '.local');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, code) => { if (!condition) throw new Error(code); };

export function chooseStrategyAction(config, state) {
  const cards = ids => ids.map(id => config.cards.find(card => card.id === id));
  if (state.phase === 'reward') {
    const deck = cards([...config.heroes.find(hero => hero.id === state.heroId).deck, ...state.acquired]);
    const defenseWeight = deck.filter(card => card.effect.defense).length < deck.length / 2 ? 2 : 1;
    const score = card => card.effect.defense * defenseWeight + card.effect.food * (state.stats.food < 3 ? 3 : 1)
      + card.effect.health + card.effect.gold + card.effect.morale - Object.values(card.cost).reduce((sum, n) => sum + n, 0);
    const ranked = cards(state.rewardChoices).sort((a, b) => score(b) - score(a));
    return { type: 'reward', cardId: ranked[0].id };
  }
  const incoming = state.tiles.map((defense, tile) => Math.max(0, state.incoming.filter(attack => attack.tileId === tile)
    .reduce((sum, attack) => sum + config.enemies.find(enemy => enemy.id === attack.enemyId).strength, 0) - defense));
  const tileId = incoming.indexOf(Math.max(...incoming));
  const maxHealth = config.heroes.find(hero => hero.id === state.heroId).stats.health;
  const foodNeed = config.waves.slice(state.wave).reduce((sum, wave) => sum + wave.foodCost, 0);
  let best = null, bestScore = 0;
  for (const card of cards(state.hand)) {
    if (Object.entries(card.cost).some(([key, n]) => state.stats[key] < n)
      || state.stats.morale - card.cost.morale + card.effect.morale <= 0) continue;
    const score = Math.min(card.effect.defense, incoming[tileId]) * 4 + Math.min(card.effect.health, maxHealth - state.stats.health) * 4
      + Math.min(card.effect.food, 999 - state.stats.food, Math.max(0, foodNeed - state.stats.food)) * 2
      + Math.min(card.effect.gold, Math.max(0, (config.waves.length - state.wave) * 3 - state.stats.gold))
      + Math.min(card.effect.morale, Math.max(0, 4 - state.stats.morale)) * 2
      - card.cost.food * 2 - card.cost.gold * 0.5 - card.cost.morale;
    if (score > bestScore) { best = card; bestScore = score; }
  }
  return best ? { type: 'play', cardId: best.id, ...(best.effect.defense ? { tileId } : {}) } : { type: 'endTurn' };
}

export function evaluateGameBalance(input, { seeds = 32, maxActions = 80 } = {}) {
  const { config } = validateGameBundle(input);
  check(Number.isInteger(seeds) && seeds >= 1 && seeds <= 32 && Number.isInteger(maxActions) && maxActions >= 1 && maxActions <= 80, 'INVALID_QA_OPTIONS');
  const heroes = config.heroes.map(hero => {
    const runs = [];
    for (let seed = 1; seed <= seeds; seed++) {
      for (const policy of ['idle', 'strategic']) {
        let state = init(config, seed, hero.id), actions = 0;
        while (['playing', 'reward'].includes(state.phase) && actions < maxActions) {
          const action = policy === 'strategic' ? chooseStrategyAction(config, state)
            : state.phase === 'reward' ? { type: 'reward', cardId: state.rewardChoices[0] } : { type: 'endTurn' };
          state = act(config, state, action); actions++;
        }
        runs.push({ seed, policy, outcome: ['victory', 'defeat'].includes(state.phase) ? state.phase : 'action_limit', actions });
      }
    }
    return { heroId: hero.id, strategicWins: runs.filter(run => run.policy === 'strategic' && run.outcome === 'victory').length,
      idleLosses: runs.filter(run => run.policy === 'idle' && run.outcome === 'defeat').length, runs };
  });
  const failures = heroes.flatMap(hero => [...(!hero.strategicWins ? ['NO_STRATEGIC_WIN'] : []),
    ...(!hero.idleLosses ? ['NO_IDLE_LOSS'] : []), ...(hero.runs.some(run => run.outcome === 'action_limit') ? ['ACTION_LIMIT'] : [])]
    .map(code => ({ heroId: hero.heroId, code })));
  return { passed: failures.length === 0, seeds, maxActions, heroes, failures };
}

// Reject every redirected ancestor, not just escapes. Outputs are exclusive-new.
export async function resolveQaPath(file, { privateRoot = PRIVATE, kind = 'file', mustExist = true } = {}) {
  check(typeof file === 'string' && file.length > 0 && !file.split(/[\\/]/).includes('..'), 'INVALID_QA_PATH');
  const base = path.resolve(privateRoot), target = path.resolve(file), relative = path.relative(base, target);
  check(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'INVALID_QA_PATH');
  const parts = relative.split(path.sep);
  check(parts.every(part => !/[\x00-\x1f\x7f:]/.test(part) && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'INVALID_QA_PATH');
  let current = base;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = path.join(current, parts[index]);
    try {
      const info = await lstat(current);
      check(!info.isSymbolicLink() && path.relative(current, await realpath(current)) === '', 'INVALID_QA_PATH');
      const leaf = index === parts.length - 1;
      check(leaf && kind === 'file' ? info.isFile() && info.nlink === 1 : info.isDirectory(), 'INVALID_QA_PATH');
    } catch (error) {
      if (error.code !== 'ENOENT' || mustExist) throw error;
      break;
    }
  }
  return target;
}

export async function collectRuntimeEvidence() {
  for (const file of GAME_RUNTIME_FILES) {
    const target = path.join(ROOT, file), metadata = await lstat(target);
    check(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1
      && path.relative(target, await realpath(target)) === '', 'INVALID_RUNTIME_FILE');
  }
  const runtimeFiles = await runtimeInventory();
  return { runtimeDigest: runtimeInventoryDigest(runtimeFiles), runtimeFiles };
}

function browserSeed(config) {
  for (let seed = 1; seed <= 32; seed++) {
    let state = init(config, seed, config.heroes[0].id), defended = false;
    for (let count = 0; count < 80 && state.phase === 'playing'; count++) {
      const action = chooseStrategyAction(config, state);
      defended ||= action.tileId !== undefined;
      state = act(config, state, action);
    }
    if (defended && state.phase === 'reward') return seed;
  }
  throw new Error('BROWSER_NO_DEFENSE_SEED');
}

export async function runCandidateBrowser(raw, { baseURL = 'http://localhost:3000', screenshots, assets, privateRoot = PRIVATE } = {}) {
  check(['http://localhost:3000', 'http://127.0.0.1:3000'].includes(baseURL), 'INVALID_QA_ORIGIN');
  const bundle = validateGameBundle(JSON.parse(raw)), version = bundle.config.gameVersion;
  // Fix only the trusted frame's run seed, chosen from the documented1..32 set.
  // This makes screenshots and interaction checks reproducible, not luck-based.
  let seed;
  try { seed = browserSeed(bundle.config); } catch { return { passed: false, results: [], error: 'BROWSER_NO_DEFENSE_SEED' }; }
  const directory = await resolveQaPath(screenshots, { privateRoot, kind: 'directory', mustExist: false });
  await mkdir(directory, { recursive: true });
  await resolveQaPath(directory, { privateRoot, kind: 'directory' });
  const { chromium, expect } = await import('@playwright/test');
  const runtime = await collectRuntimeEvidence();
  const expectedFiles = new Map(runtime.runtimeFiles.map(file => [file.path, file.sha256]));
  const assetBytes = new Map();
  if ((bundle.assets || []).length) {
    const assetRoot = await resolveQaPath(assets, { privateRoot, kind: 'directory' });
    for (const asset of bundle.assets) {
      const file = await resolveQaPath(path.join(assetRoot, asset.path.replace(/^assets\//, '')), { privateRoot });
      const bytes = await readFile(file); check(bytes.length === asset.bytes && sha(bytes) === asset.sha256, 'BROWSER_ASSET_BYTES_CHANGED');
      assetBytes.set(asset.path, bytes);
    }
  } else check(!assets, 'INVALID_QA_ARGUMENTS');
  const browser = await chromium.launch({ headless: true });
  const results = [];
  try {
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ baseURL, viewport: { width, height: width === 390 ? 844 : 1000 }, isMobile: width === 390, hasTouch: width === 390 });
      await context.addInitScript(seed => {
        const original = crypto.getRandomValues.bind(crypto);
        crypto.getRandomValues = values => {
          if (location.pathname === '/game-frame.html' && values instanceof Uint32Array && values.length === 1) { values[0] = seed; return values; }
          return original(values);
        };
      }, seed);
      const page = await context.newPage(), errors = [], unexpected = [], blocked = [], responses = [], served = new Set();
      page.setDefaultTimeout(10000); page.on('pageerror', () => errors.push('RUNTIME_PAGE_ERROR'));
      page.on('response', response => {
        const url = new URL(response.url()), file = url.pathname === '/' ? 'public/index.html' : 'public' + url.pathname;
        if (url.origin !== baseURL || !expectedFiles.has(file)) return;
        responses.push((async () => {
          try {
            if (!response.ok() || sha(await response.body()) !== expectedFiles.get(file)) errors.push('SERVED_RUNTIME_MISMATCH');
            else served.add(file);
          } catch { errors.push('SERVED_RUNTIME_UNREADABLE'); }
        })());
      });
      const now = '2026-08-31T03:00:00.000Z', cutoff = '2026-08-31T14:00:00.000Z', release = '2026-08-31T15:00:00.000Z';
      await page.clock.install({ time: new Date(now) });
      await context.route('**/*', route => {
        const request = route.request(), url = new URL(request.url());
        const reply = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        if (url.hostname === 'accounts.google.com') return route.abort();
        if (url.origin !== baseURL) { blocked.push('EXTERNAL_REQUEST'); return route.abort(); }
        if (url.pathname === `/games/${version}/game.json`) return route.fulfill({ contentType: 'application/json', body: raw });
        const assetPath = url.pathname.slice(`/games/${version}/`.length);
        if (url.pathname.startsWith(`/games/${version}/`) && assetBytes.has(assetPath)) {
          return route.fulfill({ contentType: 'image/png', body: assetBytes.get(assetPath) });
        }
        if (!url.pathname.startsWith('/api/')) return route.continue();
        if (request.method() !== 'GET' || url.search.includes('isolationProbe')) { unexpected.push('API_REQUEST'); return route.abort(); }
        if (url.pathname === '/api/session') return reply({ user: null, csrfToken: 'qa-fixture-csrf', googleNonce: 'qa-fixture-nonce' });
        if (url.pathname === '/api/locale') return reply({ locale: 'en', source: 'default' });
        if (url.pathname === '/api/status') return reply({ serverTime: now, firstReleaseAt: release,
          collection: { id: 'initial', status: 'open', closesAt: cutoff, releaseAt: release, initialClosed: false },
          limits: { bytes: 2000, submissions: 3, windowSeconds: 3600 }, googleClientId: 'qa-fixture.apps.googleusercontent.com',
          game: { published: true, version, sha256: sha(raw) }, service: { mode: 'active', proposalsEnabled: true, developmentEnabled: true, message: '' } });
        if (url.pathname === '/api/community') return reply({ recent: [], popular: [], leaderboard: { items: [] },
          publicationPolicy: { version: 'public-default-v1', defaultPublic: true }, round: { id: 'initial', status: 'open', closesAt: cutoff, limit: 3 },
          scoring: { status: 'pending_confirmation', issuanceEnabled: false, policyVersion: null }, serverTime: now });
        unexpected.push('API_REQUEST'); return route.abort();
      });
      let phase = 'load';
      try {
        await page.goto('/?lang=en');
        phase = 'start';
        const frame = page.frameLocator('#live-game-frame');
        const noOverflow = () => page.frames().find(candidate => candidate.url().endsWith('/game-frame.html')).evaluate(() => {
          const game = document.getElementById('game');
          return game.scrollWidth <= game.clientWidth && game.scrollHeight <= game.clientHeight
            && document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight;
        });
        phase = 'start_button';
        await expect(frame.getByRole('button', { name: 'Begin expedition', exact: true })).toBeEnabled();
        phase = 'start_layout';
        check(await noOverflow(), 'BROWSER_VERTICAL_OVERFLOW');
        phase = 'start_help';
        await frame.getByRole('button', { name: 'How to play', exact: true }).click();
        await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'help');
        check(await noOverflow(), 'BROWSER_VERTICAL_OVERFLOW');
        await frame.getByRole('button', { name: 'Return to game', exact: true }).click({ trial: true }).catch(() => {});
        await frame.getByRole('button', { name: 'Next', exact: true }).click();
        await frame.getByRole('button', { name: 'Next', exact: true }).click();
        await frame.getByRole('button', { name: 'Return to game', exact: true }).click();
        phase = 'start_fixed';
        if (bundle.experience?.choiceMode === 'single-fixed') {
          await expect(frame.locator('.hero')).toHaveCount(1);
          await expect(frame.locator('.founder-portrait')).toHaveCount(1);
        }
        phase = 'start_commit';
        await frame.getByRole('button', { name: 'Begin expedition', exact: true }).click();
        await page.waitForTimeout(250);
        phase = 'start_commit_' + (await frame.locator('#game').getAttribute('data-phase') || 'missing');
        await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
        phase = 'playing_cards';
        await expect(frame.locator('.card-art')).toHaveCount(4);
        phase = 'playing_board_art';
        if (bundle.art.boardImage) await expect(frame.locator('.hex').first()).toHaveCSS('background-image', /blob:/);
        phase = 'playing_layout';
        check(await noOverflow(), 'BROWSER_VERTICAL_OVERFLOW');
        const saved = () => page.evaluate(async version => {
          const { createGameSaveStore } = await import('/game-save-store.js'); const store = createGameSaveStore(version);
          try { return await store.load(); } finally { store.close(); }
        }, version);
        let record = await saved(), played = false, fortified = false;
        phase = 'action';
        for (let count = 0; count < 80 && record.data.state.phase === 'playing'; count++) {
          const action = chooseStrategyAction(bundle.config, record.data.state);
          if (action.type === 'endTurn') break;
          const card = frame.locator(`.card[data-card="${action.cardId}"]`).first();
          if (action.tileId !== undefined) {
            const hex = frame.locator(`.hex[data-tile="${action.tileId}"]`);
            const from = await card.evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
            const to = await hex.evaluate(node => { const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
            check(from && to, 'BROWSER_DRAG_TARGET_MISSING');
            await card.dispatchEvent('pointerdown', { pointerId: 7, pointerType: width === 390 ? 'touch' : 'mouse',
              isPrimary: true, button: 0, buttons: 1, clientX: from.x, clientY: from.y });
            await card.dispatchEvent('pointerup', { pointerId: 7, pointerType: width === 390 ? 'touch' : 'mouse',
              isPrimary: true, button: 0, buttons: 0, clientX: to.x, clientY: to.y });
            fortified = true;
          } else if (width === 390) await card.tap(); else await card.click();
          await expect.poll(async () => (await saved()).revision).toBe(record.revision + 1);
          record = await saved(); played = true;
        }
        check(played && fortified, 'BROWSER_NO_CARD_DEFENSE');
        phase = 'reward';
        await frame.locator('[data-action="endTurn"]').click();
        await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'reward');
        check(await noOverflow(), 'BROWSER_VERTICAL_OVERFLOW');
        const rewardState = (await saved()).data.state;
        const reward = bundle.experience?.rewardRule === 'first-seeded'
          ? { cardId: rewardState.rewardChoices[0] } : chooseStrategyAction(bundle.config, rewardState);
        if (bundle.experience?.rewardRule === 'first-seeded') await expect(frame.locator('.reward')).toHaveCount(1);
        await frame.locator(`.reward[data-card="${reward.cardId}"]`).click();
        await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'growth');
        check(await noOverflow(), 'BROWSER_VERTICAL_OVERFLOW');
        await frame.getByRole('button', { name: 'Return to game', exact: true }).click();
        await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
        phase = 'pause_resume';
        const snapshot = await saved();
        await page.locator('#prompt').fill('Synthetic QA draft; not submitted.');
        await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'paused');
        await frame.getByRole('button', { name: 'Resume', exact: true }).click();
        await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
        phase = 'save_locale';
        await page.locator('#language-select').selectOption('ko');
        await expect(frame.locator('html')).toHaveAttribute('lang', 'ko');
        check(JSON.stringify(await saved()) === JSON.stringify(snapshot), 'BROWSER_SAVE_CHANGED');
        phase = 'isolation';
        await page.locator('#language-select').selectOption('en'); await page.reload();
        await expect(frame.getByRole('button', { name: 'Continue expedition', exact: true })).toBeVisible();
        await frame.getByRole('button', { name: 'Continue expedition', exact: true }).click();
        await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
        check(JSON.stringify(await saved()) === JSON.stringify(snapshot), 'BROWSER_SAVE_CHANGED');
        const child = page.frames().find(candidate => candidate.url().endsWith('/game-frame.html'));
        const denials = await child.evaluate(async () => {
          const probe = fn => { try { fn(); return false; } catch (error) { return error.name === 'SecurityError'; } };
          const result = { parent: probe(() => parent.document), cookie: probe(() => document.cookie),
            storage: probe(() => localStorage.getItem('qa')), indexedDB: probe(() => indexedDB.open('qa-denied')) };
          for (const url of ['/api/session?isolationProbe=1', 'https://qa-isolation.invalid/blocked']) {
            try { await fetch(url); result[url.startsWith('/') ? 'api' : 'network'] = false; }
            catch (error) { result[url.startsWith('/') ? 'api' : 'network'] = error.name === 'TypeError'; }
          }
          return result;
        });
        check(Object.values(denials).every(Boolean), 'BROWSER_ISOLATION_FAILED');
        phase = 'layout';
        const bounds = await page.locator('#live-game-frame').boundingBox();
        check(Math.abs(bounds.width / bounds.height - 9 / 16) < 0.01
          && await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
          && await child.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
          && await noOverflow(), 'BROWSER_LAYOUT_FAILED');
        const visibleGame = page.locator('#live-game-frame');
        await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
        await expect(frame.locator('#game')).toBeVisible();
        await visibleGame.scrollIntoViewIfNeeded();
        await child.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const gameOutput = await resolveQaPath(path.join(directory, `runtime-game-${width}.png`), { privateRoot, mustExist: false });
        const gameCapture = await visibleGame.screenshot();
        await writeFile(gameOutput, gameCapture, { flag: 'wx' });
        const output = await resolveQaPath(path.join(directory, `runtime-${width}.png`), { privateRoot, mustExist: false });
        const capture = await page.screenshot({ fullPage: true });
        await writeFile(output, capture, { flag: 'wx' });
        await Promise.all(responses);
        check(['public/index.html', 'public/app.js', 'public/game-runtime-engine.js', 'public/game-runtime-frame.js',
          'public/game-frame.html', 'public/game-host.js'].every(file => served.has(file)), 'SERVED_RUNTIME_MISSING');
        check(errors.length === 0 && unexpected.length === 0 && blocked.length === 0, 'BROWSER_RUNTIME_FAILED');
        results.push({ width, seed, passed: true, checks: ['card_hex', 'wave_reward', 'pause_resume', 'locale', 'reload_save', 'isolation', 'layout', 'served_runtime_bytes'],
          screenshot: path.relative(privateRoot, output).split(path.sep).join('/'), screenshotSha256: sha(capture),
          gameScreenshot: path.relative(privateRoot, gameOutput).split(path.sep).join('/'), gameScreenshotSha256: sha(gameCapture), servedFiles: [...served].sort() });
      } catch (error) {
        results.push({ width, passed: false, phase,
          error: /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'BROWSER_CHECK_FAILED' });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  return { passed: results.every(result => result.passed), results };
}

export async function validateCandidateRun({ bundle: input, evidence, screenshots, assets }, { privateRoot = PRIVATE } = {}) {
  const bundlePath = await resolveQaPath(input, { privateRoot });
  const evidencePath = await resolveQaPath(evidence, { privateRoot, mustExist: false });
  const bytes = await readFile(bundlePath); check(bytes.length <= 98304, 'GAME_BUNDLE_TOO_LARGE');
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const bundle = validateGameBundle(JSON.parse(raw)), before = await collectRuntimeEvidence();
  const balance = evaluateGameBalance(bundle), browser = await runCandidateBrowser(raw, { screenshots, assets, privateRoot });
  const after = await collectRuntimeEvidence();
  const result = { schemaVersion: 1, contentSha256: sha(bytes), ...before, balance, browser,
    runtimeUnchanged: before.runtimeDigest === after.runtimeDigest,
    passed: balance.passed && browser.passed && before.runtimeDigest === after.runtimeDigest, approvalGranted: false };
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await resolveQaPath(evidencePath, { privateRoot, mustExist: false });
  await writeFile(evidencePath, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}

export function parseQaArguments(argv) {
  const args = {};
  for (const arg of argv) {
    const match = /^--(bundle|evidence|screenshots|assets)=(.+)$/.exec(arg);
    check(match && !Object.hasOwn(args, match[1]), 'INVALID_QA_ARGUMENTS'); args[match[1]] = match[2];
  }
  check(['bundle', 'evidence', 'screenshots'].every(key => args[key]), 'INVALID_QA_ARGUMENTS'); return args;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await validateCandidateRun(parseQaArguments(process.argv.slice(2)));
    console.log(JSON.stringify({ passed: result.passed, balance: result.balance.passed, browser: result.browser.passed, approvalGranted: false }));
    if (!result.passed) process.exitCode = 1;
  } catch { console.error(JSON.stringify({ passed: false, error: 'CANDIDATE_QA_FAILED', approvalGranted: false })); process.exitCode = 1; }
}
