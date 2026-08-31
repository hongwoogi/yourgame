import { test, expect } from '@playwright/test';

// Real browser IndexedDB, but every application API response is synthetic.
// These tests do not authenticate an account, touch a server DB, or play a game.
const START = Date.parse('2026-08-31T03:00:00.000Z');
const CUTOFF = '2026-08-31T14:00:00.000Z';
const RELEASE = '2026-08-31T15:00:00.000Z';
const ANONYMOUS = { user: null, csrfToken: 'game-save-fixture-csrf', googleNonce: 'game-save-fixture-nonce' };
const SIGNED_IN = { ...ANONYMOUS, user: { id: 'game-save-fixture-user', name: 'Storage fixture' } };

async function mockApi(context, { signedIn = false } = {}) {
  const state = { session: structuredClone(signedIn ? SIGNED_IN : ANONYMOUS), mutations: [], unexpected: [] };
  await context.route('https://accounts.google.com/**', route => route.abort());
  await context.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') state.mutations.push(pathname);
    if (pathname === '/api/locale') return reply({ locale: 'en', source: 'default', supportedLocales: ['en', 'ko'] });
    if (pathname === '/api/session') return reply(state.session);
    if (pathname === '/api/status') return reply({
      serverTime: new Date(START).toISOString(), firstReleaseAt: RELEASE,
      collection: { id: 'initial', status: 'open', closesAt: CUTOFF, releaseAt: RELEASE, initialClosed: false },
      limits: { bytes: 2000, submissions: 3, windowSeconds: 3600 },
      game: { published: false }, googleClientId: 'game-save-fixture.apps.googleusercontent.com',
      service: { mode: 'active', proposalsEnabled: true, developmentEnabled: true, message: '' },
    });
    if (pathname === '/api/community' && url.searchParams.get('view') === 'me') return reply({
      ownerId: state.session.user?.id || null,
      profile: { id: 'game-save-fixture-profile', alias: 'Storage-player', leaderboardVisible: true, visibilitySource: 'service_default', revision: 1 },
      publicationPolicy: { version: 'public-default-v1', defaultPublic: true },
      contribution: { points: '0', adoptedCount: 0, rank: null },
      voteQuota: { roundId: 'initial', limit: 3, used: 0, remaining: 3, closesAt: CUTOFF },
      votes: [], publications: [],
    });
    if (pathname === '/api/community') return reply({
      recent: [], popular: [], leaderboard: { items: [] },
      publicationPolicy: { version: 'public-default-v1', defaultPublic: true },
      round: { id: 'initial', status: 'open', closesAt: CUTOFF, limit: 3 },
      scoring: { status: 'pending_confirmation', issuanceEnabled: false, policyVersion: null },
      serverTime: new Date(START).toISOString(),
    });
    if (pathname === '/api/proposals' && request.method() === 'GET') return reply({
      ownerId: state.session.user?.id || null, proposals: [],
      quota: { remaining: 3, limit: 3, nextAvailableAt: null }, serverTime: new Date(START).toISOString(),
    });
    if (pathname === '/api/logout' && request.method() === 'POST') {
      state.session = structuredClone(ANONYMOUS);
      return reply(state.session);
    }
    // No unhandled API request can escape to the local server/database.
    state.unexpected.push({ pathname, method: request.method() });
    return reply({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST' } }, 400);
  });
  return state;
}

async function openMain(page, { signedIn = false } = {}) {
  await page.clock.install({ time: new Date(START) });
  await page.goto('/?lang=en');
  await expect(page.locator(signedIn ? '#logout-button' : '#login-button')).toBeEnabled();
  await expect(page.locator('#community-feed-panel')).toHaveAttribute('aria-busy', 'false');
}

async function loadSave(page, version) {
  return page.evaluate(async gameVersion => {
    const { createGameSaveStore } = await import('/game-save-store.js');
    const store = createGameSaveStore(gameVersion);
    try { return await store.load(); } finally { store.close(); }
  }, version);
}

async function saveGame(page, version, data, expectedRevision = 0) {
  return page.evaluate(async ({ gameVersion, data, expectedRevision }) => {
    const { createGameSaveStore } = await import('/game-save-store.js');
    const store = createGameSaveStore(gameVersion);
    try { return await store.save(data, { expectedRevision }); } finally { store.close(); }
  }, { gameVersion: version, data, expectedRevision });
}

