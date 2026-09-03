import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { fixtureBundle } from './fixtures/game-bundle.mjs';

// Synthetic lifecycle tests only: every API response and candidate is mocked.
// A fixture is not a released game or evidence of a real participant account.
const NOW = '2026-08-31T03:00:00.000Z';
const CUTOFF = '2026-08-31T14:00:00.000Z';
const RELEASE = '2026-08-31T15:00:00.000Z';
const payload = version => JSON.stringify(fixtureBundle({ version }));
const descriptor = version => ({ published: true, version, sha256: createHash('sha256').update(payload(version)).digest('hex') });
const invalidSchemaPayload = version => {
  const bundle = fixtureBundle({ version }); bundle.config.execute = 'Inert field that must be rejected.'; return JSON.stringify(bundle);
};

async function fixture(context, { firstFailure = null } = {}) {
  const state = { game: descriptor('fixture-v1'), mode: 'active', failure: firstFailure,
    statusReads: 0, bundleReads: 0, frameLoads: 0, mutations: [], unexpected: [] };
  await context.route('https://accounts.google.com/**', route => route.abort());
  await context.route('**/game-frame.html', route => {
    state.frameLoads++;
    if (state.failure === 'runtime') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><p>Synthetic frame did not initialize.</p>' });
    return route.continue();
  });
  await context.route('**/games/**', route => {
    state.bundleReads++;
    if (state.failure === 'http-once') { state.failure = null; return route.fulfill({ status: 503, body: '' }); }
    if (state.failure === 'http') return route.fulfill({ status: 503, body: '' });
    const version = new URL(route.request().url()).pathname.split('/')[2];
    return route.fulfill({ contentType: 'application/json', body: state.failure === 'digest' ? '{}'
      : state.failure === 'schema' ? invalidSchemaPayload(version) : payload(version) });
  });
  await context.route('**/api/**', route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() !== 'GET') state.mutations.push(pathname);
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/locale') return reply({ locale: 'en', source: 'default' });
    if (pathname === '/api/session') return reply({ user: null, csrfToken: 'host-fixture-csrf', googleNonce: 'host-fixture-nonce' });
    if (pathname === '/api/status') {
      state.statusReads++;
      return reply({ serverTime: NOW, firstReleaseAt: RELEASE,
        collection: { id: 'initial', status: state.mode === 'active' ? 'open' : 'paused', closesAt: CUTOFF, releaseAt: RELEASE, initialClosed: false },
        limits: { bytes: 2000, submissions: 3, windowSeconds: 3600 }, googleClientId: 'host-fixture.apps.googleusercontent.com', game: state.game,
        service: { mode: state.mode, proposalsEnabled: state.mode === 'active', developmentEnabled: state.mode === 'active', message: '' } });
    }
    if (pathname === '/api/community') return reply({ recent: [], popular: [], leaderboard: { items: [] },
      publicationPolicy: { version: 'public-default-v1', defaultPublic: true }, round: { id: 'initial', status: 'open', closesAt: CUTOFF, limit: 3 },
      scoring: { status: 'pending_confirmation', issuanceEnabled: false, policyVersion: null }, serverTime: NOW });
    state.unexpected.push(pathname); return reply({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST' } }, 400);
  });
  return state;
}

async function openMain(page) {
  await page.clock.install({ time: new Date(NOW) });
  await page.goto('/?lang=en');
  await expect(page.locator('#login-button')).toBeEnabled();
}

async function startPrevious(page) {
  const frame = page.frameLocator('iframe[data-game-version="fixture-v1"]');
  await expect(frame.getByRole('button', { name: 'Begin expedition', exact: true })).toBeEnabled();
  await frame.getByRole('button', { name: 'Begin expedition', exact: true }).click();
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
  await frame.locator('.card[data-card="harvest"]').click();
  await expect(frame.locator('[data-stat="food"] strong')).toHaveText('5');
  return frame;
}

async function saved(page) {
  return page.evaluate(async () => {
    const { createGameSaveStore } = await import('/game-save-store.js');
    const store = createGameSaveStore('fixture-v1');
    try { return await store.load(); } finally { store.close(); }
  });
}

async function refreshStatus(page, state) {
  const previous = state.statusReads;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => state.statusReads).toBeGreaterThan(previous);
}

