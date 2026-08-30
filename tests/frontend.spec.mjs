import { test, expect } from '@playwright/test';

// Browser behavior only: API responses, Google identity and button width are mocked.
// Real OAuth signatures, administrator authorization and database writes are covered separately.
const START = Date.parse('2026-08-31T03:00:00Z');
const CUTOFF = '2026-08-31T14:00:00.000Z';
const RELEASE = '2026-08-31T15:00:00.000Z';
const anonymous = { user: null, csrfToken: 'anonymous-csrf', googleNonce: 'anonymous-nonce' };
const signedIn = { user: { id: 'browser-test-user', name: '테스트 참여자' }, csrfToken: 'signed-in-csrf', googleNonce: 'signed-in-nonce' };
const administrator = { user: { id: 'browser-admin', name: '테스트 관리자', isAdmin: true }, csrfToken: 'admin-csrf', googleNonce: 'admin-nonce' };
const activeService = { mode: 'active', proposalsEnabled: true, developmentEnabled: true, message: '' };

function savedProposal(id = 'existing-proposal') {
  return { id, body: '원래 접수한 제안', createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(), roundId: 'initial', revision: 1, editable: true,
    safety: { status: 'pending', message: '안전 검토 대기' } };
}

async function fixture(page, options = {}) {
  const state = {
    session: structuredClone(anonymous),
    quota: { remaining: 3, limit: 3, nextAvailableAt: null },
    proposals: [], posts: [], patches: [], loginCalls: 0, adminVisits: 0, statusCalls: 0, languages: [],
    localeResponse: { locale: 'ko', source: 'country' },
    loginFailure: false, submissionFailure: false, privateFailure: false, statusFailure: false, safetyRejection: false,
    serverTime: START, ...options,
  };
  await page.clock.install({ time: new Date(START) });
  await page.route('https://accounts.google.com/gsi/client*', async (route) => route.fulfill({
    contentType: 'text/javascript',
    body: `window.google = { accounts: { id: {
      initialize(options) { window.testGoogleOptions = options; window.testGoogleInitializations = (window.testGoogleInitializations || 0) + 1; },
      renderButton(container, options) {
        window.testGoogleButtonOptions = options;
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = options.locale === 'en' ? 'Continue with Google (test)' : 'Google 테스트 로그인';
        button.style.width = options.width + 'px'; button.style.minHeight = '44px'; button.style.flexShrink = '0';
        button.addEventListener('click', () => window.testGoogleOptions.callback({credential:'browser-fixture-only'}));
        container.replaceChildren(button);
      },
      disableAutoSelect() {}, cancel() {}
    } } };`,
  }));
  await page.route('**/admin', (route) => {
    state.adminVisits += 1;
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Mock admin destination</title><h1>관리자 도착 테스트</h1>' });
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const reply = (body, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (pathname === '/api/locale') {
      if (state.localeFailure) return route.abort('failed');
      if (state.localeGate) await state.localeGate;
      return reply(state.localeResponse);
    }
    state.languages.push({ pathname, method: request.method(), value: request.headers()['x-yourgame-language'] });
    const operationCode = () => state.serviceRejection?.code || (state.service?.mode === 'ended' ? 'SERVICE_ENDED'
      : state.service?.mode === 'maintenance' ? 'SERVICE_MAINTENANCE'
        : state.service?.proposalsEnabled === false ? 'PROPOSALS_PAUSED' : null);
    if (pathname === '/api/status') {
      state.statusCalls += 1;
      if (state.statusFailure) return reply({ error: { code: 'SERVICE_UNAVAILABLE', message: '운영 상태를 확인할 수 없습니다.' } }, 503);
      return reply({
        serverTime: new Date(state.serverTime).toISOString(),
        collection: { id: 'initial', status: state.collectionStatus || (state.service?.mode === 'ended' ? 'ended'
          : operationCode() ? 'paused' : 'open'), closesAt: CUTOFF, releaseAt: RELEASE, initialClosed: false },
        firstReleaseAt: RELEASE, googleClientId: 'browser-fixture.apps.googleusercontent.com',
        limits: { bytes: 2000, submissions: 3, windowSeconds: 3600 }, game: { published: state.published === true },
        ...(state.service !== undefined ? { service: state.service } : {}),
      });
    }
    if (pathname === '/api/community' && new URL(request.url()).searchParams.get('view') === 'me') {
      return reply({ ownerId: state.session.user?.id || null,
        profile: { id: 'public-browser-profile', alias: 'Player-000000000001', leaderboardVisible: false, revision: 1 },
        contribution: { points: '0', adoptedCount: 0 },
        voteQuota: { roundId: 'initial', limit: 3, used: 0, remaining: 3, closesAt: CUTOFF },
        votes: [], publications: [] });
    }
    if (pathname === '/api/community') return reply({ recent: [], popular: [], leaderboard: { items: [] },
      round: { id: 'initial', status: 'open', closesAt: CUTOFF, limit: 3 },
      scoring: { status: 'pending_confirmation', issuanceEnabled: false, policyVersion: null },
      serverTime: new Date(state.serverTime).toISOString() });
    if (pathname === '/api/session') return reply(state.session);
    if (pathname === '/api/login') {
      state.loginCalls += 1;
      if (state.loginGate) await state.loginGate;
      if (state.loginFailure) return reply({ error: { code: 'LOGIN_UNAVAILABLE', message: 'Google 로그인 연결에 실패했습니다. 다시 시도해 주세요.' } }, 503);
      expect(request.headers()['x-csrf-token']).toBe(state.session.csrfToken);
      state.session = structuredClone(state.loginSession || signedIn);
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
      expect(request.headers()['x-csrf-token']).toBe(state.session.csrfToken);
      if (state.safetyRejection) return reply({ error: { code: 'PROPOSAL_SAFETY_REJECTED', message: 'PRIVATE_FILTER_EVIDENCE_DO_NOT_DISPLAY' } }, 422);
      if (state.attemptRejection) return reply({ error: { code: state.attemptRejection, message: 'PRIVATE_RATE_LIMIT_EVIDENCE' } }, 429, { 'Retry-After': '3' });
      if (operationCode() || state.serviceRejection) return reply({ error: { code: operationCode(), message: '운영 정책으로 제안 접수가 중지되었습니다.' } }, state.serviceRejection?.status || 409);
      if (state.submissionFailure) return reply({ error: { code: 'SERVICE_UNAVAILABLE', message: '저장에 실패했습니다. 입력 내용은 유지됩니다.' } }, 503);
      if (state.quota.remaining === 0) return reply({ error: { code: 'QUOTA_EXCEEDED', message: '제출 가능 횟수를 모두 사용했습니다.' }, quota: state.quota }, 429);
      const existing = state.proposals.find((p) => p.requestId === payload.requestId);
      if (existing) return reply({ proposal: existing, quota: state.quota });
      const proposal = { id: `proposal-${state.proposals.length + 1}`, requestId: payload.requestId,
        body: payload.body, createdAt: new Date(state.serverTime).toISOString(), updatedAt: new Date(state.serverTime).toISOString(),
        roundId: 'initial', revision: 1, editable: true, safety: { status: 'pending', message: '안전 검토 대기' } };
      state.proposals.unshift(proposal);
      state.quota = { ...state.quota, remaining: state.quota.remaining - 1,
        nextAvailableAt: new Date(state.serverTime + 3600000).toISOString() };
      return reply({ proposal, quota: state.quota }, 201);
    }
    if (pathname === '/api/proposals' && request.method() === 'PATCH') {
      const payload = request.postDataJSON();
      state.patches.push(payload);
      expect(request.headers()['x-csrf-token']).toBe(state.session.csrfToken);
      if (state.safetyRejection) return reply({ error: { code: 'PROPOSAL_SAFETY_REJECTED', message: 'PRIVATE_FILTER_EVIDENCE_DO_NOT_DISPLAY' } }, 422);
      if (state.attemptRejection) return reply({ error: { code: state.attemptRejection, message: 'PRIVATE_RATE_LIMIT_EVIDENCE' } }, 429, { 'Retry-After': '3' });
      if (operationCode() || state.serviceRejection) return reply({ error: { code: operationCode(), message: '운영 정책으로 제안 접수가 중지되었습니다.' } }, state.serviceRejection?.status || 409);
      const proposal = state.proposals.find((p) => p.id === payload.id);
      if (!proposal?.editable) return reply({ error: { code: 'PROPOSAL_FROZEN', message: '마감된 제안은 수정할 수 없습니다.' } }, 409);
      if (payload.revision !== proposal.revision) return reply({ error: { code: 'REVISION_CONFLICT', message: '다른 창에서 제안이 변경되었습니다.' } }, 409);
      Object.assign(proposal, { body: payload.body, revision: proposal.revision + 1, safety: { status: 'pending', message: '안전 검토 대기' } });
      return reply({ proposal, quota: state.quota });
    }
    return reply({ error: { code: 'NOT_FOUND', message: 'Unknown fixture endpoint' } }, 404);
  });
  const entry = new URL(options.path || '/', 'http://localhost:3000');
  if (options.locale !== null && !entry.searchParams.has('lang')) entry.searchParams.set('lang', options.locale || 'ko');
  await page.goto(entry.pathname + entry.search + entry.hash);
  if (options.expectAdminNavigation) await expect(page).toHaveURL('http://localhost:3000/admin');
  else await expect(page.locator(state.session.user ? '#logout-button' : '#login-button')).toBeEnabled();
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

test('accepted proposals consume one slot while safety review and an edited revision stay pending', async ({ page }, testInfo) => {
  const state = await fixture(page, { session: structuredClone(signedIn) });
  await expect(page.locator('#prompt-safety-note')).toContainText('검토 대기 중에도 제출 횟수 1회');
  await page.locator('#safety-guidance summary').click();
  await expect(page.locator('#safety-guidance')).toContainText('공식 등급을 취득했다는 뜻은 아닙니다');
  await expect(page.locator('#safety-guidance')).toContainText('일반적인 판타지 전투 요구');
  await page.locator('#prompt-form').screenshot({ path: testInfo.outputPath('public-safety-form-desktop.png') });
  await page.locator('#prompt').fill('회피 동작을 더 쉽게 조작하고 싶어요.');
  await page.locator('#submit-button').click();
  await expect(page.locator('#form-message')).toContainText('안전 검토 대기');
  await expect(page.locator('#quota-status')).toContainText('2 / 3');
  await expect(page.locator('.proposal-safety')).toHaveAttribute('data-status', 'pending');
  state.proposals[0].safety = { status: 'approved', message: 'PRIVATE_REVIEW_REASON' };
  await page.reload();
  await page.locator('#my-proposals summary').click();
  await expect(page.locator('.proposal-safety')).toContainText('안전 승인');
  await page.locator('.proposal-edit').click();
  await page.locator('#prompt').fill('회피 동작의 터치 버튼 위치를 바꾸고 싶어요.');
  await page.locator('#submit-button').click();
  await expect(page.locator('.proposal-safety')).toHaveAttribute('data-status', 'pending');
  await expect(page.locator('#quota-status')).toContainText('2 / 3');
  expect(state.proposals[0].revision).toBe(2);
  expect(state.posts).toHaveLength(1);
  expect(state.patches).toHaveLength(1);
  await expect(page.locator('body')).not.toContainText('PRIVATE_REVIEW_REASON');
});

test('safety rejection keeps the new draft and quota without revealing internal evidence', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(signedIn), safetyRejection: true });
  const draft = '이 입력은 서버의 안전 기준 검사에서 거절하는 테스트 초안입니다.';
  await page.locator('#prompt').fill(draft);
  await page.locator('#submit-button').click();
  await expect(page.locator('#form-message')).toContainText('제출 횟수는 차감되지 않았어요');
  await expect(page.locator('#form-feedback')).toHaveAttribute('data-reason', 'safety');
  await expect(page.locator('#quota-status')).toContainText('3 / 3');
  await expect(page.locator('#prompt')).toHaveValue(draft);
  await expect(page.locator('body')).not.toContainText('PRIVATE_FILTER_EVIDENCE');
  expect(state.proposals).toHaveLength(0);
  expect(state.posts).toHaveLength(1);
  await page.reload();
  await expect(page.locator('#prompt')).toHaveValue(draft);
  await expect(page.locator('#quota-status')).toContainText('3 / 3');
  expect(state.posts).toHaveLength(1);
});

