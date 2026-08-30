import { test, expect } from '@playwright/test';

// UI-only fixtures: every API and Google request is intercepted. No live account,
// proposal, vote, contribution ledger or publication is created by this suite.
const START = Date.parse('2026-08-31T03:00:00Z');
const CLOSE = '2026-08-31T14:00:00.000Z';
const RELEASE = '2026-08-31T15:00:00.000Z';
const ALIAS = 'Player-abcdef000001';
const ALIAS_B = 'Player-abcdef000002';
const anonymous = { user: null, csrfToken: 'csrf-anonymous', googleNonce: 'nonce-anonymous' };
const accountA = { user: { id: 'fixture-user-a', name: 'PRIVATE_GOOGLE_NAME_A' }, csrfToken: 'csrf-a', googleNonce: 'nonce-a' };
const accountB = { user: { id: 'fixture-user-b', name: 'PRIVATE_GOOGLE_NAME_B' }, csrfToken: 'csrf-b', googleNonce: 'nonce-b' };

function ownIdea(body = 'A quieter room between difficult encounters.') {
  return { id: 'private-idea-a', body, revision: 1, editable: true, roundId: 'initial',
    createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    safety: { status: 'pending', message: 'PRIVATE_REVIEW_EVIDENCE' } };
}

function sharedIdea(number = 1, options = {}) {
  return { id: `public-idea-${number}`, body: `Community idea ${number}`, proposalRevision: 1,
    publicationRevision: 1, author: { id: `public-author-${number}`, alias: `Player-${number.toString(16).padStart(12, '0')}` },
    createdAt: new Date(START - number * 60000).toISOString(), upvotes: 0, downvotes: 0,
    votingOpen: true, roundId: 'initial', ...options };
}

function privateCommunity(session = accountA) {
  const second = session.user?.id === accountB.user.id;
  return { ownerId: session.user?.id || accountA.user.id,
    profile: { id: second ? 'public-profile-b' : 'public-profile-a', alias: second ? ALIAS_B : ALIAS,
      leaderboardVisible: false, revision: 1 },
    contribution: { points: '0', adoptedCount: 0 },
    voteQuota: { roundId: 'initial', limit: 3, used: 0, remaining: 3, closesAt: CLOSE },
    votes: [], publications: [] };
}

function gate() {
  let release;
  let started;
  return { promise: new Promise(resolve => { release = resolve; }),
    began: new Promise(resolve => { started = resolve; }),
    release: () => release(), started: () => started() };
}

