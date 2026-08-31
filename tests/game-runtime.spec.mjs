import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { fixtureBundle } from './fixtures/game-bundle.mjs';

// Runtime integration uses synthetic declarative content and fully mocked APIs.
// No actual community proposal, identity, production database, or release is used.
const START = '2026-08-31T03:00:00.000Z';
const CUTOFF = '2026-08-31T14:00:00.000Z';
const RELEASE = '2026-08-31T15:00:00.000Z';

async function fixture(context, { bundle = fixtureBundle(), digest } = {}) {
  const raw = JSON.stringify(bundle);
  const version = bundle.config.gameVersion;
  const sha256 = digest ?? createHash('sha256').update(raw).digest('hex');
  const state = { requests: [], mutations: [], unexpected: [], externalProbes: [], bundleReads: 0 };
  await context.route('https://accounts.google.com/**', route => route.abort());
  await context.route('https://isolation-probe.invalid/**', route => {
    state.externalProbes.push(route.request().url());
    return route.abort();
  });
  await context.route('**/games/**', route => {
    state.bundleReads += 1;
    if (new URL(route.request().url()).pathname !== `/games/${version}/game.json`) {
      state.unexpected.push('game-path');
      return route.fulfill({ status: 404, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: raw });
  });
  await context.route('**/api/**', route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    state.requests.push({ path, query: url.search, method: request.method() });
    if (request.method() !== 'GET') state.mutations.push(path);
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/locale') return reply({ locale: 'en', source: 'default', supportedLocales: ['en', 'ko'] });
    if (path === '/api/session') return reply({ user: null, csrfToken: 'runtime-fixture-csrf', googleNonce: 'runtime-fixture-nonce' });
    if (path === '/api/status') return reply({
      serverTime: START, firstReleaseAt: RELEASE,
      collection: { id: 'initial', status: 'open', closesAt: CUTOFF, releaseAt: RELEASE, initialClosed: false },
      limits: { bytes: 2000, submissions: 3, windowSeconds: 3600 },
      googleClientId: 'runtime-fixture.apps.googleusercontent.com',
      game: { published: true, version, sha256 },
      service: { mode: 'active', proposalsEnabled: true, developmentEnabled: true, message: '' },
    });
    if (path === '/api/community') return reply({
      recent: [], popular: [], leaderboard: { items: [] },
      publicationPolicy: { version: 'public-default-v1', defaultPublic: true },
      round: { id: 'initial', status: 'open', closesAt: CUTOFF, limit: 3 },
      scoring: { status: 'pending_confirmation', issuanceEnabled: false, policyVersion: null }, serverTime: START,
    });
    state.unexpected.push(path);
    return reply({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST' } }, 400);
  });
  return state;
}

async function openMain(page) {
  await page.clock.install({ time: new Date(START) });
  await page.goto('/?lang=en');
  await expect(page.locator('#login-button')).toBeEnabled();
}

async function readyFrame(page) {
  await expect(page.locator('#live-game-frame')).toBeVisible();
  const frame = page.frameLocator('#live-game-frame');
  await expect(frame.getByRole('heading', { name: 'Fixture Kingdom', exact: true })).toBeVisible();
  await expect(frame.getByRole('button', { name: 'Begin expedition', exact: true })).toBeEnabled();
  return frame;
}

async function start(frame) {
  await frame.locator('[data-hero="hero-a"]').click();
  await frame.getByRole('button', { name: 'Begin expedition', exact: true }).click();
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
  await expect(frame.locator('[data-action="endTurn"]')).toBeEnabled();
}

async function saved(page) {
  return page.evaluate(async () => {
    const { createGameSaveStore } = await import('/game-save-store.js');
    const store = createGameSaveStore('fixture-v1');
    try { return await store.load(); } finally { store.close(); }
  });
}

async function endWave(frame) {
  await frame.locator('[data-action="endTurn"]').click();
  await expect(frame.locator('.save-status')).not.toHaveText(/Saving|저장 중/);
}

test('the main-page isolated frame plays a synthetic defend, reward, victory and explicit retry loop', async ({ page, context }) => {
  const state = await fixture(context);
  await openMain(page);
  const frame = await readyFrame(page);
  await start(frame);
  await expect(frame.locator('.hex')).toHaveCount(7);
  const before = await saved(page);
  expect(before.revision).toBe(1);
  const tileId = before.data.state.incoming[0].tileId;
  await frame.locator('.card[data-card="guard"]').click();
  await expect(frame.locator('.card[data-card="guard"]')).toHaveAttribute('aria-pressed', 'true');
  await frame.locator(`.hex[data-tile="${tileId}"]`).click();
  await expect(frame.locator(`.hex[data-tile="${tileId}"] strong`)).toHaveText('6');
  await expect(frame.locator('.card[data-card="guard"]')).toHaveCount(0);
  expect((await saved(page)).revision).toBe(2);
  await endWave(frame);
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'reward');
  await expect(frame.locator('.reward')).toHaveCount(2);
  await frame.locator('.reward[data-card="guard"]').click();
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
  await expect(frame.locator('.wave-title')).toHaveText('Fixture wave two');
  expect((await saved(page)).data.state.acquired).toEqual(['guard']);
  await endWave(frame);
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'victory');
  await expect(frame.getByText('Fixture victory recorded.', { exact: true })).toBeVisible();
  const finished = await saved(page);
  expect(finished.data.state.phase).toBe('victory');
  await frame.getByRole('button', { name: 'New expedition', exact: true }).click();
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
  const restarted = await saved(page);
  expect(restarted.data.state.seed).not.toBe(finished.data.state.seed);
  expect(restarted.revision).toBe(finished.revision + 1);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('skipping defense loses and a full reload preserves the finished save until explicit continuation/retry', async ({ page, context }) => {
  await fixture(context);
  await openMain(page);
  let frame = await readyFrame(page);
  await start(frame);
  await endWave(frame);
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'reward');
  await frame.locator('.reward[data-card="harvest"]').click();
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
  await endWave(frame);
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'defeat');
  const dead = await saved(page);
  expect(dead.data.state.stats.health).toBe(0);
  await page.reload();
  frame = page.frameLocator('#live-game-frame');
  await expect(frame.getByRole('button', { name: 'Continue expedition', exact: true })).toBeVisible();
  expect(await saved(page)).toEqual(dead);
  await frame.getByRole('button', { name: 'Continue expedition', exact: true }).click();
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'defeat');
  expect(await saved(page)).toEqual(dead);
  await frame.getByRole('button', { name: 'New expedition', exact: true }).click();
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
  expect((await saved(page)).data.state.seed).not.toBe(dead.data.state.seed);
});