test('rejected edits retain the edit draft and the previously approved stored revision at zero quota', async ({ page }) => {
  const proposal = { ...savedProposal(), safety: { status: 'approved', message: 'PRIVATE_REVIEW_REASON' } };
  const state = await fixture(page, { session: structuredClone(signedIn), safetyRejection: true, proposals: [proposal],
    quota: { remaining: 0, limit: 3, nextAvailableAt: new Date(START + 3600000).toISOString() } });
  await page.locator('#my-proposals summary').click();
  await page.locator('.proposal-edit').click();
  const draft = '저장되지 않아야 하는 수정 테스트 초안';
  await page.locator('#prompt').fill(draft);
  await page.locator('#submit-button').click();
  await expect(page.locator('#form-message')).toContainText('수정본을 저장하지 않았어요');
  await expect(page.locator('#prompt')).toHaveValue(draft);
  await expect(page.locator('.proposal-safety')).toHaveAttribute('data-status', 'approved');
  expect(state.proposals[0].body).toBe('원래 접수한 제안');
  expect(state.proposals[0].revision).toBe(1);
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(1);
  await page.reload();
  await expect(page.locator('#prompt')).toHaveValue(draft);
  await expect(page.locator('#edit-banner')).toBeVisible();
  await expect(page.locator('#quota-status')).toContainText('0 / 3');
});

