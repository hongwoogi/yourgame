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
      leaderboardVisible: Boolean(session.user), revision: 1, visibilitySource: 'service_default' },
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
  const publishDefault = proposal => {
    let publication = state.me.publications.find(item => item.proposalId === proposal.id);
    if (!publication) {
      publication = { proposalId: proposal.id, publicId: 'public-owned-' + proposal.id,
        proposalRevision: proposal.revision, publicationRevision: 1, requested: true,
        visibilitySource: 'service_default' };
      state.me.publications.push(publication);
    } else if (publication.requested && publication.proposalRevision !== proposal.revision) {
      publication.proposalRevision = proposal.revision;
      publication.publicationRevision += 1;
    }
  };
  state.proposals.forEach(publishDefault);
  const meSnapshot = () => {
    const result = structuredClone(state.me);
    result.publications = result.publications.map(publication => ({ ...publication,
      eligible: publication.requested && state.proposals.some(idea => idea.id === publication.proposalId
        && idea.revision === publication.proposalRevision) }));
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
      leaderboard: { items: items.slice(0, 10) }, round: state.round, scoring: state.scoring, serverTime: new Date(START).toISOString() };
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
      state.me.profile.leaderboardVisible = true;
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
      publishDefault(proposal);
      state.quota.remaining -= 1;
      return reply({ proposal, quota: state.quota }, 201);
    }
    if (url.pathname === '/api/proposals' && request.method() === 'PATCH') {
      const payload = request.postDataJSON();
      state.patches.push(payload);
      const proposal = state.proposals.find(idea => idea.id === payload.id);
      Object.assign(proposal, { body: payload.body, revision: proposal.revision + 1,
        safety: { status: 'pending', message: 'PRIVATE_REVIEW_EVIDENCE' } });
      publishDefault(proposal);
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
  if (state.session.user && !state.meFailure) await expect(page.locator('#my-contribution')).toBeVisible();
  return state;
}

async function openMyIdeas(page) {
  await page.locator('#open-my-proposals').click();
  await expect(page.locator('#my-proposals-dialog')).toBeVisible();
}

async function refreshCommunity(page) {
  await page.locator('#community-refresh').click();
  await expect(page.locator('#community-refresh')).toBeEnabled();
}

const voteButton = (page, id = 'public-idea-1', direction = 'up') =>
  page.locator(`[data-public-id="${id}"] [data-direction="${direction}"]`);

test('blank preview and empty feeds remain honest in the compact desktop and mobile layout', async ({ page }, testInfo) => {
  const state = await fixture(page);
  await expect(page.locator('#community-feed-status')).toContainText('No ideas yet');
  await expect(page.locator('#community-feed-list > *')).toHaveCount(0);
  await expect(page.locator('#leaderboard-list > *')).toHaveCount(0);
  await expect(page.locator('#my-contribution')).toBeHidden();
  await expect(page.locator('#community-scoring, #publication-dialog, #safety-guidance')).toHaveCount(0);
  const pixels = await page.locator('#game-preview-canvas').evaluate(canvas => ({
    width: canvas.width, height: canvas.height, pixel: [...canvas.getContext('2d').getImageData(360, 640, 1, 1).data],
  }));
  expect(pixels).toEqual({ width: 720, height: 1280, pixel: [255, 255, 255, 255] });
  for (const [width, height] of [[1280, 720], [1920, 1080], [390, 844], [360, 800], [320, 720]]) {
    await page.setViewportSize({ width, height });
    // The test clock pauses animation frames; let dynamic viewport units settle.
    await page.clock.runFor(50);
    if (width > 799) await expect.poll(() => page.evaluate(() =>
      document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    const geometry = await page.evaluate(() => {
      const canvas = document.querySelector('#game-preview-canvas').getBoundingClientRect();
      const preview = document.querySelector('.game-preview').getBoundingClientRect();
      const form = document.querySelector('.submission-section').getBoundingClientRect();
      const voting = document.querySelector('.community-section').getBoundingClientRect();
      const leaderboard = document.querySelector('.contribution-board').getBoundingClientRect();
      return { ratio: canvas.width / canvas.height, sideBySide: form.left > preview.right,
        votingFirst: voting.bottom <= form.top,
        stacked: voting.top >= preview.bottom && leaderboard.top >= form.bottom,
        horizontalFit: document.documentElement.scrollWidth <= innerWidth,
        verticalFit: document.documentElement.scrollHeight <= innerHeight };
    });
    expect(geometry.ratio).toBeCloseTo(9 / 16, 3);
    expect(geometry.horizontalFit).toBe(true);
    expect(geometry.votingFirst).toBe(true);
    expect(width > 799 ? geometry.sideBySide && geometry.verticalFit : geometry.stacked).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('community-empty-' + width + '.png'), fullPage: true });
  }
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#community-feed-status')).toContainText('아직 공개된 제안');
  await expect(page.locator('#game-preview-canvas')).toHaveAttribute('aria-label', /아직 플레이할 게임/);
  await expect(page.locator('.preview-ratio')).toHaveAttribute('aria-label', '가로 9, 세로 16 비율');
  await expect(page.locator('#submit-button')).toBeEnabled();
  expect(state.posts).toHaveLength(0);
  expect(state.actions).toHaveLength(0);
});