for (const failure of ['http', 'runtime']) {
  test(`failed first publication (${failure}) leaves the honest placeholder with no invented game or save`, async ({ page, context }) => {
    const state = await fixture(context, { firstFailure: failure });
    await openMain(page);
    if (failure === 'runtime') {
      await expect.poll(() => state.frameLoads).toBe(1);
      await page.clock.fastForward(46000);
      await page.clock.fastForward(2000);
      await expect.poll(() => state.frameLoads).toBe(2);
      await page.clock.fastForward(46000);
    }
    await expect(page.locator('#preview-note')).toContainText('The game could not load');
    await expect(page.locator('#live-game-frame')).toHaveCount(0);
    await expect(page.locator('#game-preview-canvas')).toBeVisible();
    expect(await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name))).toEqual([]);
    await page.locator('#prompt').fill('Synthetic draft still works without a game.');
    await expect(page.locator('#prompt')).toHaveValue('Synthetic draft still works without a game.');
    expect(state.mutations).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
}

for (const failure of ['http', 'digest', 'schema', 'runtime', 'descriptor']) {
  test(`failed replacement (${failure}) preserves the same previous frame, progress and working save bridge`, async ({ page, context }) => {
    const state = await fixture(context);
    await openMain(page);
    const previousFrame = await startPrevious(page), record = await saved(page);
    const marker = await page.locator('iframe[data-game-version="fixture-v1"]').evaluate(node => node.qaPreservationMarker = crypto.randomUUID());
    state.failure = failure;
    state.game = descriptor('fixture-v2');
    if (failure === 'descriptor') state.game.sha256 = 'malformed-descriptor';
    if (failure === 'schema') state.game.sha256 = createHash('sha256').update(invalidSchemaPayload('fixture-v2')).digest('hex');
    await refreshStatus(page, state);
    if (failure === 'runtime') {
      await expect.poll(() => state.frameLoads).toBe(2);
      // The still-working frame remains visible while the new hidden frame times out.
      await expect(page.locator('iframe[data-game-version="fixture-v1"]')).toBeVisible();
      expect(await saved(page)).toEqual(record);
      await page.clock.fastForward(46000);
    }
    await expect(page.locator('#preview-note')).toContainText('Keeping the previous working game');
    await expect(page.locator('#preview-note')).toContainText('fixture-v1');
    await expect(page.locator('#live-game-frame')).toHaveCount(1);
    await expect(page.locator('iframe[data-game-version="fixture-v1"]')).toBeVisible();
    await expect(page.locator('#game-preview-canvas')).toBeHidden();
    expect(await page.locator('#live-game-frame').evaluate(node => node.qaPreservationMarker)).toBe(marker);
    expect(await saved(page)).toEqual(record);
    await expect(previousFrame.locator('.card[data-card="harvest"]')).toHaveCount(0);
    // Continue using the old verified frame after replacement failure.
    await previousFrame.locator('.card[data-card="guard"]').click();
    const tileId = record.data.state.incoming[0].tileId;
    await previousFrame.locator(`.hex[data-tile="${tileId}"]`).click();
    await expect(previousFrame.locator(`.hex[data-tile="${tileId}"] strong`)).toHaveText('6');
    expect((await saved(page)).revision).toBe(record.revision + 1);
    const attempts = state.bundleReads;
    await refreshStatus(page, state);
    await expect(page.locator('#preview-note')).toContainText('Keeping the previous working game');
    expect(state.bundleReads).toBe(attempts);
    expect(state.mutations).toEqual([]);
    expect(state.unexpected).toEqual([]);
  });
}

test('a transient first-load failure retries once and mounts the same verified game', async ({ page, context }) => {
  const state = await fixture(context, { firstFailure: 'http-once' });
  await openMain(page);
  await page.clock.fastForward(2000);
  await expect.poll(() => state.bundleReads).toBe(2);
  await expect(page.locator('#live-game-frame')).toBeVisible();
  await expect(page.locator('#preview-note')).toContainText('Playable here');
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});

test('maintenance pauses and locks the existing game without discarding progress; returning active needs explicit resume', async ({ page, context }) => {
  const state = await fixture(context);
  await openMain(page);
  const frame = await startPrevious(page), record = await saved(page);
  state.mode = 'maintenance';
  await refreshStatus(page, state);
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'paused');
  await expect(frame.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
  expect(await saved(page)).toEqual(record);
  state.mode = 'active';
  await refreshStatus(page, state);
  await expect(frame.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'paused');
  await frame.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
  expect(await saved(page)).toEqual(record);
  expect(state.bundleReads).toBe(1);
  expect(state.mutations).toEqual([]);
  expect(state.unexpected).toEqual([]);
});
