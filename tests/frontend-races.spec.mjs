import { test, expect } from '@playwright/test';

// These are browser regressions with a mocked API and synthetic identities.
// They do not verify Google signatures, a real shared session cookie, or Turso.
const START = Date.parse('2026-08-31T03:00:00.000Z');
const ALICE = { user: { id: 'race-alice', name: 'Review Alice' }, csrfToken: 'race-csrf-alice', googleNonce: 'race-nonce-alice' };
const BOB = { user: { id: 'race-bob', name: 'Review Bob' }, csrfToken: 'race-csrf-bob', googleNonce: 'race-nonce-bob' };
const ANONYMOUS = { user: null, csrfToken: 'race-csrf-anonymous', googleNonce: 'race-nonce-anonymous' };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function proposal(ownerId) {
  return {
    id: `proposal-${ownerId}`, body: ownerId === ALICE.user.id ? 'Alice private proposal' : 'Bob private proposal',
    createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    roundId: 'initial', revision: 1, editable: true,
  };
}

async function fixture(page) {
  const state = {
    session: structuredClone(ALICE), sessionCalls: 0, privateCalls: 0, posts: 0,
    holdSessions: null, holdNextSessionFailure: null,
  };
  await page.clock.install({ time: new Date(START) });
  await page.route('https://accounts.google.com/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/status') return reply({
      serverTime: new Date(START).toISOString(),
      collection: { id: 'initial', status: 'open', closesAt: '2026-08-31T14:00:00.000Z', initialClosed: false },
      firstReleaseAt: '2026-08-31T15:00:00.000Z', googleClientId: 'race-fixture.apps.googleusercontent.com',
      limits: { bytes: 2000, submissions: 3, windowSeconds: 3600 }, game: { published: false },
    });
    if (pathname === '/api/session') {
      state.sessionCalls += 1;
      const failedRead = state.holdNextSessionFailure;
      if (failedRead) {
        state.holdNextSessionFailure = null;
        failedRead.started.resolve();
        await failedRead.release.promise;
        return reply({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Stale mocked session read failed.' } }, 503);
      }
      if (state.holdSessions) {
        state.holdSessions.started.resolve();
        await state.holdSessions.release.promise;
      }
      return reply(state.session);
    }
    if (pathname === '/api/logout') {
      expect(request.headers()['x-csrf-token']).toBe(state.session.csrfToken);
      state.session = structuredClone(ANONYMOUS);
      return reply(state.session);
    }
    if (pathname === '/api/proposals' && request.method() === 'GET') {
      state.privateCalls += 1;
      const ownerId = state.session.user?.id;
      return reply({
        ownerId, proposals: ownerId ? [proposal(ownerId)] : [],
        quota: { remaining: ownerId === BOB.user.id ? 1 : 2, limit: 3, nextAvailableAt: null },
        serverTime: new Date(START).toISOString(),
      });
    }
    if (pathname === '/api/proposals') state.posts += 1;
    return reply({ error: { code: 'UNEXPECTED_REQUEST', message: 'Unexpected regression-fixture request.' } }, 400);
  });
  await page.goto('/');
  await expect(page.locator('#user-name')).toHaveText(ALICE.user.name);
  await expect(page.locator('#logout-button')).toBeEnabled();
  await expect(page.locator('.proposal-body')).toHaveText('Alice private proposal');
  return state;
}

test('a cookie identity change cannot display another account’s proposals under the previous identity', async ({ page }) => {
  const state = await fixture(page);
  const heldSession = { started: deferred(), release: deferred() };

  // Another tab may receive its login Set-Cookie before it sends AUTH_PULSE.
  // Model that server-side identity change without emitting a storage event.
  state.session = structuredClone(BOB);
  state.holdSessions = heldSession;
  try {
    await page.clock.fastForward(46_000);
    await expect.poll(() => state.sessionCalls).toBeGreaterThan(1);
    await heldSession.started.promise;
    await expect(page.locator('#proposal-list')).not.toContainText('Bob private proposal');

    state.holdSessions = null;
    heldSession.release.resolve();
    await expect(page.locator('#user-name')).toHaveText(BOB.user.name);
    await expect(page.locator('.proposal-body')).toHaveText('Bob private proposal');
    await expect(page.locator('#quota-status')).toContainText('1 / 3');
    expect(state.posts).toBe(0);
  } finally {
    state.holdSessions = null;
    heldSession.release.resolve();
  }
});

test('a session read that fails after logout cannot disable the newly ready anonymous session', async ({ page }) => {
  const state = await fixture(page);
  const staleRead = { started: deferred(), release: deferred() };
  state.holdNextSessionFailure = staleRead;
  await page.locator('#prompt').fill('로그아웃 후에도 보존할 새 제안');
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => state.sessionCalls).toBe(2);
    await staleRead.started.promise;

    await page.locator('#logout-button').click();
    await expect(page.locator('#form-message')).toContainText('로그아웃했어요');
    await expect(page.locator('#login-button')).toBeEnabled();

    const failureResponse = page.waitForResponse((response) => response.url().endsWith('/api/session') && response.status() === 503);
    staleRead.release.resolve();
    await (await failureResponse).finished();
    // The sync button becomes enabled only after the older synchronize() settles.
    await expect(page.locator('#retry-connection')).toBeEnabled();
    await expect(page.locator('#login-button')).toBeEnabled();
    await expect(page.locator('#connection-notice')).toBeHidden();
    await expect(page.locator('#prompt')).toHaveValue('로그아웃 후에도 보존할 새 제안');
    expect(state.posts).toBe(0);
  } finally { staleRead.release.resolve(); }
});
