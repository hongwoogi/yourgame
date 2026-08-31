import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { fixtureBundle } from './fixtures/game-bundle.mjs';

// Synthetic clock, public responses and game bytes only; no production data.
const BEFORE_CLOSE = '2026-09-01T13:59:59.000Z';
const CLOSE = '2026-09-01T14:00:00.000Z';
const MIDNIGHT = '2026-09-01T15:00:00.000Z';
const NEXT_MIDNIGHT = '2026-09-02T15:00:00.000Z';
const firstCollection = {
  id: 'pending', status: 'open', initialClosed: true, schedule: 'daily-kst-v1',
  cycleId: 'daily-2026-09-01', opensAt: '2026-08-31T14:00:00.000Z',
  closesAt: CLOSE, releaseAt: MIDNIGHT,
};
const nextCollection = {
  ...firstCollection, cycleId: 'daily-2026-09-02', opensAt: CLOSE,
  closesAt: '2026-09-02T14:00:00.000Z', releaseAt: NEXT_MIDNIGHT,
};

async function fixture(context, { published = true } = {}) {
  const bundle = fixtureBundle();
  const raw = JSON.stringify(bundle);
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const state = {
    now: BEFORE_CLOSE, collection: firstCollection, nextReleaseAt: MIDNIGHT,
    bundleReads: 0, statusReads: 0, mutations: [], hold: false, waiting: [],
  };
  state.release = () => { state.hold = false; state.waiting.splice(0).forEach(resolve => resolve()); };
  await context.route('https://accounts.google.com/**', route => route.abort());
  await context.route('**/games/**', route => {
    state.bundleReads += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: raw });
  });
  await context.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') state.mutations.push(path);
    const reply = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/locale') return reply({ locale: 'en', source: 'default', supportedLocales: ['en', 'ko'] });
    if (path === '/api/session') return reply({ user: null, csrfToken: 'daily-fixture-csrf', googleNonce: 'daily-fixture-nonce' });
    if (path === '/api/status') {
      state.statusReads += 1;
      if (state.hold) await new Promise(resolve => state.waiting.push(resolve));
      return reply({
        serverTime: state.now, firstReleaseAt: '2026-08-31T15:00:00.000Z',
        nextReleaseAt: state.nextReleaseAt, collection: state.collection,
        limits: { bytes: 2000, submissions: 3, windowSeconds: 3600 },
        googleClientId: 'daily-fixture.apps.googleusercontent.com',
        game: published ? { published: true, version: bundle.config.gameVersion, sha256 } : { published: false },
        service: { mode: 'active', proposalsEnabled: true, developmentEnabled: true, message: '' },
      });
    }
    if (path === '/api/community') return reply({
      recent: [], popular: [], leaderboard: { items: [] },
      publicationPolicy: { version: 'public-default-v1', defaultPublic: true },
      round: { id: 'pending', status: 'open', closesAt: state.collection.closesAt, limit: 3 },
      scoring: { status: 'pending_confirmation', issuanceEnabled: false, policyVersion: null }, serverTime: state.now,
    });
    throw new Error(`Unexpected synthetic daily request: ${path}`);
  });
  return state;
}

async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.locator('.release-panel').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
}

async function saved(page) {
  return page.evaluate(async () => {
    const { createGameSaveStore } = await import('/game-save-store.js');
    const store = createGameSaveStore('fixture-v1');
    try { return await store.load(); } finally { store.close(); }
  });
}