test('submitted and edited ideas appear immediately without a consent or safety-approval step', async ({ page }) => {
  const source = '  <img src=x onerror="window.fixtureXss=true">\nKeep this literal source.  ';
  const state = await fixture(page, { session: structuredClone(accountA) });
  await expect(page.locator('#public-idea-notice')).toHaveText('Ideas are public.');
  await page.locator('#prompt').fill(source);
  await page.locator('#submit-button').click();
  await expect(page.locator('.community-body')).toHaveText(source);
  await expect(page.locator('.community-body img')).toHaveCount(0);
  await expect(page.locator('.community-section')).not.toContainText(accountA.user.name);
  await expect(page.locator('#my-proposals-dialog')).toBeHidden();
  expect(state.posts).toHaveLength(1);
  expect(state.proposals[0].safety.status).toBe('pending');
  expect(state.quota.remaining).toBe(2);
  await page.locator('.community-read').click();
  expect(await page.locator('#idea-body').textContent()).toBe(source);
  await expect(page.locator('#idea-body img')).toHaveCount(0);
  expect(await page.evaluate(() => window.fixtureXss)).toBeUndefined();
  await page.keyboard.press('Escape');
  await expect(page.locator('#idea-dialog')).toBeHidden();
  expect(await page.locator('#idea-body').textContent()).toBe('');
  await page.locator('#prompt').fill('Keep this independent new draft');
  await openMyIdeas(page);
  await expect(page.locator('.proposal-body')).toHaveText(source);
  await expect(page.locator('.proposal-safety, .publication-button')).toHaveCount(0);
  await page.locator('.proposal-edit').click();
  await expect(page.locator('#my-proposals-dialog')).toBeHidden();
  await expect(page.locator('#prompt')).toBeFocused();
  const revised = 'The revised idea is public without another sharing step.';
  await page.locator('#prompt').fill(revised);
  await page.locator('#submit-button').click();
  await expect(page.locator('.community-body')).toHaveText(revised);
  await expect(page.locator('#prompt')).toHaveValue('Keep this independent new draft');
  expect(state.proposals[0].revision).toBe(2);
  expect(state.proposals[0].safety.status).toBe('pending');
  expect(state.me.publications[0].publicationRevision).toBe(2);
  expect(state.patches).toHaveLength(1);
  expect(state.actions).toHaveLength(0);
  expect(state.quota.remaining).toBe(2);
});

test('an existing explicit withdrawal is not silently published by reading or editing', async ({ page }) => {
  const proposal = ownIdea('An explicitly withdrawn older idea.');
  const me = privateCommunity();
  me.publications = [{ proposalId: proposal.id, proposalRevision: 1, publicationRevision: 4,
    publicId: 'public-owned-a', requested: false, eligible: false, visibilitySource: 'author_choice' }];
  const state = await fixture(page, { session: structuredClone(accountA), proposals: [proposal], me });
  await expect(page.locator('#community-feed-list > *')).toHaveCount(0);
  await openMyIdeas(page);
  await expect(page.locator('.proposal-body')).toHaveText(proposal.body);
  await page.locator('.proposal-edit').click();
  await page.locator('#prompt').fill('An edit does not erase the previous explicit withdrawal.');
  await page.locator('#submit-button').click();
  await expect(page.locator('#form-message')).toContainText('saved');
  await expect(page.locator('#community-feed-list > *')).toHaveCount(0);
  expect(state.proposals).toHaveLength(1);
  expect(state.actions).toHaveLength(0);
  expect(state.patches).toHaveLength(1);
  expect(state.me.publications[0].requested).toBe(false);
  expect(state.quota.remaining).toBe(3);
});