test('private review states use safe labels and do not render supplied review messages or markup', async ({ page }) => {
  const proposals = ['pending', 'approved', 'held', 'blocked'].map((status) => ({
    ...savedProposal(`safety-${status}`), body: `${status}: <img src=x onerror="window.__safetyXss=true">`,
    safety: { status, message: `PRIVATE_REVIEW_REASON_${status}`, reason: 'PRIVATE_INTERNAL_REASON' },
  }));
  await fixture(page, { session: structuredClone(signedIn), proposals });
  await page.locator('#my-proposals summary').click();
  for (const [status, label] of Object.entries({ pending: '안전 검토 대기', approved: '안전 승인', held: '안전 검토 보류', blocked: '안전 기준 차단' })) {
    await expect(page.locator(`.proposal-safety[data-status="${status}"]`)).toContainText(label);
  }
  await expect(page.locator('body')).not.toContainText('PRIVATE_REVIEW_REASON');
  await expect(page.locator('body')).not.toContainText('PRIVATE_INTERNAL_REASON');
  await expect(page.locator('#proposal-list img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__safetyXss)).toBeUndefined();
});

for (const code of ['EDIT_RATE_LIMITED', 'PROPOSAL_ATTEMPT_RATE_LIMITED']) {
  test(`${code} preserves an edit and does not masquerade as exhausted submission quota`, async ({ page }) => {
    const state = await fixture(page, { session: structuredClone(signedIn), proposals: [savedProposal()], attemptRejection: code });
    await page.locator('#my-proposals summary').click();
    await page.locator('.proposal-edit').click();
    await page.locator('#prompt').fill('잠시 후 직접 다시 저장할 수정 초안');
    await page.locator('#submit-button').click();
    await expect(page.locator('#form-message')).toContainText('3초 후');
    await expect(page.locator('#form-feedback')).not.toHaveAttribute('data-reason', 'quota');
    await expect(page.locator('#prompt')).toHaveValue('잠시 후 직접 다시 저장할 수정 초안');
    await expect(page.locator('#quota-status')).toContainText('3 / 3');
    await expect(page.locator('body')).not.toContainText('PRIVATE_RATE_LIMIT_EVIDENCE');
    expect(state.posts).toHaveLength(0);
    expect(state.patches).toHaveLength(1);
  });
}

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
  await expect(page.locator('#login-message')).toContainText('Google 로그인 연결을 확인할 수 없습니다');
  await expect(page.locator('#prompt')).toHaveValue('오류가 나더라도 보존해야 하는 내용');
  state.loginFailure = false;
  state.submissionFailure = true;
  await page.locator('#retry-google').click();
  await page.getByRole('button', { name: 'Google 테스트 로그인' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(page.locator('#form-message')).toContainText('잠시 서비스를 이용할 수 없습니다');
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

for (const width of [360, 390]) {
  test(`mobile ${width}px supports byte limits, Google auto-submit and editing without horizontal overflow`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const state = await fixture(page);
    await expect(page.locator('#hero-title')).toBeVisible();
    await expect(page.locator('#countdown')).toBeVisible();
    await expect(page.locator('.hero-description')).toContainText('PC·모바일');
    expect(await page.locator('#prompt').evaluate((element) => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    const steps = await page.locator('.process-step').evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, bottom: rect.bottom };
    }));
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index].x).toBe(steps[0].x);
      expect(steps[index].y).toBeGreaterThan(steps[index - 1].bottom);
    }
    await page.locator('#prompt').fill('가'.repeat(667));
    await expect(page.locator('#byte-count')).toContainText('2,001');
    await expect(page.locator('#submit-button')).toBeDisabled();
    await expect(page.locator('#prompt')).toHaveValue('가'.repeat(667));
    await page.locator('#prompt').fill('가'.repeat(666) + 'ab');
    await expect(page.locator('#byte-count')).toContainText('2,000');
    await page.locator('#submit-button').click();
    const googleButton = page.getByRole('button', { name: 'Google 테스트 로그인' });
    await expect(googleButton).toBeVisible();
    for (const element of [page.locator('#login-dialog'), googleButton]) {
      const bounds = await element.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    }
    expect(await page.locator('#login-dialog').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await googleLogin(page);
    await expect.poll(() => state.posts.length).toBe(1);
    await expect(page.locator('#prompt')).toHaveValue('');
    await page.locator('#proposal-list').getByRole('button', { name: /수정/ }).click();
    await page.locator('#prompt').fill('모바일에서도 터치로 수정하는 제안');
    await page.locator('#submit-button').click();
    await expect.poll(() => state.patches.length).toBe(1);
    expect(state.posts).toHaveLength(1);
    expect(state.patches[0].body).toBe('모바일에서도 터치로 수정하는 제안');
    await page.locator('#safety-guidance summary').click();
    await page.locator('#prompt-form').screenshot({ path: testInfo.outputPath(`public-safety-form-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('IME composition and a mobile orientation change retain the draft and explicit Send intent', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await page.locator('#prompt').fill('모바일 한글 조합 중인 초안');
  await page.locator('#prompt').dispatchEvent('compositionstart', { data: '안' });
  await page.locator('#prompt-form').dispatchEvent('submit');
  await expect(page.locator('#submit-button')).toBeDisabled();
  await expect(page.locator('#login-dialog')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('모바일 한글 조합 중인 초안');
  await page.locator('#prompt').dispatchEvent('compositionend', { data: '안' });
  await page.locator('#submit-button').click();
  await expect(page.getByRole('button', { name: 'Google 테스트 로그인' })).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('#login-dialog')).toBeVisible();
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(page.locator('#login-dialog')).toBeVisible();
  expect(await page.locator('#login-dialog').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await googleLogin(page);
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].body).toBe('모바일 한글 조합 중인 초안');
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

test('only the server boolean admin flag reveals the fixed admin link, including on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const state = await fixture(page, { session: { ...structuredClone(administrator), user: { ...administrator.user, name: '아주 긴 이름을 사용하는 관리자 참여자', isAdmin: 'true' } } });
  await expect(page.locator('#admin-link')).toBeHidden();
  state.session.user.isAdmin = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#admin-link')).toBeVisible();
  await expect(page.locator('#admin-link')).toHaveAttribute('href', '/admin');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#logout-button').click();
  await expect(page.locator('#admin-link')).toBeHidden();
});

test('admin entry clears pending Send, preserves the draft and ignores external redirect parameters', async ({ page }) => {
  const draft = '관리자 로그인에서는 전송하면 안 되는 제안';
  await page.addInitScript(({ draft, started }) => {
    if (location.pathname !== '/' || sessionStorage.getItem('admin-entry-seeded')) return;
    sessionStorage.setItem('admin-entry-seeded', '1');
    localStorage.setItem('yourgame.draft.v1', draft);
    sessionStorage.setItem('yourgame.pending.v1', JSON.stringify({ body: draft, requestId: 'admin-entry-test', createdAt: started }));
  }, { draft, started: START });
  const state = await fixture(page, { path: '/?admin=1&redirect=https://example.invalid/', loginSession: structuredClone(administrator) });
  await expect(page.locator('#login-title')).toHaveText('관리자 로그인');
  await expect(page.locator('#login-draft-note')).toContainText('전송되지는');
  expect(await page.evaluate(() => sessionStorage.getItem('yourgame.pending.v1'))).toBeNull();
  await googleLogin(page);
  await expect(page).toHaveURL('http://localhost:3000/admin');
  expect(state.adminVisits).toBe(1);
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.getItem('yourgame.draft.v1'))).toBe(draft);
});

test('an already authenticated admin can enter despite public status and proposal read failures', async ({ page }) => {
  const state = await fixture(page, { path: '/?admin=1', session: structuredClone(administrator),
    statusFailure: true, privateFailure: true, expectAdminNavigation: true });
  expect(state.adminVisits).toBe(1);
  expect(state.loginCalls).toBe(0);
  expect(state.posts).toHaveLength(0);
});

test('admin reauthentication requires a successful new login and does not trust the old admin session after failure', async ({ page }) => {
  const state = await fixture(page, { path: '/?admin=1&reauth=1', session: structuredClone(administrator),
    loginSession: { ...structuredClone(administrator), csrfToken: 'fresh-admin-csrf', googleNonce: 'fresh-admin-nonce' }, loginFailure: true });
  await expect(page.locator('#login-dialog')).toBeVisible();
  expect(state.loginCalls).toBe(0);
  await googleLogin(page);
  await expect(page.locator('#login-message')).toContainText('Google 로그인 연결을 확인할 수 없습니다');
  await expect(page.locator('#login-dialog')).toBeVisible();
  expect(state.adminVisits).toBe(0);
  state.loginFailure = false;
  await page.locator('#retry-google').click();
  await googleLogin(page);
  await expect(page).toHaveURL('http://localhost:3000/admin');
  expect(state.loginCalls).toBe(2);
  expect(state.adminVisits).toBe(1);
  expect(state.posts).toHaveLength(0);
});

test('an ordinary account completing admin login stays on the public page without submitting or looping', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('yourgame.draft.v1', '권한이 없어도 보존할 초안'));
  const state = await fixture(page, { path: '/?admin=1&reauth=1' });
  await googleLogin(page);
  await expect(page.locator('#login-dialog')).toBeHidden();
  await expect(page.locator('#form-message')).toContainText('관리자 권한이 없어요');
  await expect(page.locator('#prompt')).toHaveValue('권한이 없어도 보존할 초안');
  await expect(page).toHaveURL('http://localhost:3000/?lang=ko');
  await page.clock.fastForward(46_000);
  await page.reload();
  await expect(page.locator('#logout-button')).toBeVisible();
  await expect(page.locator('#login-dialog')).toBeHidden();
  expect(state.adminVisits).toBe(0);
  expect(state.loginCalls).toBe(1);
  expect(state.posts).toHaveLength(0);
});

test('canceling admin reauthentication consumes the entry flags and keeps existing drafts', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('yourgame.draft.v1', '재인증 취소 후 남길 초안'));
  const state = await fixture(page, { path: '/?admin=1&reauth=1', session: structuredClone(administrator) });
  await expect(page.locator('#login-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#login-dialog')).toBeHidden();
  await page.reload();
  await expect(page.locator('#admin-link')).toBeVisible();
  await expect(page.locator('#login-dialog')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('재인증 취소 후 남길 초안');
  expect(state.adminVisits).toBe(0);
  expect(state.loginCalls).toBe(0);
  expect(state.posts).toHaveLength(0);
});

for (const [name, service] of [
  ['maintenance', { ...activeService, mode: 'maintenance' }],
  ['ended', { ...activeService, mode: 'ended' }],
  ['proposals paused', { ...activeService, proposalsEnabled: false }],
]) {
  test(`${name} preserves new/edit drafts and history while blocking all submission paths`, async ({ page }) => {
    const state = await fixture(page, { session: structuredClone(administrator), proposals: [savedProposal()],
      service: { ...service, message: '운영 안내 <img src=x onerror="window.unsafeAnnouncement=true">' }, published: name === 'ended' });
    await expect(page.locator('#service-notice')).toBeVisible();
    await expect(page.locator('#service-message')).toContainText('<img');
    await expect(page.locator('#service-message img')).toHaveCount(0);
    await expect(page.locator('#admin-link')).toBeVisible();
    await expect(page.locator('#my-proposals')).toBeVisible();
    await page.locator('#prompt').fill('운영 중지 중에 작성하는 새 초안');
    await expect(page.locator('#prompt')).toBeEnabled();
    await expect(page.locator('#submit-button')).toBeDisabled();
    await page.locator('#prompt-form').dispatchEvent('submit');
    await expect(page.locator('#form-message')).toContainText('자동 전송하지');
    await page.locator('#my-proposals summary').click();
    await page.locator('#proposal-list').getByRole('button', { name: /수정/ }).click();
    await page.locator('#prompt').fill('운영 중지 중에도 보존할 수정 초안');
    await expect(page.locator('#submit-button')).toBeDisabled();
    await page.locator('#prompt-form').dispatchEvent('submit');
    await page.reload();
    await expect(page.locator('#edit-banner')).toBeVisible();
    await expect(page.locator('#prompt')).toHaveValue('운영 중지 중에도 보존할 수정 초안');
    await page.locator('#cancel-edit').click();
    await expect(page.locator('#prompt')).toHaveValue('운영 중지 중에 작성하는 새 초안');
    if (name === 'ended') {
      await expect(page.locator('#countdown')).toBeHidden();
      await expect(page.locator('#release-message')).toHaveText('서비스 운영이 종료되었습니다.');
      await expect(page.locator('#release-message')).not.toContainText('공개되었습니다');
    }
    expect(state.posts).toHaveLength(0);
    expect(state.patches).toHaveLength(0);
    expect(state.proposals[0].body).toBe('원래 접수한 제안');
  });
}

test('a development-only pause keeps proposal submission available', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(signedIn), service: { ...activeService, developmentEnabled: false } });
  await expect(page.locator('#service-title')).toContainText('자동 개발');
  await expect(page.locator('#release-message')).toContainText('기다리고');
  await page.locator('#prompt').fill('개발 대기 중에도 접수할 제안');
  await page.locator('#submit-button').click();
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(page.locator('#prompt')).toHaveValue('');
});

test('a pause during the Google popup cancels auto-send permanently but still permits login', async ({ page }) => {
  const state = await fixture(page);
  await page.locator('#prompt').fill('중지 중에는 자동 전송하면 안 되는 내용');
  await page.locator('#submit-button').click();
  await expect(page.getByRole('button', { name: 'Google 테스트 로그인' })).toBeVisible();
  state.service = { ...activeService, mode: 'maintenance', message: '잠시 점검합니다.' };
  // Login rechecks status even if the normal background poll has not run yet.
  await googleLogin(page);
  await expect(page.locator('#logout-button')).toBeVisible();
  await expect(page.locator('#service-notice')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('중지 중에는 자동 전송하면 안 되는 내용');
  expect(await page.evaluate(() => sessionStorage.getItem('yourgame.pending.v1'))).toBeNull();
  expect(state.posts).toHaveLength(0);
  state.service = { ...activeService };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#submit-button')).toBeEnabled();
  await expect(page.locator('#form-message')).toContainText('접수가 재개');
  await page.reload();
  await expect(page.locator('#prompt')).toHaveValue('중지 중에는 자동 전송하면 안 되는 내용');
  expect(state.posts).toHaveLength(0);
});

test('a failed status check after discovering an existing login cancels the pending Send', async ({ page }) => {
  const state = await fixture(page);
  await page.locator('#prompt').fill('다른 창 로그인 확인 뒤에도 보존할 초안');
  // Another tab has signed in, but the public page still displays its anonymous session.
  state.session = structuredClone(signedIn);
  state.statusFailure = true;
  await page.locator('#submit-button').click();
  await expect(page.locator('#connection-notice')).toBeVisible();
  await expect(page.locator('#form-message')).toContainText('자동 제출하지 않았어요');
  await expect(page.locator('#prompt')).toHaveValue('다른 창 로그인 확인 뒤에도 보존할 초안');
  expect(await page.evaluate(() => sessionStorage.getItem('yourgame.pending.v1'))).toBeNull();
  state.statusFailure = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#submit-button')).toBeEnabled();
  await page.reload();
  await expect(page.locator('#prompt')).toHaveValue('다른 창 로그인 확인 뒤에도 보존할 초안');
  expect(state.posts).toHaveLength(0);
});

test('an operational 409 during edit is not a revision conflict and retains both drafts', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(signedIn), proposals: [savedProposal('pause-edit')] });
  await page.locator('#prompt').fill('수정과 별도로 남겨둔 새 제안');
  await page.locator('#my-proposals summary').click();
  await page.locator('#proposal-list').getByRole('button', { name: /수정/ }).click();
  await page.locator('#prompt').fill('저장 직전 점검이 시작된 수정 내용');
  state.service = { ...activeService, mode: 'maintenance' };
  await page.locator('#submit-button').click();
  await expect.poll(() => state.patches.length).toBe(1);
  await expect(page.locator('#form-message')).toContainText('점검');
  await expect(page.locator('#reload-edit')).toBeHidden();
  await expect(page.locator('#submit-button')).toBeDisabled();
  await expect(page.locator('#prompt')).toHaveValue('저장 직전 점검이 시작된 수정 내용');
  state.service = { ...activeService };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#submit-button')).toBeEnabled();
  await expect(page.locator('#form-message')).toContainText('접수가 재개');
  expect(state.patches).toHaveLength(1);
  await page.locator('#cancel-edit').click();
  await expect(page.locator('#prompt')).toHaveValue('수정과 별도로 남겨둔 새 제안');
  expect(state.posts).toHaveLength(0);
  expect(state.proposals[0].revision).toBe(1);
});

test('a 423 blocks repeat Send even if refreshing status fails, without losing the draft', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(signedIn) });
  await page.locator('#prompt').fill('일시 중지 응답 이후에도 남겨둘 제안');
  state.serviceRejection = { status: 423, code: 'SERVICE_LOCKED' };
  state.statusFailure = true;
  await page.locator('#submit-button').click();
  await expect(page.locator('#form-message')).toContainText('접수가 일시정지');
  await expect(page.locator('#submit-button')).toBeDisabled();
  await expect(page.locator('#service-notice')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('일시 중지 응답 이후에도 남겨둘 제안');
  expect(state.posts).toHaveLength(1);
  expect(state.proposals).toHaveLength(0);
  state.serviceRejection = null;
  state.statusFailure = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#submit-button')).toBeEnabled();
  expect(state.posts).toHaveLength(1);
});

test('English copy, metadata and KST target are complete without translating participant data', async ({ page }) => {
  const original = '원문은 그대로: <img src=x onerror="window.translationXss=true">';
  const announcement = '운영자가 작성한 한국어 공지를 번역하거나 변경하지 않습니다.';
  const state = await fixture(page, { locale: 'en', session: structuredClone(signedIn),
    service: { ...activeService, message: announcement },
    proposals: [{ ...savedProposal(), body: original, safety: { status: 'held', reason: 'PRIVATE_EVIDENCE' } }] });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('yourga.me — One roguelike, shaped by your prompts');
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', /first game is still in development/);
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'en_US');
  await expect(page.locator('#hero-title')).toContainText('One evolving roguelike.');
  await expect(page.locator('.hero-description')).toContainText('desktop and mobile');
  await expect(page.locator('.release-date time')).toHaveAttribute('datetime', '2026-09-01T00:00:00+09:00');
  await expect(page.locator('.release-date')).toContainText('Sep 1, 2026 / 00:00 KST');
  await expect(page.locator('#prompt')).toHaveAttribute('placeholder', /For example/);
  await expect(page.locator('#user-name')).toHaveText(signedIn.user.name);
  await expect(page.locator('#service-message')).toHaveText(announcement);
  await page.locator('#my-proposals summary').click();
  await expect(page.locator('.proposal-body')).toHaveText(original);
  await expect(page.locator('.proposal-safety')).toContainText('Safety review on hold');
  await expect(page.locator('#proposal-list img')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('PRIVATE_EVIDENCE');
  await page.locator('#safety-guidance summary').click();
  await expect(page.locator('#safety-guidance')).toContainText('has not received an official ESRB rating');
  await expect(page.locator('#safety-guidance')).toContainText('Ordinary fantasy combat ideas are welcome');
  await expect(page.locator('.process-status-note')).toContainText('not a live progress tracker');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('.proposal-safety')).toContainText('안전 검토 보류');
  await expect(page.locator('.proposal-body')).toHaveText(original);
  await expect(page.locator('#service-message')).toHaveText(announcement);
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('.proposal-safety')).toContainText('Safety review on hold');
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(0);
  expect(state.loginCalls).toBe(0);
  expect(state.languages.every(entry => entry.value === 'en')).toBe(true);
  expect(await page.evaluate(() => window.translationXss)).toBeUndefined();
});

test('changing language in a pending Google login preserves nonce and explicit Send exactly once', async ({ page }) => {
  let completeLogin;
  const loginGate = new Promise(resolve => { completeLogin = resolve; });
  const state = await fixture(page, { locale: 'en', loginGate });
  const draft = 'Different weapons, one shared roguelike. 한글도 그대로.';
  await page.locator('#prompt').fill(draft);
  await page.locator('#submit-button').click();
  await expect(page.getByRole('button', { name: 'Continue with Google (test)' })).toBeVisible();
  const nonce = await page.evaluate(() => window.testGoogleOptions.nonce);
  const queued = await page.evaluate(() => JSON.parse(sessionStorage.getItem('yourgame.pending.v1')).requestId);
  await page.locator('#login-language-select').selectOption('ko');
  await expect(page.getByRole('button', { name: 'Google 테스트 로그인' })).toBeVisible();
  await expect(page.locator('#login-description')).toContainText('Google 계정으로 로그인');
  await page.locator('#login-language-select').selectOption('en');
  await expect(page.locator('#login-description')).toContainText('Log in with Google');
  expect(await page.evaluate(() => window.testGoogleOptions.nonce)).toBe(nonce);
  expect(await page.evaluate(() => window.testGoogleInitializations)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('yourgame.pending.v1')).requestId)).toBe(queued);
  expect(state.loginCalls).toBe(0);
  expect(state.posts).toHaveLength(0);
  await page.getByRole('button', { name: 'Continue with Google (test)' }).click();
  await expect.poll(() => state.loginCalls).toBe(1);
  await expect(page.locator('#login-message')).toContainText('Verifying your Google account');
  await page.locator('#login-language-select').selectOption('ko');
  await expect(page.locator('#login-message')).toContainText('Google 계정과 남은 제출 횟수');
  expect(state.posts).toHaveLength(0);
  completeLogin();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].body).toBe(draft);
  expect(state.posts[0].requestId).toBe(queued);
  await expect(page.locator('#prompt')).toHaveValue('');
  await expect(page.locator('#form-message')).toContainText('안전 검토 대기');
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#form-message')).toContainText('Safety review pending');
  await expect(page.locator('#quota-status')).toHaveText('2 / 3 submissions left');
  expect(state.languages.find(entry => entry.pathname === '/api/login').value).toBe('en');
  expect(state.languages.find(entry => entry.pathname === '/api/proposals' && entry.method === 'POST').value).toBe('ko');
  expect(state.posts).toHaveLength(1);
});

test('active safety and API errors switch language without retrying or losing a draft', async ({ page }) => {
  const state = await fixture(page, { locale: 'en', session: structuredClone(signedIn), safetyRejection: true });
  const draft = 'An unchanged draft with enough detail to review.';
  await page.locator('#prompt').fill(draft);
  await page.locator('#submit-button').click();
  await expect(page.locator('#form-message')).toContainText('no submission slot was used');
  await expect(page.locator('#form-message')).not.toContainText('PRIVATE_FILTER');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#form-message')).toContainText('제출 횟수는 차감되지 않았어요');
  expect(state.posts).toHaveLength(1);
  await page.locator('#language-select').selectOption('en');
  state.safetyRejection = false;
  state.submissionFailure = true;
  await page.locator('#submit-button').click();
  await expect(page.locator('#form-message')).toContainText('The service is temporarily unavailable');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#form-message')).toContainText('잠시 서비스를 이용할 수 없습니다');
  await expect(page.locator('#prompt')).toHaveValue(draft);
  await expect(page.locator('#quota-status')).toContainText('3 / 3');
  expect(state.posts).toHaveLength(2);
  expect(state.posts[0].requestId).toBe(state.posts[1].requestId);
  await page.reload();
  await expect(page.locator('#prompt')).toHaveValue(draft);
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  expect(state.posts).toHaveLength(2);
});

test('English Google errors stay localized after switching and header login never sends', async ({ page }) => {
  const state = await fixture(page, { locale: 'en', loginFailure: true });
  await page.locator('#prompt').fill('Only logging in, not ready to submit.');
  await page.locator('#login-button').click();
  await page.getByRole('button', { name: 'Continue with Google (test)' }).click();
  await expect(page.locator('#login-message')).toContainText('Google sign-in is temporarily unavailable');
  await page.locator('#login-language-select').selectOption('ko');
  await expect(page.locator('#login-message')).toContainText('Google 로그인 연결을 확인할 수 없습니다');
  await page.locator('#login-language-select').selectOption('en');
  await expect(page.locator('#login-message')).toContainText('Google sign-in is temporarily unavailable');
  await expect(page.locator('#retry-google')).toBeVisible();
  state.loginFailure = false;
  await page.locator('#retry-google').click();
  await page.getByRole('button', { name: 'Continue with Google (test)' }).click();
  await expect(page.locator('#logout-button')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('Only logging in, not ready to submit.');
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(0);
});

test('language changes preserve a zero-quota edit and active IME composition', async ({ page }) => {
  const state = await fixture(page, { locale: 'en', session: structuredClone(signedIn), proposals: [savedProposal()],
    quota: { remaining: 0, limit: 3, nextAvailableAt: new Date(START + 3600000).toISOString() } });
  await page.locator('#my-proposals summary').click();
  await page.locator('.proposal-edit').click();
  await expect(page.locator('#form-message')).toContainText("doesn't use a new submission slot");
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#form-message')).toContainText('새 제안 횟수는 차감되지 않아요');
  await page.locator('#language-select').selectOption('en');
  await page.locator('#prompt').fill('계속 작성 중인 수정 원문 — keep this exact text.');
  await page.locator('#prompt').dispatchEvent('compositionstart');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#submit-button')).toBeDisabled();
  await expect(page.locator('#edit-banner')).toContainText('내 제안 수정 중');
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#edit-banner')).toContainText('No submission slot used');
  await expect(page.locator('#form-feedback')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('계속 작성 중인 수정 원문 — keep this exact text.');
  expect(state.patches).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
  await page.locator('#prompt').dispatchEvent('compositionend');
  await expect(page.locator('#submit-button')).toBeEnabled();
  await page.locator('#submit-button').click();
  await expect.poll(() => state.patches.length).toBe(1);
  await expect(page.locator('#form-message')).toContainText('without using a new slot');
  await expect(page.locator('#quota-status')).toContainText('0 / 3');
  expect(state.posts).toHaveLength(0);
});

for (const [name, response, expected] of [
  ['Korean connection', { locale: 'ko', source: 'country' }, 'ko'],
  ['non-Korean connection', { locale: 'en', source: 'default' }, 'en'],
  ['unavailable country lookup', null, 'en'],
]) {
  test(`public locale initializes from ${name} without using the browser language`, async ({ page }) => {
    const state = await fixture(page, { locale: null, localeResponse: response, localeFailure: response === null });
    await expect(page.locator('html')).toHaveAttribute('lang', expected);
    await expect(page.locator('#language-select')).toHaveValue(expected);
    await expect(page.locator('#submit-button')).toBeEnabled();
    expect(state.languages.every(entry => entry.value === expected)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('yourgame.language.v1'))).toBeNull();
  });
}

test('manual English selection wins a late Korean lookup and survives reload without reloading the active draft', async ({ page }) => {
  let resolveLocale;
  const localeGate = new Promise(resolve => { resolveLocale = resolve; });
  const prepared = fixture(page, { locale: null, localeGate });
  await expect(page.locator('#language-select')).toBeVisible();
  await page.locator('#prompt').fill('My draft exists before the country lookup finishes.');
  await page.locator('#language-select').selectOption('en');
  resolveLocale();
  const state = await prepared;
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#prompt')).toHaveValue('My draft exists before the country lookup finishes.');
  expect(await page.evaluate(() => localStorage.getItem('yourgame.language.v1'))).toBe('en');
  expect(state.posts).toHaveLength(0);
  await page.reload();
  await expect(page.locator('#submit-button')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#prompt')).toHaveValue('My draft exists before the country lookup finishes.');
  expect(state.posts).toHaveLength(0);
});

for (const width of [320, 360, 390, 1440]) {
  test(`English UI at ${width}px keeps its form and login dialog inside the viewport`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await fixture(page, { locale: 'en', loginFailure: true });
    await page.locator('#safety-guidance summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const language = await page.locator('#language-select').boundingBox();
    expect(language.height).toBeGreaterThanOrEqual(44);
    expect(language.x + language.width).toBeLessThanOrEqual(width);
    expect(await page.locator('#prompt').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    if (width < 800) expect(await page.locator('#language-select').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: testInfo.outputPath(`public-english-${width}.png`), fullPage: true });
    await page.locator('#login-button').click();
    await page.getByRole('button', { name: 'Continue with Google (test)' }).click();
    await expect(page.locator('#login-message')).toContainText('temporarily unavailable');
    await expect(page.locator('#retry-google')).toBeVisible();
    const modal = await page.locator('#login-dialog').boundingBox();
    expect(modal.x).toBeGreaterThanOrEqual(0);
    expect(modal.x + modal.width).toBeLessThanOrEqual(width);
    expect(await page.locator('#login-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.locator('#login-dialog').screenshot({ path: testInfo.outputPath(`public-login-english-${width}.png`) });
    await page.locator('#login-language-select').selectOption('ko');
    await expect(page.locator('#login-message')).toContainText('Google 로그인 연결을 확인할 수 없습니다');
    expect(await page.locator('#login-dialog').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