for (const locale of ['en', 'ko']) {
  test(`${locale}: daily cutoff and midnight refresh preserve the actual game and unsent draft on mobile`, async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const state = await fixture(context);
    await page.clock.install({ time: new Date(BEFORE_CLOSE) });
    await page.goto(`/?lang=${locale}`);
    await expect(page.locator('#login-button')).toBeEnabled();
    await expect(page.locator('#live-game-frame')).toBeVisible();
    const frame = page.frameLocator('#live-game-frame');
    await expect(frame.locator('[data-hero="hero-a"]')).toBeVisible();
    await frame.locator('[data-hero="hero-a"]').click();
    await frame.getByRole('button', { name: locale === 'en' ? 'Begin expedition' : '원정 시작', exact: true }).click();
    await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'playing');
    const progress = await saved(page);
    await page.evaluate(() => { window.dailyFixtureFrame = document.getElementById('live-game-frame'); });
    const draft = 'Keep this unsent draft · 마감 이후에도 보존할 초안';
    await page.locator('#prompt').fill(draft);
    await expect(page.locator('#countdown')).toBeVisible();
    await expect(page.locator('#count-hours')).toHaveText('01');
    await expect(page.locator('#collection-deadline')).toContainText(locale === 'en' ? 'Sep 1, 2026 / 10:00 AM EDT' : '2026.09.01 / 23:00 KST');
    await expect(page.locator('#release-date-time')).toHaveAttribute('datetime', MIDNIGHT);
    await noOverflow(page);

    // Let the old snapshot expire while the server response is deliberately held.
    const beforeReads = state.statusReads;
    state.hold = true;
    state.now = CLOSE;
    await page.clock.fastForward(1100);
    await expect.poll(() => state.statusReads).toBeGreaterThan(beforeReads);
    await expect(page.locator('#collection-deadline')).toContainText(locale === 'en' ? 'Checking the next daily cycle' : '다음 일일 회차를 확인');
    await expect(page.locator('#prompt')).toHaveValue(draft);
    state.collection = nextCollection;
    state.release();
    await expect(page.locator('#collection-deadline')).toContainText(locale === 'en' ? 'Sep 2, 2026 / 10:00 AM EDT' : '2026.09.02 / 23:00 KST');
    await expect(page.locator('#release-date-time')).toHaveAttribute('datetime', MIDNIGHT);
    await expect(page.locator('#count-hours')).toHaveText('01');
    await noOverflow(page);

    // Midnight is a refresh trigger, not proof that a new game was published.
    state.hold = true;
    state.now = MIDNIGHT;
    await page.clock.fastForward(3_600_000);
    await expect(page.locator('#release-message')).toContainText(locale === 'en' ? 'Waiting for a verified release' : '검증된 새 공개를 기다리고');
    await expect(page.locator('#countdown')).toBeHidden();
    await expect(page.locator('#live-game-frame')).toBeVisible();
    state.nextReleaseAt = NEXT_MIDNIGHT;
    state.release();
    await expect(page.locator('#release-date-time')).toHaveAttribute('datetime', NEXT_MIDNIGHT);
    await expect(page.locator('#count-hours')).toHaveText('24');
    await expect(page.locator('#countdown')).toBeVisible();
    // Writing intentionally pauses play; neither calendar boundary resumes or resets it.
    await expect(frame.locator('#game')).toHaveAttribute('data-phase', 'paused');
    expect(await saved(page)).toEqual(progress);
    await expect(page.locator('#prompt')).toHaveValue(draft);
    expect(await page.evaluate(() => window.dailyFixtureFrame === document.getElementById('live-game-frame'))).toBe(true);
    expect(state.bundleReads).toBe(1);
    expect(state.mutations).toEqual([]);
    await noOverflow(page);
    const otherLocale = locale === 'en' ? 'ko' : 'en';
    await page.locator('#language-select').selectOption(otherLocale);
    await expect(frame.locator('html')).toHaveAttribute('lang', otherLocale);
    await expect(page.locator('#release-date-time')).toHaveAttribute('datetime', NEXT_MIDNIGHT);
    await expect(page.locator('#collection-deadline')).toContainText(otherLocale === 'en' ? 'Sep 2, 2026 / 10:00 AM EDT' : '2026.09.02 / 23:00 KST');
    await expect(page.locator('#prompt')).toHaveValue(draft);
    expect(await saved(page)).toEqual(progress);
    await page.setViewportSize({ width: 320, height: 740 });
    await noOverflow(page);
  });
}

test('daily dates do not fabricate a game when no verified game is available', async ({ page, context }) => {
  const state = await fixture(context, { published: false });
  await page.clock.install({ time: new Date(BEFORE_CLOSE) });
  await page.goto('/?lang=en');
  await expect(page.locator('#login-button')).toBeEnabled();
  await expect(page.locator('#countdown')).toBeVisible();
  await page.locator('#prompt').fill('No automatic send or publication');
  state.now = MIDNIGHT;
  state.collection = nextCollection;
  state.nextReleaseAt = NEXT_MIDNIGHT;
  await page.clock.fastForward(3_601_000);
  await expect(page.locator('#release-date-time')).toHaveAttribute('datetime', NEXT_MIDNIGHT);
  await expect(page.locator('#live-game-frame')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue('No automatic send or publication');
  expect(state.bundleReads).toBe(0);
  expect(state.mutations).toEqual([]);
});