async function fixture(page, options = {}) {
  const state = { session: structuredClone(anonymous), proposals: [], quota: { remaining: 3, limit: 3, nextAvailableAt: null },
    ideas: [], leaders: [], round: { id: 'initial', status: 'open', closesAt: CLOSE, limit: 3 },
    scoring: { status: 'pending_confirmation', policyVersion: null, issuanceEnabled: false,
      proposer: { base: '100', upvote: { operation: null, value: '5' }, downvote: { operation: null, value: '2' } } },
    posts: [], patches: [], actions: [], effects: [], receipts: new Map(), publicReads: 0, meReads: 0,
    sessionReads: 0, loginCalls: 0, publicFailure: false, meFailure: false, sessionFailure: false,
    ...options };
  state.me ||= privateCommunity(state.session);
  const meSnapshot = () => {
    const result = structuredClone(state.me);
    result.publications = result.publications.map(publication => ({ ...publication,
      eligible: publication.requested && state.proposals.some(idea => idea.id === publication.proposalId
        && idea.revision === publication.proposalRevision && idea.safety.status === 'approved') }));
    return result;
  };
  const publicSnapshot = () => {
    const mine = meSnapshot();
    const own = mine.publications.filter(item => item.eligible).map(item => {
      const idea = state.proposals.find(entry => entry.id === item.proposalId);
      return { id: item.publicId, body: idea.body, proposalRevision: idea.revision,
        publicationRevision: item.publicationRevision, author: { id: mine.profile.id, alias: mine.profile.alias },
        createdAt: idea.createdAt, upvotes: 0, downvotes: 0, votingOpen: state.round?.status === 'open', roundId: state.round?.id || null };
    });
    const recent = [...structuredClone(state.ideas), ...own];
    const items = structuredClone(state.leaders);
    if (mine.profile.leaderboardVisible) items.push({ rank: items.length + 1,
      author: { id: mine.profile.id, alias: mine.profile.alias }, ...mine.contribution });
    return { recent, popular: [...recent].sort((a, b) => b.upvotes - b.downvotes - (a.upvotes - a.downvotes)),
      leaderboard: { items }, round: state.round, scoring: state.scoring, serverTime: new Date(START).toISOString() };
  };
  await page.clock.install({ time: new Date(START) });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('https://accounts.google.com/gsi/client*', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.google = {accounts:{id:{
      initialize(options) { window.fixtureGoogle = options; },
      renderButton(container, options) {
        const button = document.createElement('button'); button.type = 'button';
        button.textContent = options.locale === 'ko' ? 'Google 테스트 로그인' : 'Continue with Google (test)';
        button.style.minHeight = '44px'; button.style.width = options.width + 'px';
        button.addEventListener('click', () => window.fixtureGoogle.callback({credential:'synthetic-google-only'}));
        container.replaceChildren(button);
      }, disableAutoSelect() {}, cancel() {}
    }}};` }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (data, status = 200) => route.fulfill({ contentType: 'application/json', status, body: JSON.stringify(data) });
    const failure = (code, status) => reply({ error: { code, message: 'PRIVATE_INTERNAL_EVIDENCE' } }, status);
    if (url.pathname === '/api/locale') return reply({ locale: 'en', source: 'country' });
    if (url.pathname === '/api/status') return reply({ serverTime: new Date(START).toISOString(),
      collection: { id: 'initial', status: 'open', closesAt: CLOSE, releaseAt: RELEASE, initialClosed: false },
      firstReleaseAt: RELEASE, googleClientId: 'fixture.apps.googleusercontent.com',
      limits: { bytes: 2000, submissions: 3, windowSeconds: 3600 }, game: { published: false } });
    if (url.pathname === '/api/session') {
      state.sessionReads += 1;
      const snapshot = structuredClone(state.session);
      const wait = state.holdNextSession;
      state.holdNextSession = null;
      if (wait) { wait.started(); await wait.promise; }
      return state.sessionFailure ? failure('SERVICE_UNAVAILABLE', 503) : reply(snapshot);
    }
    if (url.pathname === '/api/login') {
      state.loginCalls += 1;
      expect(request.headers()['x-csrf-token']).toBe(state.session.csrfToken);
      if (state.loginFailure) return failure('LOGIN_UNAVAILABLE', 503);
      state.session = structuredClone(accountA);
      state.me.ownerId = accountA.user.id;
      return reply(state.session);
    }
    if (url.pathname === '/api/logout') {
      expect(request.headers()['x-csrf-token']).toBe(state.session.csrfToken);
      state.session = structuredClone(anonymous);
      return reply(state.session);
    }
    if (url.pathname === '/api/proposals' && request.method() === 'GET') {
      return reply({ ownerId: state.session.user?.id || null, proposals: state.proposals,
        quota: state.quota, serverTime: new Date(START).toISOString() });
    }
    if (url.pathname === '/api/proposals' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      state.posts.push(payload);
      expect(request.headers()['x-csrf-token']).toBe(state.session.csrfToken);
      const proposal = { ...ownIdea(payload.body), id: `private-new-${state.posts.length}` };
      state.proposals.unshift(proposal);
      state.quota.remaining -= 1;
      return reply({ proposal, quota: state.quota }, 201);
    }
    if (url.pathname === '/api/proposals' && request.method() === 'PATCH') {
      const payload = request.postDataJSON();
      state.patches.push(payload);
      const proposal = state.proposals.find(idea => idea.id === payload.id);
      Object.assign(proposal, { body: payload.body, revision: proposal.revision + 1,
        safety: { status: 'pending', message: 'PRIVATE_REVIEW_EVIDENCE' } });
      return reply({ proposal, quota: state.quota });
    }
    if (url.pathname === '/api/community' && request.method() === 'GET' && url.searchParams.get('view') === 'me') {
      state.meReads += 1;
      const snapshot = meSnapshot();
      const authenticated = Boolean(state.session.user);
      const wait = state.holdNextMe;
      state.holdNextMe = null;
      if (wait) { wait.started(); await wait.promise; }
      if (state.meFailure) return failure('COMMUNITY_SCHEMA_UNAVAILABLE', 503);
      if (!authenticated) return failure('LOGIN_REQUIRED', 401);
      return reply(snapshot);
    }
    if (url.pathname === '/api/community' && request.method() === 'GET') {
      state.publicReads += 1;
      return state.publicFailure ? failure('COMMUNITY_SCHEMA_UNAVAILABLE', 503) : reply(publicSnapshot());
    }
    if (url.pathname === '/api/community' && request.method() === 'POST') {
      const payload = request.postDataJSON();
      state.actions.push({ payload, csrf: request.headers()['x-csrf-token'], language: request.headers()['x-yourgame-language'] });
      if (request.headers()['x-csrf-token'] !== state.session.csrfToken) return failure('CSRF_REJECTED', 403);
      if (state.nextActionError) {
        const error = state.nextActionError;
        state.nextActionError = null;
        error.change?.();
        return failure(error.code, error.status);
      }
      if (state.receipts.has(payload.requestId)) {
        expect(JSON.stringify(payload)).toBe(state.receipts.get(payload.requestId));
        return reply({ ok: true });
      }
      if (payload.action === 'set_publication') {
        let publication = state.me.publications.find(item => item.proposalId === payload.proposalId);
        if (!publication) {
          publication = { proposalId: payload.proposalId, publicationRevision: 0, publicId: `public-owned-${payload.proposalId}` };
          state.me.publications.push(publication);
        }
        Object.assign(publication, { proposalRevision: payload.proposalRevision, requested: payload.visible,
          publicationRevision: publication.publicationRevision + 1, eligible: false });
      } else if (payload.action === 'set_profile_visibility') {
        state.me.profile.leaderboardVisible = payload.visible;
        state.me.profile.revision += 1;
      } else if (payload.action === 'vote') {
        const prior = state.me.votes.find(vote => vote.publicId === payload.publicId);
        const idea = state.ideas.find(item => item.id === payload.publicId);
        if (prior) idea[prior.direction === 'up' ? 'upvotes' : 'downvotes'] -= 1;
        state.me.votes = state.me.votes.filter(vote => vote.publicId !== payload.publicId);
        if (payload.direction !== 'none') {
          state.me.votes.push({ publicId: payload.publicId, direction: payload.direction,
            proposalRevision: payload.proposalRevision, publicationRevision: payload.publicationRevision, roundId: payload.roundId });
          idea[payload.direction === 'up' ? 'upvotes' : 'downvotes'] += 1;
        }
        state.me.voteQuota.used = state.me.votes.length;
        state.me.voteQuota.remaining = state.me.voteQuota.limit - state.me.votes.length;
      }
      state.effects.push(payload);
      state.receipts.set(payload.requestId, JSON.stringify(payload));
      if (state.malformedAfterNextCommit) {
        state.malformedAfterNextCommit = false;
        return route.fulfill({ contentType: 'application/json', status: 200, body: '{"ok":tr' });
      }
      if (state.failAfterNextCommit) {
        state.failAfterNextCommit = false;
        return failure('SERVICE_UNAVAILABLE', 503);
      }
      return reply({ ok: true });
    }
    return failure('NOT_FOUND', 404);
  });
  await page.goto(`/?lang=${options.locale || 'en'}`);
  await expect(page.locator(state.session.user ? '#logout-button' : '#login-button')).toBeEnabled();
  await expect(page.locator('#community-refresh')).toBeEnabled();
  if (state.session.user && !state.meFailure) await expect(page.locator('#leaderboard-privacy')).toBeEnabled();
  return state;
}

async function openShare(page) {
  await page.locator('#my-proposals').evaluate(element => { element.open = true; });
  await expect(page.locator('.publication-button').first()).toBeEnabled();
  await page.locator('.publication-button').first().click();
  await expect(page.locator('#publication-dialog')).toBeVisible();
}

async function refreshCommunity(page) {
  await page.locator('#community-refresh').click();
  await expect(page.locator('#community-refresh')).toBeEnabled();
}

const voteButton = (page, id = 'public-idea-1', direction = 'up') =>
  page.locator(`[data-public-id="${id}"] [data-direction="${direction}"]`);

test('blank white preview stays 9:16 with honest empty community on desktop and narrow screens', async ({ page }, testInfo) => {
  const state = await fixture(page);
  await expect(page.locator('#community-feed-status')).toContainText('No ideas have been shared');
  await expect(page.locator('#community-feed-list > *')).toHaveCount(0);
  await expect(page.locator('#leaderboard-list > *')).toHaveCount(0);
  await expect(page.locator('#my-contribution')).toBeHidden();
  await expect(page.locator('#community-scoring')).toContainText('still being confirmed');
  await expect(page.locator('#community-scoring')).not.toContainText('100');
  const pixels = await page.locator('#game-preview-canvas').evaluate(canvas => ({
    width: canvas.width, height: canvas.height, pixel: [...canvas.getContext('2d').getImageData(360, 640, 1, 1).data],
  }));
  expect(pixels).toEqual({ width: 720, height: 1280, pixel: [255, 255, 255, 255] });
  for (const width of [1440, 390, 360, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await page.evaluate(() => {
      const canvas = document.querySelector('#game-preview-canvas').getBoundingClientRect();
      const preview = document.querySelector('.game-preview').getBoundingClientRect();
      const form = document.querySelector('.submission-section').getBoundingClientRect();
      const community = document.querySelector('.community-section').getBoundingClientRect();
      return { ratio: canvas.width / canvas.height, sideBySide: form.left > preview.right,
        stacked: form.top >= preview.bottom && community.top >= form.bottom,
        fits: document.documentElement.scrollWidth <= innerWidth };
    });
    expect(geometry.ratio).toBeCloseTo(9 / 16, 3);
    expect(geometry.fits).toBe(true);
    expect(width > 799 ? geometry.sideBySide : geometry.stacked).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`community-empty-${width}.png`), fullPage: true });
  }
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#community-feed-status')).toContainText('아직 공개 동의');
  await expect(page.locator('#game-preview-canvas')).toHaveAttribute('aria-label', /아직 플레이할 게임/);
  await expect(page.locator('.preview-ratio')).toHaveAttribute('aria-label', '가로 9, 세로 16 비율');
  await expect(page.locator('#submit-button')).toBeEnabled();
  expect(state.posts).toHaveLength(0);
  expect(state.actions).toHaveLength(0);
});

test('sharing requires exact source consent and editing never transfers the old consent', async ({ page }, testInfo) => {
  const source = '  <img src=x onerror="window.fixtureXss=true">\nKeep this literal source.  ';
  const state = await fixture(page, { session: structuredClone(accountA), proposals: [ownIdea(source)] });
  await page.locator('#prompt').fill('Unsent private draft');
  await openShare(page);
  expect(await page.locator('#publication-source').textContent()).toBe(source);
  await expect(page.locator('#publication-source img')).toHaveCount(0);
  await expect(page.locator('#publication-alias')).toContainText(ALIAS);
  await expect(page.locator('#publication-dialog')).not.toContainText(accountA.user.name);
  await expect(page.locator('#confirm-publication')).toBeDisabled();
  await page.locator('#confirm-publication').dispatchEvent('click');
  expect(state.actions).toHaveLength(0);
  await page.locator('#publication-consent').check();
  await page.locator('#publication-language-select').selectOption('ko');
  await expect(page.locator('#publication-consent')).toBeChecked();
  expect(await page.locator('#publication-source').textContent()).toBe(source);
  await expect(page.locator('#confirm-publication')).toHaveText('동의하고 공개 요청');
  await page.locator('#publication-dialog').screenshot({ path: testInfo.outputPath('sharing-consent-ko.png') });
  await page.locator('#confirm-publication').click();
  await expect(page.locator('#publication-dialog')).toBeHidden();
  await expect(page.locator('.proposal-publication')).toContainText('공개 요건 확인 대기');
  expect(state.actions[0].payload).toMatchObject({ action: 'set_publication', proposalId: 'private-idea-a',
    proposalRevision: 1, publicationRevision: 0, visible: true });
  expect(state.actions[0].payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(state.actions[0].language).toBe('ko');
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(0);
  expect(state.quota.remaining).toBe(3);
  await expect(page.locator('#community-feed-list > *')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue('Unsent private draft');
  expect(await page.evaluate(() => window.fixtureXss)).toBeUndefined();
  state.proposals[0].safety.status = 'approved';
  await refreshCommunity(page);
  await expect(page.locator('.community-body')).toHaveText(source);
  await expect(page.locator('.community-section')).not.toContainText(accountA.user.name);
  await page.locator('.proposal-edit').click();
  await page.locator('#prompt').fill('A different source requires a new sharing choice.');
  await page.locator('#submit-button').click();
  await expect(page.locator('.proposal-publication')).toContainText('새 공개 동의');
  await expect(page.locator('#community-feed-list > *')).toHaveCount(0);
  await openShare(page);
  await expect(page.locator('#publication-consent')).not.toBeChecked();
  await expect(page.locator('#publication-source')).toHaveText('A different source requires a new sharing choice.');
  expect(state.actions).toHaveLength(1);
  expect(state.quota.remaining).toBe(3);
});

test('withdrawing a shared idea is separate from deleting or editing its original', async ({ page }) => {
  const proposal = ownIdea();
  proposal.safety.status = 'approved';
  const me = privateCommunity();
  me.publications = [{ proposalId: proposal.id, proposalRevision: 1, publicationRevision: 4,
    publicId: 'public-owned-a', requested: true, eligible: true }];
  const state = await fixture(page, { session: structuredClone(accountA), proposals: [proposal], me });
  await expect(page.locator('.community-body')).toHaveText(proposal.body);
  await openShare(page);
  await expect(page.locator('#publication-title')).toContainText('private');
  await expect(page.locator('#publication-description')).toContainText('cannot recall copies');
  await expect(page.locator('#publication-consent-label')).toBeHidden();
  await page.locator('#confirm-publication').click();
  await expect(page.locator('#community-feed-list > *')).toHaveCount(0);
  expect(state.actions[0].payload).toMatchObject({ visible: false, proposalRevision: 1, publicationRevision: 4 });
  expect(state.proposals[0]).toEqual(proposal);
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(0);
  await expect(page.locator('.publication-button')).toHaveText('Share after safety review');
});

test('leaderboard visibility has separate consent and preserves exact verified point strings', async ({ page }, testInfo) => {
  const me = privateCommunity();
  me.contribution = { points: '-123456789012345678901234567890.5', adoptedCount: 2 };
  const state = await fixture(page, { session: structuredClone(accountA), me, proposals: [ownIdea()] });
  await expect(page.locator('#my-contribution-summary')).toContainText(me.contribution.points);
  await expect(page.locator('#leaderboard-list > *')).toHaveCount(0);
  await page.locator('#leaderboard-privacy').click();
  await expect(page.locator('#publication-source-wrap')).toBeHidden();
  await expect(page.locator('#publication-dialog')).not.toContainText(state.proposals[0].body);
  await expect(page.locator('#confirm-publication')).toBeDisabled();
  await page.locator('#publication-consent').check();
  await page.locator('#confirm-publication').click();
  await expect(page.locator('.leaderboard-points')).toHaveText(me.contribution.points);
  expect(state.actions[0].payload).toMatchObject({ action: 'set_profile_visibility', revision: 1, visible: true });
  expect(state.me.publications).toHaveLength(0);
  await expect(page.locator('.community-section')).not.toContainText(accountA.user.name);
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.contribution-board').screenshot({ path: testInfo.outputPath('contribution-exact-points-320.png') });
  await page.locator('#leaderboard-privacy').click();
  await expect(page.locator('#publication-consent-label')).toBeHidden();
  await page.locator('#confirm-publication').click();
  await expect(page.locator('#leaderboard-list > *')).toHaveCount(0);
  await expect(page.locator('#my-contribution-summary')).toContainText(me.contribution.points);
  expect(state.actions[1].payload).toMatchObject({ revision: 2, visible: false });
});

test('anonymous voting logs in without auto-voting or sending the draft, then permits explicit change and removal', async ({ page }) => {
  const state = await fixture(page, { ideas: [sharedIdea()] });
  await page.locator('#prompt').fill('Keep this separate unsent draft');
  await voteButton(page).click();
  await expect(page.locator('#login-description')).toContainText('read the current text');
  await page.getByRole('button', { name: 'Continue with Google (test)' }).click();
  await expect(page.locator('#login-dialog')).toBeHidden();
  await expect(voteButton(page)).toBeEnabled();
  expect(state.loginCalls).toBe(1);
  expect(state.actions).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
  await expect(page.locator('#prompt')).toHaveValue('Keep this separate unsent draft');
  await voteButton(page).click();
  await expect(voteButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#community-vote-note')).toContainText('2 / 3');
  expect(state.actions[0].csrf).toBe(accountA.csrfToken);
  await voteButton(page, 'public-idea-1', 'down').click();
  await expect(voteButton(page, 'public-idea-1', 'down')).toHaveAttribute('aria-pressed', 'true');
  expect(state.me.voteQuota.remaining).toBe(2);
  await page.locator('#language-select').selectOption('ko');
  await page.locator('#feed-popular-tab').click();
  expect(state.actions).toHaveLength(2);
  await voteButton(page, 'public-idea-1', 'down').click();
  await expect(voteButton(page, 'public-idea-1', 'down')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#community-vote-note')).toContainText('3 / 3');
  expect(state.actions.map(action => action.payload.direction)).toEqual(['up', 'down', 'none']);
  expect(state.quota.remaining).toBe(3);
  expect(state.me.contribution.points).toBe('0');
});

test('zero vote slots permit changes and cancellation, never self-voting or an extra active vote', async ({ page }) => {
  const me = privateCommunity();
  const ideas = [1, 2, 3, 4].map(number => sharedIdea(number, { upvotes: number < 4 ? 1 : 0 }));
  me.votes = ideas.slice(0, 3).map(idea => ({ publicId: idea.id, direction: 'up', roundId: idea.roundId,
    proposalRevision: idea.proposalRevision, publicationRevision: idea.publicationRevision }));
  me.voteQuota = { ...me.voteQuota, remaining: 0, used: 3 };
  ideas.push(sharedIdea(5, { author: { id: me.profile.id, alias: me.profile.alias } }));
  const state = await fixture(page, { session: structuredClone(accountA), me, ideas });
  await expect(voteButton(page, 'public-idea-4')).toBeDisabled();
  await voteButton(page, 'public-idea-4').dispatchEvent('click');
  await voteButton(page, 'public-idea-5').dispatchEvent('click');
  expect(state.actions).toHaveLength(0);
  await expect(voteButton(page)).toBeEnabled();
  await voteButton(page).click();
  await expect(voteButton(page, 'public-idea-4')).toBeEnabled();
  expect(state.me.voteQuota.remaining).toBe(1);
  await voteButton(page, 'public-idea-4').click();
  await expect(page.locator('#community-vote-note')).toContainText('0 / 3');
  expect(state.me.votes).toHaveLength(3);
});

test('a failed community login preserves the draft and still never casts a vote after recovery', async ({ page }) => {
  const state = await fixture(page, { ideas: [sharedIdea()], loginFailure: true });
  const draft = 'An independent unsent idea';
  await page.locator('#prompt').fill(draft);
  await voteButton(page).click();
  await page.getByRole('button', { name: 'Continue with Google (test)' }).click();
  await expect(page.locator('#login-message')).toHaveClass(/is-error/);
  await expect(page.locator('#retry-google')).toBeVisible();
  await page.locator('#login-language-select').selectOption('ko');
  await expect(page.locator('#login-message')).toContainText('Google');
  await expect(page.locator('#login-message')).not.toContainText('PRIVATE_INTERNAL_EVIDENCE');
  await expect(page.locator('#prompt')).toHaveValue(draft);
  expect(state.actions).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
  state.loginFailure = false;
  await page.locator('#retry-google').click();
  await page.getByRole('button', { name: 'Google 테스트 로그인' }).click();
  await expect(page.locator('#login-dialog')).toBeHidden();
  await expect(voteButton(page)).toBeEnabled();
  expect(state.loginCalls).toBe(2);
  expect(state.actions).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
  await expect(page.locator('#prompt')).toHaveValue(draft);
});

test('a waiting idea with no voting round stays readable without opening a vote budget', async ({ page }) => {
  const idea = sharedIdea(1, { votingOpen: false, roundId: null });
  const state = await fixture(page, { session: structuredClone(accountA), ideas: [idea], round: null });
  await expect(page.locator('.community-body')).toHaveText(idea.body);
  await expect(voteButton(page)).toBeDisabled();
  await expect(page.locator('#community-vote-note')).toContainText('not open');
  await voteButton(page).dispatchEvent('click');
  expect(state.actions).toHaveLength(0);
  await expect(page.locator('#submit-button')).toBeEnabled();
});

test('a sharing revision conflict removes consent and keeps the source and draft for review', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), proposals: [ownIdea()] });
  const source = state.proposals[0].body;
  await page.locator('#prompt').fill('Draft kept across a sharing conflict');
  await openShare(page);
  await page.locator('#publication-consent').check();
  state.nextActionError = { status: 409, code: 'COMMUNITY_REVISION_CONFLICT', change() { state.proposals[0].revision += 1; } };
  await page.locator('#confirm-publication').click();
  await expect(page.locator('#publication-consent')).not.toBeChecked();
  await expect(page.locator('#confirm-publication')).toBeDisabled();
  await expect(page.locator('#publication-message')).toBeVisible();
  await expect(page.locator('#publication-source')).toHaveText(source);
  await page.locator('#publication-language-select').selectOption('ko');
  await expect(page.locator('#publication-message')).not.toContainText('PRIVATE_INTERNAL_EVIDENCE');
  await page.locator('#confirm-publication').dispatchEvent('click');
  expect(state.actions).toHaveLength(1);
  await page.locator('#cancel-publication').click();
  await expect(page.locator('#prompt')).toHaveValue('Draft kept across a sharing conflict');
});

test('unknown results retain the same request through a read outage and rotated CSRF token', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), failAfterNextCommit: true });
  await page.locator('#leaderboard-privacy').click();
  await page.locator('#publication-consent').check();
  await page.locator('#confirm-publication').click();
  await expect(page.locator('#publication-retry')).toBeEnabled();
  await expect(page.locator('#publication-message')).toContainText("Couldn't confirm");
  expect(state.effects).toHaveLength(1);
  await page.locator('#close-publication').click();
  state.publicFailure = true;
  state.meFailure = true;
  await refreshCommunity(page);
  await expect(page.locator('#community-retry')).toBeEnabled();
  await expect(page.locator('#community-feedback-message')).toContainText("Couldn't confirm");
  state.publicFailure = false;
  state.meFailure = false;
  state.session.csrfToken = 'csrf-a-rotated';
  const reads = state.sessionReads;
  await page.locator('#community-retry').click();
  await expect.poll(() => state.sessionReads).toBeGreaterThan(reads);
  await expect(page.locator('#community-retry')).toBeEnabled();
  await page.locator('#community-retry').click();
  await expect(page.locator('#community-retry')).toBeHidden();
  await expect(page.locator('.leaderboard-entry')).toHaveCount(1);
  expect(state.actions).toHaveLength(3);
  expect(new Set(state.actions.map(action => JSON.stringify(action.payload))).size).toBe(1);
  expect(state.actions.map(action => action.csrf)).toEqual(['csrf-a', 'csrf-a', 'csrf-a-rotated']);
  expect(state.effects).toHaveLength(1);
});

test('community owner mismatch hides both accounts private data until the session is synchronized', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), proposals: [ownIdea()] });
  await page.locator('#prompt').fill('Do not send this while accounts change');
  state.session = structuredClone(accountB);
  state.me = privateCommunity(accountB);
  state.me.contribution.points = '87.5';
  state.proposals = [{ ...ownIdea('Private account B source'), id: 'private-idea-b' }];
  const wait = gate();
  state.holdNextSession = wait;
  await page.locator('#community-refresh').click();
  await wait.began;
  await expect(page.locator('#my-contribution')).toBeHidden();
  await expect(page.locator('#proposal-list > *')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('87.5');
  await expect(page.locator('body')).not.toContainText('Private account B source');
  await expect(page.locator('#submit-button')).toBeDisabled();
  wait.release();
  await expect(page.locator('#user-name')).toHaveText(accountB.user.name);
  await expect(page.locator('#my-contribution-summary')).toContainText('87.5');
  await page.locator('#my-proposals').evaluate(element => { element.open = true; });
  await expect(page.locator('.proposal-body')).toHaveText('Private account B source');
  await expect(page.locator('#prompt')).toHaveValue('Do not send this while accounts change');
  expect(state.actions).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
});

test('a throttled receipt lookup keeps an unknown vote retryable through further read failures', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), ideas: [sharedIdea()], failAfterNextCommit: true });
  await voteButton(page).click();
  await expect(page.locator('#community-retry')).toBeEnabled();
  await page.locator('#language-select').selectOption('ko');
  state.nextActionError = { status: 429, code: 'COMMUNITY_RATE_LIMITED' };
  state.publicFailure = true;
  state.meFailure = true;
  await page.locator('#community-retry').click();
  await expect(page.locator('#community-feedback-message')).toContainText('원래 요청은 보관 중');
  await expect(page.locator('#community-retry')).toBeEnabled();
  await refreshCommunity(page);
  await expect(page.locator('#community-retry')).toBeEnabled();
  await expect(page.locator('#community-feedback-message')).toContainText('원래 요청은 보관 중');
  await expect(page.locator('#submit-button')).toBeEnabled();
  expect(state.actions).toHaveLength(2);
  state.publicFailure = false;
  state.meFailure = false;
  await page.locator('#community-retry').click();
  await expect(page.locator('#community-retry')).toBeHidden();
  await expect(voteButton(page)).toHaveAttribute('aria-pressed', 'true');
  expect(state.actions).toHaveLength(3);
  expect(new Set(state.actions.map(action => JSON.stringify(action.payload))).size).toBe(1);
  expect(state.effects).toHaveLength(1);
});

test('malformed JSON after a successful mutation remains unknown until the same request is checked', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), ideas: [sharedIdea()], malformedAfterNextCommit: true });
  await voteButton(page).click();
  await expect(page.locator('#community-retry')).toBeEnabled();
  await expect(page.locator('#community-feedback-message')).toContainText("Couldn't confirm");
  await page.locator('#community-retry').click();
  await expect(page.locator('#community-retry')).toBeHidden();
  await expect(voteButton(page)).toHaveAttribute('aria-pressed', 'true');
  expect(state.actions).toHaveLength(2);
  expect(state.actions[0].payload).toEqual(state.actions[1].payload);
  expect(state.effects).toHaveLength(1);
});

test('proposal owner mismatch clears the open consent and personal score even if the session read fails', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), proposals: [ownIdea()] });
  await openShare(page);
  await expect(page.locator('#publication-source')).toHaveText(state.proposals[0].body);
  state.session = structuredClone(accountB);
  state.me = privateCommunity(accountB);
  state.proposals = [{ ...ownIdea('Never render account B from a mismatched response'), id: 'private-b' }];
  state.sessionFailure = true;
  await page.clock.runFor(46000);
  await expect(page.locator('#publication-dialog')).toBeHidden();
  expect(await page.locator('#publication-source').textContent()).toBe('');
  expect(await page.locator('#my-contribution-summary').textContent()).toBe('');
  await expect(page.locator('#my-contribution')).toBeHidden();
  await expect(page.locator('#proposal-list > *')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Never render account B');
  expect(state.actions).toHaveLength(0);
});

test('a late private community response cannot restore consent or score after logout', async ({ page }) => {
  const me = privateCommunity();
  me.contribution.points = '42.5';
  const state = await fixture(page, { session: structuredClone(accountA), me, proposals: [ownIdea()] });
  const wait = gate();
  state.holdNextMe = wait;
  await page.locator('#community-refresh').click();
  await wait.began;
  await openShare(page);
  await page.locator('#publication-dialog').evaluate(dialog => dialog.close());
  await page.locator('#logout-button').click();
  await expect(page.locator('#login-button')).toBeEnabled();
  wait.release();
  await expect(page.locator('#my-contribution')).toBeHidden();
  await expect(page.locator('#proposal-list > *')).toHaveCount(0);
  expect(await page.locator('#publication-source').textContent()).toBe('');
  expect(await page.locator('#my-contribution-summary').textContent()).toBe('');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('body')).not.toContainText('42.5');
  expect(state.actions).toHaveLength(0);
});

test('community outages do not block proposal writing, edits or localized error recovery', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), proposals: [ownIdea()] });
  await page.locator('#my-proposals').evaluate(element => { element.open = true; });
  await page.locator('.proposal-edit').click();
  await page.locator('#prompt').fill('The editable draft survives a community-only outage.');
  state.publicFailure = true;
  state.meFailure = true;
  await refreshCommunity(page);
  await expect(page.locator('#community-feed-status')).toContainText("Couldn't load the community");
  await expect(page.locator('#submit-button')).toBeEnabled();
  await expect(page.locator('#prompt')).toHaveValue('The editable draft survives a community-only outage.');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#community-feed-status')).toContainText('불러오지 못했');
  await expect(page.locator('body')).not.toContainText('PRIVATE_INTERNAL_EVIDENCE');
  await page.locator('#submit-button').click();
  await expect(page.locator('#form-message')).toContainText('수정');
  expect(state.patches).toHaveLength(1);
  expect(state.quota.remaining).toBe(3);
  state.publicFailure = false;
  state.meFailure = false;
  await refreshCommunity(page);
  await expect(page.locator('#leaderboard-privacy')).toBeEnabled();
  expect(state.actions).toHaveLength(0);
});

test('an active scoring formula uses server metadata and still distinguishes voting from an award', async ({ page }) => {
  const scoring = { status: 'active', policyVersion: 'synthetic-test-policy', issuanceEnabled: false,
    proposer: { base: '37', upvote: { operation: 'multiply', value: '4' }, downvote: { operation: 'power', value: '3' } },
    voter: { base: '8', upvote: { operation: 'power', value: '2' }, downvote: { operation: 'multiply', value: '0.5' } } };
  await fixture(page, { scoring });
  await expect(page.locator('#community-scoring')).toContainText('37 + upvotes × 4 − downvotes^3');
  await expect(page.locator('#community-scoring')).toContainText('8 + upvotes^2 − downvotes × 0.5');
  await expect(page.locator('#community-scoring')).toContainText('casting a vote alone does not earn points');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#community-scoring')).toContainText('37 + 찬성표 × 4 − 반대표^3');
  await expect(page.locator('#community-scoring')).toContainText('투표만으로 점수를 받지는 않습니다');
});