test('the default-public leaderboard preserves exact point strings and uses only public aliases', async ({ page }, testInfo) => {
  const me = privateCommunity();
  me.contribution = { points: '-123456789012345678901234567890.5', adoptedCount: 2 };
  const state = await fixture(page, { session: structuredClone(accountA), me, proposals: [ownIdea()] });
  await expect(page.locator('#my-contribution-summary')).toContainText(me.contribution.points);
  await expect(page.locator('.leaderboard-points')).toHaveText(me.contribution.points);
  await expect(page.locator('.contribution-board')).not.toContainText(accountA.user.name);
  await expect(page.locator('.community-section')).not.toContainText(accountA.user.name);
  await expect(page.locator('#leaderboard-privacy, #publication-dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.contribution-board').screenshot({ path: testInfo.outputPath('contribution-exact-points-320.png') });
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('.leaderboard-points')).toHaveText(me.contribution.points);
  expect(state.actions).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
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
  await page.locator('#community-next').click();
  await expect(voteButton(page, 'public-idea-4')).toBeDisabled();
  await voteButton(page, 'public-idea-4').dispatchEvent('click');
  await voteButton(page, 'public-idea-5').dispatchEvent('click');
  expect(state.actions).toHaveLength(0);
  await page.locator('#community-prev').click();
  await expect(voteButton(page)).toBeEnabled();
  await voteButton(page).click();
  await page.locator('#community-next').click();
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

test('a vote revision conflict refreshes the current source without repeating a vote or losing a draft', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), ideas: [sharedIdea()] });
  await page.locator('#prompt').fill('Draft kept across a voting conflict');
  state.nextActionError = { status: 409, code: 'COMMUNITY_REVISION_CONFLICT', change() {
    Object.assign(state.ideas[0], { body: 'The author changed this idea.', proposalRevision: 2, publicationRevision: 2 });
  } };
  await voteButton(page).click();
  await expect(page.locator('.community-body')).toHaveText('The author changed this idea.');
  await expect(voteButton(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#community-feedback')).toBeVisible();
  await expect(page.locator('#community-feedback')).not.toContainText('PRIVATE_INTERNAL_EVIDENCE');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#prompt')).toHaveValue('Draft kept across a voting conflict');
  expect(state.actions).toHaveLength(1);
  expect(state.effects).toHaveLength(0);
  expect(state.quota.remaining).toBe(3);
});

test('unknown vote results retain the same request through a read outage and rotated CSRF token', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), ideas: [sharedIdea()], failAfterNextCommit: true });
  await voteButton(page).click();
  await expect(page.locator('#community-retry')).toBeEnabled();
  await expect(page.locator('#community-feedback-message')).toContainText("Couldn't confirm");
  expect(state.effects).toHaveLength(1);
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
  await expect(voteButton(page)).toHaveAttribute('aria-pressed', 'true');
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
  state.me.profile.leaderboardVisible = false;
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
  await openMyIdeas(page);
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

test('proposal owner mismatch clears the open history and personal score even if the session read fails', async ({ page }) => {
  const me = privateCommunity();
  me.profile.leaderboardVisible = false;
  const state = await fixture(page, { session: structuredClone(accountA), me, proposals: [ownIdea()] });
  await openMyIdeas(page);
  await expect(page.locator('.proposal-body')).toHaveText(state.proposals[0].body);
  state.session = structuredClone(accountB);
  state.me = privateCommunity(accountB);
  state.me.profile.leaderboardVisible = false;
  state.proposals = [{ ...ownIdea('Never render private history from a mismatched response'), id: 'private-b' }];
  state.sessionFailure = true;
  await page.clock.runFor(46000);
  await expect(page.locator('#my-proposals-dialog')).toBeHidden();
  expect(await page.locator('#my-contribution-summary').textContent()).toBe('');
  await expect(page.locator('#my-contribution')).toBeHidden();
  await expect(page.locator('#proposal-list > *')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Never render private history');
  expect(state.actions).toHaveLength(0);
});

test('a late private community response cannot restore history or a private score after logout', async ({ page }) => {
  const me = privateCommunity();
  me.profile.leaderboardVisible = false;
  me.contribution.points = '42.5';
  const state = await fixture(page, { session: structuredClone(accountA), me, proposals: [ownIdea()] });
  const wait = gate();
  state.holdNextMe = wait;
  await page.locator('#community-refresh').click();
  await wait.began;
  await openMyIdeas(page);
  await page.locator('#close-my-proposals').click();
  await page.locator('#logout-button').click();
  await expect(page.locator('#login-button')).toBeEnabled();
  wait.release();
  await expect(page.locator('#my-contribution')).toBeHidden();
  await expect(page.locator('#proposal-list > *')).toHaveCount(0);
  await expect(page.locator('#open-my-proposals')).toBeHidden();
  expect(await page.locator('#my-contribution-summary').textContent()).toBe('');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('body')).not.toContainText('42.5');
  expect(state.actions).toHaveLength(0);
});

