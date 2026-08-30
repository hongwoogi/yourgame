import { test, expect } from '@playwright/test';

const START = Date.parse('2026-08-31T03:00:00Z');
const CUTOFF = '2026-08-31T14:00:00.000Z';
const RELEASE = '2026-08-31T15:00:00.000Z';
const anonymous = { user: null, csrfToken: 'anonymous-csrf', googleNonce: 'anonymous-nonce' };
const signedIn = { user: { id: 'browser-test-user', name: '테스트 참여자' }, csrfToken: 'signed-in-csrf', googleNonce: 'signed-in-nonce' };

async function fixture(page, options = {}) {
  const state = {
    session: structuredClone(anonymous),
    quota: { remaining: 3, limit: 3, nextAvailableAt: null },
    proposals: [], posts: [], patches: [], loginFailure: false, submissionFailure: false, privateFailure: false,
    serverTime: START, ...options,
  };
  await page.clock.install({ time: new Date(START) });
  await page.route('https://accounts.google.com/gsi/client*', async (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.google = { accounts: { id: {
      initialize(options) { window.testGoogleOptions = options; },
      renderButton(container) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = 'Google 테스트 로그인';
        button.addEventListener('click', () => window.testGoogleOptions.callback({credential:'browser-fixture-only'}));
        container.replaceChildren(button);
      },
      disableAutoSelect() {}, cancel() {}
    } } };`,
  }));
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/status') return reply({
      serverTime: new Date(state.serverTime).toISOString(),
      collection: { id: 'initial', status: 'open', closesAt: CUTOFF, releaseAt: RELEASE, initialClosed: false },
      firstReleaseAt: RELEASE, googleClientId: 'browser-fixture.apps.googleusercontent.com',
      limits: { bytes: 2000, submissions: 3, windowSeconds: 3600 }, game: { published: false },
    });
    if (pathname === '/api/session') return reply(state.session);
    if (pathname === '/api/login') {
      if (state.loginFailure) return reply({ error: { code: 'LOGIN_UNAVAILABLE', message: 'Google 로그인 연결에 실패했습니다. 다시 시도해 주세요.' } }, 503);
      expect(request.headers()['x-csrf-token']).toBe(state.session.csrfToken);
      state.session = structuredClone(signedIn);
      return reply(state.session);
    }
    if (pathname === '/api/logout') {
      state.session = structuredClone(anonymous);
      return reply(state.session);
    }
    if (pathname === '/api/proposals' && request.method() === 'GET') {
      if (state.privateFailure) return reply({ error: { code: 'SERVICE_UNAVAILABLE', message: '제안 목록을 확인할 수 없습니다.' } }, 503);
      return reply({ ownerId: state.session.user?.id || null, proposals: state.proposals, quota: state.quota, serverTime: new Date(state.serverTime).toISOString() });
    }
    if (pathname === '/api/proposals' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      state.posts.push(payload);
      expect(request.headers()['x-csrf-token']).toBe(signedIn.csrfToken);
      if (state.submissionFailure) return reply({ error: { code: 'SERVICE_UNAVAILABLE', message: '저장에 실패했습니다. 입력 내용은 유지됩니다.' } }, 503);
      if (state.quota.remaining === 0) return reply({ error: { code: 'QUOTA_EXCEEDED', message: '제출 가능 횟수를 모두 사용했습니다.' }, quota: state.quota }, 429);
      const existing = state.proposals.find((p) => p.requestId === payload.requestId);
      if (existing) return reply({ proposal: existing, quota: state.quota });
      const proposal = { id: `proposal-${state.proposals.length + 1}`, requestId: payload.requestId,
        body: payload.body, createdAt: new Date(state.serverTime).toISOString(), updatedAt: new Date(state.serverTime).toISOString(),
        roundId: 'initial', revision: 1, editable: true };
      state.proposals.unshift(proposal);
      state.quota = { ...state.quota, remaining: state.quota.remaining - 1,
        nextAvailableAt: new Date(state.serverTime + 3600000).toISOString() };
      return reply({ proposal, quota: state.quota }, 201);
    }
    if (pathname === '/api/proposals' && request.method() === 'PATCH') {
      const payload = request.postDataJSON();
      state.patches.push(payload);
      expect(request.headers()['x-csrf-token']).toBe(signedIn.csrfToken);
      const proposal = state.proposals.find((p) => p.id === payload.id);
      if (!proposal?.editable) return reply({ error: { code: 'PROPOSAL_FROZEN', message: '마감된 제안은 수정할 수 없습니다.' } }, 409);
      if (payload.revision !== proposal.revision) return reply({ error: { code: 'REVISION_CONFLICT', message: '다른 창에서 제안이 변경되었습니다.' } }, 409);
      Object.assign(proposal, { body: payload.body, revision: proposal.revision + 1 });
      return reply({ proposal, quota: state.quota });
    }
    return reply({ error: { code: 'NOT_FOUND', message: 'Unknown fixture endpoint' } }, 404);
  });
  await page.goto('/');
  await expect(page.locator(state.session.user ? '#logout-button' : '#login-button')).toBeEnabled();
  return state;
}

async function googleLogin(page) {
  await expect(page.locator('#login-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Google 테스트 로그인' }).click();
}

test('desktop entry renders and measures UTF-8 bytes without truncating the draft', async ({ page }) => {
  await fixture(page);
  await expect(page.locator('body')).toHaveAttribute('data-app', 'yourgame');
  await expect(page.locator('#hero-title')).toBeVisible();
  await expect(page.locator('#collection-label')).toContainText('모집');
  await page.locator('#prompt').fill('가'.repeat(667));
  await expect(page.locator('#byte-count')).toContainText('2,001');
  await expect(page.locator('#submit-button')).toBeDisabled();
  await expect(page.locator('#prompt')).toHaveValue('가'.repeat(667));
  await page.locator('#prompt').fill('가'.repeat(666) + 'ab');
  await expect(page.locator('#byte-count')).toContainText('2,000');
  await expect(page.locator('#submit-button')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('anonymous Send opens login then submits exactly once with the rotated CSRF token', async ({ page }) => {
  const state = await fixture(page);
  await page.locator('#prompt').fill('서로 다른 능력의 무기를 주워서 조합하고 싶어요.');
  await page.locator('#submit-button').click();
  await googleLogin(page);
  await expect(page.locator('#prompt')).toHaveValue('');
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].requestId).toBeTruthy();
  await expect(page.locator('#my-proposals')).toBeVisible();
});

test('header login keeps a draft and never implies Send', async ({ page }) => {
  const state = await fixture(page);
  await page.locator('#prompt').fill('로그인만 하고 아직 전송하지 않을 내용');
  await page.locator('#login-button').click();
  await googleLogin(page);
  await expect(page.locator('#logout-button')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('로그인만 하고 아직 전송하지 않을 내용');
  expect(state.posts).toHaveLength(0);
});

test('zero quota after login preserves the draft, including after capacity returns and reload', async ({ page }) => {
  const state = await fixture(page, { quota: { remaining: 0, limit: 3, nextAvailableAt: new Date(START + 30000).toISOString() } });
  await page.locator('#prompt').fill('횟수가 돌아와도 내가 다시 전송할 제안');
  await page.locator('#submit-button').click();
  await googleLogin(page);
  await expect(page.locator('#logout-button')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('횟수가 돌아와도 내가 다시 전송할 제안');
  expect(state.posts).toHaveLength(0);
  state.serverTime += 65000;
  state.quota = { remaining: 3, limit: 3, nextAvailableAt: null };
  await page.clock.fastForward(65000);
  await page.reload();
  await expect(page.locator('#prompt')).toHaveValue('횟수가 돌아와도 내가 다시 전송할 제안');
  await expect(page.locator('#logout-button')).toBeVisible();
  expect(state.posts).toHaveLength(0);
});

test('login and submission failures retain the original draft', async ({ page }) => {
  const state = await fixture(page, { loginFailure: true });
  await page.locator('#prompt').fill('오류가 나더라도 보존해야 하는 내용');
  await page.locator('#submit-button').click();
  await googleLogin(page);
  await expect(page.locator('#login-message')).toContainText('실패');
  await expect(page.locator('#prompt')).toHaveValue('오류가 나더라도 보존해야 하는 내용');
  state.loginFailure = false;
  state.submissionFailure = true;
  await page.locator('#retry-google').click();
  await page.getByRole('button', { name: 'Google 테스트 로그인' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(page.locator('#form-message')).toContainText('실패');
  await expect(page.locator('#prompt')).toHaveValue('오류가 나더라도 보존해야 하는 내용');
  state.submissionFailure = false;
  await page.locator('#submit-button').click();
  await expect(page.locator('#prompt')).toHaveValue('');
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0].requestId).toBe(state.posts[1].requestId);
  expect(state.proposals).toHaveLength(1);
});

test('editing is available at zero quota and does not become a new submission', async ({ page }) => {
  const original = { id: 'existing-one', body: '원래 제안', createdAt: new Date(START - 1000).toISOString(),
    updatedAt: new Date(START - 1000).toISOString(), roundId: 'initial', revision: 1, editable: true };
  const state = await fixture(page, { session: structuredClone(signedIn), proposals: [original],
    quota: { remaining: 0, limit: 3, nextAvailableAt: new Date(START + 3600000).toISOString() } });
  await page.locator('#my-proposals summary').click();
  await page.locator('#proposal-list').getByRole('button', { name: /수정/ }).click();
  await page.locator('#prompt').fill('수정된 제안');
  await page.locator('#submit-button').click();
  await expect.poll(() => state.patches.length).toBe(1);
  expect(state.posts).toHaveLength(0);
  expect(state.patches[0]).toMatchObject({ id: 'existing-one', body: '수정된 제안', revision: 1 });
  expect(state.quota.remaining).toBe(0);
  expect(state.proposals[0].createdAt).toBe(original.createdAt);
});

test('narrow screens give the declared PC-only notice', async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.desktop-notice')).toBeVisible();
  await expect(page.locator('.desktop-app')).toBeHidden();
});

test('closing a Send login modal cancels auto-send before a later header login', async ({ page }) => {
  const state = await fixture(page);
  await page.locator('#prompt').fill('로그인 취소 뒤에는 전송하지 않을 내용');
  await page.locator('#submit-button').click();
  await expect(page.locator('#login-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#login-dialog')).toBeHidden();
  await page.locator('#login-button').click();
  await googleLogin(page);
  await expect(page.locator('#logout-button')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('로그인 취소 뒤에는 전송하지 않을 내용');
  expect(state.posts).toHaveLength(0);
});

test('logout removes private proposals while preserving the unsubmitted new draft', async ({ page }) => {
  await fixture(page, { session: structuredClone(signedIn), proposals: [{
    id: 'private-one', body: '로그인한 사용자에게만 보이는 제안', createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(), roundId: 'initial', revision: 1, editable: true,
  }] });
  await page.locator('#my-proposals summary').click();
  await expect(page.locator('#proposal-list')).toContainText('로그인한 사용자에게만 보이는 제안');
  await page.locator('#prompt').fill('아직 제출하지 않은 새 초안');
  await page.locator('#logout-button').click();
  await expect(page.locator('#login-button')).toBeVisible();
  await expect(page.locator('#proposal-list')).toBeEmpty();
  await expect(page.locator('#my-proposals')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('아직 제출하지 않은 새 초안');
});

test('a concurrent edit conflict retains the local edit and never creates a new proposal', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(signedIn), proposals: [{
    id: 'conflicted-one', body: '처음 저장한 제안', createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(), roundId: 'initial', revision: 1, editable: true,
  }] });
  await page.locator('#my-proposals summary').click();
  await page.locator('#proposal-list').getByRole('button', { name: /수정/ }).click();
  await page.locator('#prompt').fill('이 창에서 수정 중인 내용');
  Object.assign(state.proposals[0], { body: '다른 창에서 먼저 저장한 내용', revision: 2 });
  await page.locator('#submit-button').click();
  await expect(page.locator('#form-feedback')).toHaveAttribute('data-kind', 'error');
  await expect(page.locator('#prompt')).toHaveValue('이 창에서 수정 중인 내용');
  await expect(page.locator('#reload-edit')).toBeVisible();
  await expect(page.locator('#copy-edit')).toBeVisible();
  expect(state.posts).toHaveLength(0);
  expect(state.proposals[0].body).toBe('다른 창에서 먼저 저장한 내용');
});

test('temporary private-list failure locks submission without replacing an in-progress edit', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(signedIn), proposals: [{
    id: 'interrupted-edit', body: '원래 접수한 내용', createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(), roundId: 'initial', revision: 1, editable: true,
  }] });
  await page.locator('#my-proposals summary').click();
  await page.locator('#proposal-list').getByRole('button', { name: /수정/ }).click();
  await page.locator('#prompt').fill('조회 장애 중에도 계속 보존할 수정 초안');
  state.privateFailure = true;
  await page.clock.fastForward(46000);
  await expect(page.locator('#connection-notice')).toBeVisible();
  await expect(page.locator('#submit-button')).toBeDisabled();
  await expect(page.locator('#prompt')).toHaveValue('조회 장애 중에도 계속 보존할 수정 초안');
  state.privateFailure = false;
  await page.locator('#retry-connection').click();
  await expect(page.locator('#connection-notice')).toBeHidden();
  await expect(page.locator('#submit-button')).toBeEnabled();
  await expect(page.locator('#prompt')).toHaveValue('조회 장애 중에도 계속 보존할 수정 초안');
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(0);
});