test('real IndexedDB isolates immutable versions without copying or resetting an older save', async ({ page, context }) => {
  const state = await mockApi(context);
  await openMain(page);
  const first = await saveGame(page, 'browser-v1', { level: 4, inventory: ['fixture-key'] });
  expect(first.revision).toBe(1);
  expect(await loadSave(page, 'browser-v2')).toBeNull();
  const second = await saveGame(page, 'browser-v2', { level: 1 });
  expect(second.revision).toBe(1);
  expect(await loadSave(page, 'browser-v1')).toEqual(first);
  expect(await loadSave(page, 'browser-v2')).toEqual(second);
  const databases = await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name).sort());
  expect(databases).toEqual(['yourgame:save:browser-v1', 'yourgame:save:browser-v2']);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('a full main-page reload retains the committed game save and its revision', async ({ page, context }) => {
  const state = await mockApi(context);
  await openMain(page);
  await saveGame(page, 'browser-reload', { room: 1 });
  const saved = await saveGame(page, 'browser-reload', { room: 2, text: '저장 확인' }, 1);
  expect(saved.revision).toBe(2);
  await page.reload();
  await expect(page.locator('#login-button')).toBeEnabled();
  expect(await loadSave(page, 'browser-reload')).toEqual(saved);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('real IndexedDB serializes competing tabs and rejects the stale writer without losing the winner', async ({ page, context }) => {
  const state = await mockApi(context);
  await openMain(page);
  const other = await context.newPage();
  await openMain(other);
  try {
    const initialize = async tab => tab.evaluate(async () => {
      const { createGameSaveStore } = await import('/game-save-store.js');
      window.gameSaveTestStore = createGameSaveStore('browser-tabs');
      return window.gameSaveTestStore.load();
    });
    expect(await initialize(page)).toBeNull();
    expect(await initialize(other)).toBeNull();
    const write = (tab, writer) => tab.evaluate(async writer => {
      try { return { ok: true, record: await window.gameSaveTestStore.save({ writer }, { expectedRevision: 0 }) }; }
      catch (error) { return { ok: false, code: error.code }; }
    }, writer);
    const results = await Promise.all([write(page, 'tab-a'), write(other, 'tab-b')]);
    const winners = results.filter(result => result.ok);
    const losers = results.filter(result => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toEqual([{ ok: false, code: 'SAVE_CONFLICT' }]);
    expect(winners[0].record.revision).toBe(1);
    expect(await loadSave(page, 'browser-tabs')).toEqual(winners[0].record);
    expect(await loadSave(other, 'browser-tabs')).toEqual(winners[0].record);
    const loserTab = results[0].ok ? other : page;
    const resumed = await loserTab.evaluate(async () => {
      const current = await window.gameSaveTestStore.load();
      return window.gameSaveTestStore.save({ ...current.data, resumed: true }, { expectedRevision: current.revision });
    });
    expect(resumed.revision).toBe(2);
    expect(await loadSave(page, 'browser-tabs')).toEqual(resumed);
    expect(state.mutations).toEqual([]);
    expect(state.unexpected).toEqual([]);
  } finally {
    await page.evaluate(() => window.gameSaveTestStore?.close());
    await other.close();
  }
});

test('language controls and mocked logout leave versioned game saves intact', async ({ page, context }) => {
  const state = await mockApi(context, { signedIn: true });
  await openMain(page, { signedIn: true });
  const saved = await saveGame(page, 'browser-unrelated-ui', { floor: 5, upgrades: ['fixture-shield'] });
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  expect(await loadSave(page, 'browser-unrelated-ui')).toEqual(saved);
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await loadSave(page, 'browser-unrelated-ui')).toEqual(saved);
  await page.locator('#logout-button').click();
  await expect(page.locator('#login-button')).toBeEnabled();
  await expect(page.locator('#logout-button')).toBeHidden();
  expect(await loadSave(page, 'browser-unrelated-ui')).toEqual(saved);
  await page.reload();
  await expect(page.locator('#login-button')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await loadSave(page, 'browser-unrelated-ui')).toEqual(saved);
  expect(state.mutations).toEqual(['/api/logout']);
  expect(state.unexpected).toEqual([]);
});

for (const width of [320, 390, 1440]) {
  test(`main-page preview stays 9:16 without horizontal overflow at ${width}px`, async ({ page, context }) => {
    const state = await mockApi(context);
    await page.setViewportSize({ width, height: width < 800 ? 844 : 1000 });
    await openMain(page);
    for (const language of ['en', 'ko']) {
      await page.locator('#language-select').selectOption(language);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      const surface = page.locator('main .preview-surface');
      await expect(surface).toBeVisible();
      await expect(page.locator('main #prompt-form')).toBeVisible();
      const bounds = await surface.boundingBox();
      expect(bounds.width).toBeGreaterThan(0);
      expect(bounds.width / bounds.height).toBeCloseTo(9 / 16, 3);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(surface.locator('canvas')).toHaveAttribute('width', '720');
      await expect(surface.locator('canvas')).toHaveAttribute('height', '1280');
      // Assert an honest placeholder, not evidence that a game has been released.
      await expect(surface.locator('canvas')).toHaveAttribute('aria-label',
        language === 'en' ? /No playable game is available/ : /아직 플레이할 게임은 없습니다/);
      expect(new URL(page.url()).pathname).toBe('/');
    }
    expect(state.mutations).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
}