test('community outages do not block proposal writing, edits or localized error recovery', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), proposals: [ownIdea()] });
  await openMyIdeas(page);
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
  await expect(page.locator('#my-contribution')).toBeVisible();
  expect(state.actions).toHaveLength(0);
});

test('voting does not invent contribution points when a scoring policy exists', async ({ page }) => {
  const scoring = { status: 'active', policyVersion: 'synthetic-test-policy', issuanceEnabled: false,
    proposer: { base: '37', upvote: { operation: 'multiply', value: '4' }, downvote: { operation: 'power', value: '3' } },
    voter: { base: '8', upvote: { operation: 'power', value: '2' }, downvote: { operation: 'multiply', value: '0.5' } } };
  const state = await fixture(page, { session: structuredClone(accountA), ideas: [sharedIdea()], scoring });
  await expect(page.locator('#community-scoring')).toHaveCount(0);
  await voteButton(page).click();
  await expect(voteButton(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.leaderboard-points')).toHaveText('0');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#my-contribution-summary')).toContainText('0');
  expect(state.me.contribution).toEqual({ points: '0', adoptedCount: 0 });
  expect(state.effects).toHaveLength(1);
});


test('three-card pagination exposes every returned idea and keeps the full text readable in either language', async ({ page }) => {
  const ideas = Array.from({ length: 6 }, (_, index) => sharedIdea(index + 1,
    { body: 'Idea ' + (index + 1) + '\n' + '상상 속의 던전. '.repeat(55), upvotes: index }));
  const state = await fixture(page, { ideas });
  await expect(page.locator('.community-entry')).toHaveCount(3);
  await expect(page.locator('#community-page')).toHaveText('1 / 2');
  await expect(page.locator('#community-prev')).toBeDisabled();
  await page.locator('#community-next').click();
  await expect(page.locator('#community-page')).toHaveText('2 / 2');
  await expect(page.locator('#community-next')).toBeDisabled();
  expect(await page.locator('.community-body').allTextContents()).toEqual(ideas.slice(3).map(idea => idea.body));
  await page.locator('.community-read').last().click();
  expect(await page.locator('#idea-body').textContent()).toBe(ideas[5].body);
  await expect(page.locator('#idea-author')).toContainText(ideas[5].author.alias);
  await page.locator('#close-idea').click();
  await expect(page.locator('.community-read').last()).toBeFocused();
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#community-page')).toHaveText('2 / 2');
  await page.locator('.community-read').last().click();
  expect(await page.locator('#idea-body').textContent()).toBe(ideas[5].body);
  await expect(page.locator('#idea-title')).toHaveText('제안 원문');
  await page.locator('#idea-language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.locator('#idea-body').textContent()).toBe(ideas[5].body);
  await page.keyboard.press('Escape');
  await expect(page.locator('#idea-dialog')).toBeHidden();
  expect(await page.locator('#idea-body').textContent()).toBe('');
  await page.locator('#feed-popular-tab').click();
  await expect(page.locator('#community-page')).toHaveText('1 / 2');
  expect(await page.locator('.community-body').allTextContents()).toEqual([...ideas].reverse().slice(0, 3).map(idea => idea.body));
  expect(state.actions).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
});

test('an open idea reader clears a replaced, withdrawn or unavailable source on refresh', async ({ page }) => {
  const state = await fixture(page, { ideas: [sharedIdea()] });
  await page.locator('#prompt').fill('Preserved independent draft');
  await page.locator('.community-read').click();
  await expect(page.locator('#idea-body')).toHaveText('Community idea 1');
  Object.assign(state.ideas[0], { body: 'A revised public source', proposalRevision: 2, publicationRevision: 2 });
  await page.clock.runFor(46000);
  await expect(page.locator('#idea-dialog')).toBeHidden();
  expect(await page.locator('#idea-body').textContent()).toBe('');
  await expect(page.locator('.community-body')).toHaveText('A revised public source');
  await page.locator('.community-read').click();
  state.ideas = [];
  await page.clock.runFor(46000);
  await expect(page.locator('#idea-dialog')).toBeHidden();
  expect(await page.locator('#idea-body').textContent()).toBe('');
  await expect(page.locator('#community-feed-list > *')).toHaveCount(0);
  state.ideas = [sharedIdea(2)];
  await refreshCommunity(page);
  await page.locator('.community-read').click();
  state.publicFailure = true;
  await page.clock.runFor(46000);
  await expect(page.locator('#idea-dialog')).toBeHidden();
  expect(await page.locator('#idea-body').textContent()).toBe('');
  await expect(page.locator('#prompt')).toHaveValue('Preserved independent draft');
  expect(state.actions).toHaveLength(0);
});

test('a populated desktop workspace fits 16:9 without hiding voting, the composer or ten leaderboard rows', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const ideas = Array.from({ length: 6 }, (_, index) => sharedIdea(index + 1,
    { body: '한글과 English idea. '.repeat(60), upvotes: 9876 + index, downvotes: 1234 }));
  const leaders = Array.from({ length: 10 }, (_, index) => ({
    rank: index + 1, author: { id: 'board-' + index, alias: 'Player-' + (index + 100).toString(16).padStart(12, '0') },
    points: String(10000 - index * 11) + '.5', adoptedCount: 3,
  }));
  const state = await fixture(page, { session: structuredClone(accountA), ideas, leaders });
  await page.locator('#prompt').fill('Long draft stays editable. '.repeat(75));
  for (const locale of ['en', 'ko']) {
    await page.locator('#language-select').selectOption(locale);
    for (const [width, height] of [[1280, 720], [1366, 768], [1600, 900], [1920, 1080]]) {
      await page.setViewportSize({ width, height });
      await page.clock.runFor(50);
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      await expect(page.locator('.leaderboard-entry')).toHaveCount(10);
      const geometry = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const inside = box => box.top >= 0 && box.left >= 0 && box.right <= innerWidth + .5 && box.bottom <= innerHeight + .5;
        const canvas = rect('#game-preview-canvas');
        const voting = rect('.community-section');
        const composer = rect('.submission-section');
        const essentials = ['.masthead', '.hero', '#game-preview-canvas', '.community-section',
          '#prompt-form', '.contribution-board', '.process-section', '#submit-button', '#open-my-proposals'];
        return { pageFits: document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth,
          essentialsInside: essentials.every(selector => inside(rect(selector))),
          allCardsVisible: [...document.querySelectorAll('.community-entry,.leaderboard-entry')].every(element => inside(element.getBoundingClientRect())),
          votingBeforeComposer: voting.bottom <= composer.top,
          canvasRatio: canvas.width / canvas.height,
          buttonsUsable: [...document.querySelectorAll('.vote-button,.community-read,#community-prev,#community-next')]
            .every(element => { const box = element.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; }),
          documentNotClipped: !['hidden', 'clip'].includes(getComputedStyle(document.documentElement).overflowY)
            && !['hidden', 'clip'].includes(getComputedStyle(document.body).overflowY) };
      });
      expect(geometry, locale + ' ' + width).toMatchObject({
        pageFits: true, essentialsInside: true, allCardsVisible: true, votingBeforeComposer: true,
        buttonsUsable: true, documentNotClipped: true,
      });
      expect(geometry.canvasRatio).toBeCloseTo(9 / 16, 3);
      await page.screenshot({ path: testInfo.outputPath('workspace-' + locale + '-' + width + '.png'), fullPage: true });
    }
  }
  expect(state.posts).toHaveLength(0);
  expect(state.actions).toHaveLength(0);
});