test('language changes, writing a proposal, explicit resume, and reload preserve live progress', async ({ page, context }) => {
  const state = await fixture(context);
  await openMain(page);
  let frame = await readyFrame(page);
  await start(frame);
  await frame.locator('.card[data-card="harvest"]').click();
  await expect(frame.locator('[data-stat="food"] strong')).toHaveText('5');
  const before = await saved(page);
  await page.locator('#language-select').selectOption('ko');
  await expect(frame.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(frame.locator('[data-stat="food"] span')).toHaveText('식량');
  expect(await saved(page)).toEqual(before);
  await page.locator('#prompt').fill('Synthetic unsent draft stays outside the game.');
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'paused');
  await expect(frame.getByRole('button', { name: '계속하기', exact: true })).toBeVisible();
  expect(await saved(page)).toEqual(before);
  await frame.getByRole('button', { name: '계속하기', exact: true }).click();
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
  expect(await saved(page)).toEqual(before);
  await page.locator('#language-select').selectOption('en');
  await expect(frame.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  frame = page.frameLocator('#live-game-frame');
  await expect(frame.getByRole('button', { name: 'Continue expedition', exact: true })).toBeVisible();
  await frame.getByRole('button', { name: 'Continue expedition', exact: true }).click();
  await expect(frame.locator('.card[data-card="harvest"]')).toHaveCount(0);
  await expect(frame.locator('[data-stat="food"] strong')).toHaveText('5');
  await expect(page.locator('#prompt')).toHaveValue('Synthetic unsent draft stays outside the game.');
  expect(await saved(page)).toEqual(before);
  expect(state.mutations).toEqual([]);
});

test('opaque game frame cannot read parent/session storage or connect to APIs or the network', async ({ page, context }) => {
  const state = await fixture(context);
  await openMain(page);
  await readyFrame(page);
  const frame = page.frames().find(item => new URL(item.url()).pathname === '/game-frame.html');
  expect(frame).toBeTruthy();
  const denied = await frame.evaluate(async () => {
    const access = operation => { try { operation(); return 'allowed'; } catch (error) { return error.name; } };
    const results = {
      parent: access(() => parent.document), cookie: access(() => document.cookie),
      localStorage: access(() => localStorage.getItem('not-an-account')),
      sessionStorage: access(() => sessionStorage.getItem('not-a-session')),
      indexedDB: access(() => indexedDB.open('must-not-open')),
    };
    const violations = [];
    document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
    for (const [name, url] of [['api', '/api/session?isolationProbe=1'], ['network', 'https://isolation-probe.invalid/blocked']]) {
      try { await fetch(url); results[name] = 'allowed'; } catch (error) { results[name] = error.name; }
    }
    const policy = document.permissionsPolicy || document.featurePolicy;
    results.camera = policy?.allowsFeature('camera') ?? null;
    results.microphone = policy?.allowsFeature('microphone') ?? null;
    results.violations = violations;
    return results;
  });
  for (const key of ['parent', 'cookie', 'localStorage', 'sessionStorage', 'indexedDB']) expect(denied[key]).toBe('SecurityError');
  expect(denied.api).toBe('TypeError');
  expect(denied.network).toBe('TypeError');
  expect(denied.camera).toBe(false);
  expect(denied.microphone).toBe(false);
  expect(state.requests.filter(request => request.query.includes('isolationProbe'))).toEqual([]);
  expect(state.externalProbes).toEqual([]);
  const originalUrl = page.url();
  const originalPages = context.pages().length;
  const navigation = await frame.evaluate(() => {
    let topNavigation;
    try { top.location.href = 'http://localhost:3000/?isolationProbe=navigation'; topNavigation = 'allowed'; }
    catch (error) { topNavigation = error.name; }
    return { topNavigation, popup: window.open('http://localhost:3000/?isolationProbe=popup') === null };
  });
  expect(navigation).toEqual({ topNavigation: 'SecurityError', popup: true });
  expect(page.url()).toBe(originalUrl);
  expect(context.pages()).toHaveLength(originalPages);
  await expect(page.locator('#live-game-frame')).toHaveAttribute('sandbox', 'allow-scripts');
  expect(state.unexpected).toEqual([]);
});

for (const invalid of ['html', 'url', 'unknown-field', 'digest']) {
  test(`untrusted ${invalid} content is rejected before a live game is mounted`, async ({ page, context }) => {
    const bundle = fixtureBundle();
    if (invalid === 'html') bundle.copy.title.en = '<img src=x onerror=alert(1)>';
    if (invalid === 'url') bundle.copy.story.en = 'Open https://isolation-probe.invalid/secret';
    if (invalid === 'unknown-field') bundle.config.execute = 'This field must never be interpreted.';
    const state = await fixture(context, { bundle, ...(invalid === 'digest' ? { digest: '0'.repeat(64) } : {}) });
    await openMain(page);
    await expect.poll(() => state.bundleReads).toBeGreaterThan(0);
    // Require the settled host error, not merely the initial blank placeholder.
    await expect(page.locator('#preview-note')).toContainText('The game could not load');
    await expect(page.locator('#game-preview-canvas')).toBeVisible();
    await expect(page.locator('#live-game-frame')).toHaveCount(0);
    expect(state.externalProbes).toEqual([]);
    expect(state.mutations).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
}

for (const width of [390, 1440]) {
  test.describe(`runtime viewport ${width}`, () => {
    test.use({ viewport: { width, height: width < 800 ? 844 : 1000 }, isMobile: width < 800, hasTouch: width < 800 });
    test(`the mounted game remains on the 9:16 main-page surface at ${width}px`, async ({ page, context }) => {
      await fixture(context);
      await openMain(page);
      const frame = await readyFrame(page);
      await start(frame);
      if (width < 800) {
        const record = await saved(page);
        const target = record.data.state.incoming[0].tileId;
        await frame.locator('.card[data-card="guard"]').tap();
        await frame.locator(`.hex[data-tile="${target}"]`).tap();
        await expect(frame.locator(`.hex[data-tile="${target}"] strong`)).toHaveText('6');
      }
      const bounds = await page.locator('#live-game-frame').boundingBox();
      expect(bounds.width / bounds.height).toBeCloseTo(9 / 16, 2);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const runtime = page.frames().find(item => new URL(item.url()).pathname === '/game-frame.html');
      expect(await runtime.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(page.locator('main #prompt-form')).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/');
    });
  });
}
