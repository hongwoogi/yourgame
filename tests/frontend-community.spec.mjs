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
    contribution: { points: '0', adoptedCount: 0, rank: session.user ? 1 : null },
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
    serverTime: START,
    collection: { id: 'initial', status: 'open', closesAt: CLOSE, releaseAt: RELEASE, initialClosed: false },
    ideas: [], leaders: [], round: { id: 'initial', status: 'open', closesAt: CLOSE, limit: 3 },
    scoring: { status: 'active', policyVersion: 'contribution-weighted-v1', issuanceEnabled: true, blockedReason: null,
      proposer: { base: '100', upvote: { operation: 'multiply', value: '5' }, downvote: { operation: 'multiply', value: '2' } },
      voter: { base: '10', upvote: { operation: 'multiply', value: '1' }, downvote: { operation: 'multiply', value: '0.5' } } },
    posts: [], patches: [], actions: [], effects: [], receipts: new Map(), publicReads: 0, meReads: 0,
    sessionReads: 0, loginCalls: 0, publicFailure: false, meFailure: false, sessionFailure: false,
    leaderboardReads: [], leaderboardFailure: false, ideasReads: [], ideasFailure: false, publicQueries: [],
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
  const leaderboardSnapshot = () => {
    const me = state.me;
    const items = structuredClone(state.leaders).filter(item => me.profile.leaderboardVisible || item.author.id !== me.profile.id);
    for (const item of items) if (item.author.id === me.profile.id) item.author.alias = me.profile.alias;
    if (me.profile.leaderboardVisible && !items.some(item => item.author.id === me.profile.id)) {
      items.push({ rank: items.length + 1, author: { id: me.profile.id, alias: me.profile.alias },
        points: me.contribution.points, adoptedCount: me.contribution.adoptedCount });
    }
    return items;
  };
  const meSnapshot = () => {
    const result = structuredClone(state.me);
    result.contribution.rank = result.profile.leaderboardVisible
      ? leaderboardSnapshot().find(row => row.author.id === result.profile.id)?.rank ?? null : null;
    result.publications = result.publications.map(publication => ({ ...publication,
      eligible: publication.requested && state.proposals.some(idea => idea.id === publication.proposalId
        && idea.revision === publication.proposalRevision) }));
    return result;
  };
  const publicSnapshot = ({ all = false, includeClosed = false } = {}) => {
    const mine = meSnapshot();
    const own = mine.publications.filter(item => item.eligible).map(item => {
      const idea = state.proposals.find(entry => entry.id === item.proposalId);
      return { id: item.publicId, body: idea.body, proposalRevision: idea.revision,
        publicationRevision: item.publicationRevision, author: { id: mine.profile.id, alias: mine.profile.alias },
        createdAt: idea.createdAt, upvotes: 0, downvotes: 0, votingOpen: state.round?.status === 'open', roundId: state.round?.id || null };
    });
    const recent = [...structuredClone(state.ideas), ...own]
      .filter(idea => includeClosed || (idea.votingOpen && idea.roundId === state.round?.id && state.round?.status === 'open'
        && (!state.round.closesAt || Date.parse(state.round.closesAt) > state.serverTime)))
      .slice(0, all ? undefined : state.mainLimit);
    const items = leaderboardSnapshot();
    return { recent, popular: [...recent].sort((a, b) => b.upvotes - b.downvotes - (a.upvotes - a.downvotes)),
      leaderboard: { items: items.slice(0, 10) }, round: state.round, includeClosed,
      scoring: state.scoring, serverTime: new Date(state.serverTime).toISOString() };
  };
  await page.clock.install({ time: new Date(state.serverTime) });
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
    if (url.pathname === '/api/status') return reply({ serverTime: new Date(state.serverTime).toISOString(),
      collection: state.collection,
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
        quota: state.quota, serverTime: new Date(state.serverTime).toISOString() });
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
    if (url.pathname === '/api/community' && request.method() === 'GET' && url.searchParams.get('view') === 'leaderboard') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 20);
      state.leaderboardReads.push({ offset, limit });
      const all = leaderboardSnapshot();
      const snapshot = { items: all.slice(offset, offset + limit), offset, limit, total: all.length, hasMore: offset + limit < all.length };
      const wait = state.holdNextLeaderboard;
      state.holdNextLeaderboard = null;
      if (wait) { wait.started(); await wait.promise; }
      return state.leaderboardFailure ? failure('COMMUNITY_SCHEMA_UNAVAILABLE', 503)
        : reply(state.leaderboardTransform ? state.leaderboardTransform(snapshot) : snapshot);
    }
    if (url.pathname === '/api/community' && request.method() === 'GET' && url.searchParams.get('view') === 'ideas') {
      const sort = url.searchParams.get('sort') || 'recent';
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 24);
      const includeClosed = url.searchParams.get('includeClosed') === '1';
      state.ideasReads.push({ sort, offset, limit, includeClosed, language: request.headers()['x-yourgame-language'] });
      const items = publicSnapshot({ all: true, includeClosed }).recent.sort((a, b) => {
        if (sort === 'popular') {
          const difference = (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes) || b.upvotes - a.upvotes;
          if (difference) return difference;
        }
        return Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id);
      });
      const snapshot = { items: items.slice(offset, offset + limit), sort, offset, limit, total: items.length,
        hasMore: offset + limit < items.length, round: structuredClone(state.round), includeClosed,
        publicationPolicy: { version: 'public-default-v1', defaultPublic: true }, serverTime: new Date(state.serverTime).toISOString() };
      const wait = state.holdNextIdeas;
      state.holdNextIdeas = null;
      if (wait) { wait.started(); await wait.promise; }
      return state.ideasFailure ? failure('COMMUNITY_SCHEMA_UNAVAILABLE', 503)
        : reply(state.ideasTransform ? state.ideasTransform(snapshot) : snapshot);
    }
    if (url.pathname === '/api/community' && request.method() === 'GET') {
      state.publicReads += 1;
      const includeClosed = url.searchParams.get('includeClosed') === '1';
      state.publicQueries.push({ includeClosed });
      const snapshot = publicSnapshot({ includeClosed });
      const wait = state.holdNextPublic;
      state.holdNextPublic = null;
      if (wait) { wait.started(); await wait.promise; }
      return state.publicFailure ? failure('COMMUNITY_SCHEMA_UNAVAILABLE', 503) : reply(snapshot);
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
      } else if (payload.action === 'set_profile_alias') {
        if (payload.revision !== state.me.profile.revision) return failure('COMMUNITY_REVISION_CONFLICT', 409);
        state.me.profile.alias = payload.alias;
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
      const responseWait = state.holdNextActionResponse;
      state.holdNextActionResponse = null;
      if (responseWait) { responseWait.started(); await responseWait.promise; }
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

function manyIdeas(count = 30) {
  return Array.from({ length: count }, (_, index) => sharedIdea(index + 1));
}

test('the shared history toggle defaults to the current round and preserves the draft, locale and self-vote guard', async ({ page }) => {
  const current = manyIdeas(3);
  current[0].author = { id: 'public-profile-a', alias: ALIAS };
  const history = Array.from({ length: 30 }, (_, index) => sharedIdea(index + 101, {
    body: `Closed idea ${index + 1}\n` + 'A complete archived requirement. '.repeat(35),
    roundId: 'previous-round', votingOpen: false,
    createdAt: new Date(START - 86400000 - index * 1000).toISOString(),
  }));
  const state = await fixture(page, { session: structuredClone(accountA), ideas: [...current, ...history], mainLimit: 6 });
  const draft = 'Keep this unsubmitted 한국어 draft while I browse.';
  await page.locator('#prompt').fill(draft);
  await expect(page.getByRole('switch', { name: 'Show all ideas', exact: true }).first()).not.toBeChecked();
  await expect(page.locator('#community-feed-list > *')).toHaveCount(3);
  await expect(page.locator('#community-feed-list [data-public-id="public-idea-101"]')).toHaveCount(0);
  expect(state.publicQueries.at(-1)).toEqual({ includeClosed: false });
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > tr')).toHaveCount(3);
  await expect(page.locator('#ideas-table')).toHaveRole('table');
  await expect(page.locator('#ideas-table th')).toHaveCount(2);
  await expect(page.locator('#ideas-include-closed')).not.toBeChecked();
  const own = page.locator('#ideas-list [data-public-id="public-idea-1"]');
  await expect(own.locator('.own-idea-badge')).toHaveText('My idea');
  await expect(own.locator('[data-direction="up"]')).toBeDisabled();
  await page.locator('#ideas-include-closed').check();
  await expect(page.locator('#ideas-list > tr')).toHaveCount(24);
  await expect(page.locator('#community-include-closed')).toBeChecked();
  expect(state.publicQueries.at(-1)).toEqual({ includeClosed: true });
  expect(state.ideasReads.at(-1)).toMatchObject({ includeClosed: true, offset: 0 });
  await page.locator('#ideas-next').click();
  await expect(page.locator('#ideas-page')).toHaveText('2 / 2');
  const closed = page.locator('#ideas-list > tr').first();
  await expect(closed.locator('[data-direction="up"]')).toBeDisabled();
  await expect(closed.locator('[data-direction="down"]')).toBeDisabled();
  await expect(closed.locator('.vote-note')).toHaveText('Voting closed');
  await expect(closed.locator('.community-read')).toHaveAccessibleDescription(history[21].body.replace(/\s+/g, ' ').trim());
  await closed.locator('.community-read').click();
  await expect(page.locator('#idea-body')).toHaveText(history[21].body);
  await page.locator('#idea-language-select').selectOption('ko');
  await expect(page.locator('#idea-body')).toHaveText(history[21].body);
  await page.locator('#close-idea').click();
  await expect(page.locator('#ideas-include-closed')).toBeChecked();
  await expect(page.getByRole('switch', { name: '전체 의견 보기', exact: true }).last()).toBeChecked();
  await page.locator('#ideas-include-closed').uncheck();
  await expect(page.locator('#ideas-list > tr')).toHaveCount(3);
  await expect(page.locator('#ideas-page')).toHaveText('1 / 1');
  await expect(page.locator('#community-include-closed')).not.toBeChecked();
  await expect(own.locator('.own-idea-badge')).toHaveText('내 의견');
  await expect(own.locator('[data-direction="down"]')).toBeDisabled();
  expect(state.ideasReads.at(-1)).toMatchObject({ includeClosed: false, offset: 0, language: 'ko' });
  await page.locator('#close-ideas').click();
  await expect(page.locator('#prompt')).toHaveValue(draft);
  expect(state.actions).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(0);
});

test('history scope changes reject delayed main and modal replies without restoring old rows', async ({ page }) => {
  const history = sharedIdea(2, { roundId: 'previous-round', votingOpen: false });
  const state = await fixture(page, { ideas: [sharedIdea(), history] });
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > tr')).toHaveCount(1);
  const publicReply = gate();
  const ideasReply = gate();
  state.holdNextPublic = publicReply;
  state.holdNextIdeas = ideasReply;
  await page.locator('#ideas-include-closed').check();
  await Promise.all([publicReply.began, ideasReply.began]);
  await page.locator('#ideas-include-closed').uncheck();
  await expect(page.locator('#ideas-list > tr')).toHaveCount(1);
  await expect(page.locator('#community-feed-list > *')).toHaveCount(1);
  publicReply.release();
  ideasReply.release();
  await page.clock.runFor(100);
  await expect(page.locator('#ideas-list [data-public-id="public-idea-2"]')).toHaveCount(0);
  await expect(page.locator('#community-feed-list [data-public-id="public-idea-2"]')).toHaveCount(0);
  await expect(page.locator('#ideas-include-closed')).not.toBeChecked();
  await expect(page.locator('#ideas-panel')).toHaveAttribute('aria-busy', 'false');
  expect(state.actions).toHaveLength(0);
});

test('temporarily non-votable current ideas appear only with Show all ideas and stay read-only', async ({ page }) => {
  const idea = sharedIdea(1, { votingOpen: false });
  const state = await fixture(page, { ideas: [idea] });
  await expect(page.locator('#community-feed-list > *')).toHaveCount(0);
  await expect(page.locator('#community-feed-status')).toHaveText('No ideas open for voting right now.');
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > tr')).toHaveCount(0);
  await expect(page.locator('#ideas-table')).toBeHidden();
  await page.locator('#ideas-include-closed').check();
  await expect(page.locator('#ideas-list > tr')).toHaveCount(1);
  await expect(page.locator('#ideas-list [data-direction="up"]')).toBeDisabled();
  await expect(page.locator('#ideas-list [data-direction="down"]')).toBeDisabled();
  await page.locator('#ideas-list .community-read').click();
  await expect(page.locator('#idea-body')).toHaveText(idea.body);
  expect(state.actions).toHaveLength(0);
  expect(state.loginCalls).toBe(0);
});

test('all ideas paginates 24 records, sorts on the server and preserves reader focus, language and IME drafts', async ({ page }) => {
  const ideas = manyIdeas();
  ideas[24].body = '<img src=x onerror=window.untrustedIdea=true> Exact source\n& preserved whitespace.';
  ideas[29].upvotes = 10;
  const state = await fixture(page, { ideas, mainLimit: 6 });
  const draft = '조합 중인 미전송 초안';
  await page.locator('#prompt').fill(draft);
  await page.locator('#prompt').dispatchEvent('compositionstart');
  await expect(page.locator('#community-feed-list > *')).toHaveCount(3);
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  await expect(page.locator('#ideas-total')).toHaveText('30 ideas');
  expect(state.ideasReads[0]).toMatchObject({ sort: 'recent', offset: 0, limit: 24, language: 'en' });
  await page.locator('#ideas-next').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(6);
  await expect(page.locator('#ideas-page')).toHaveText('2 / 2');
  const read = page.locator('#ideas-list [data-public-id="public-idea-25"] .community-read');
  await read.click();
  await expect(page.locator('#idea-body')).toHaveText(ideas[24].body);
  await expect(page.locator('#idea-body img')).toHaveCount(0);
  expect(await page.evaluate(() => window.untrustedIdea)).toBeUndefined();
  const reads = state.ideasReads.length;
  await page.locator('#idea-language-select').selectOption('ko');
  await expect(page.locator('#idea-title')).toHaveText('제안 원문');
  await expect(page.locator('#idea-body')).toHaveText(ideas[24].body);
  expect(state.ideasReads).toHaveLength(reads);
  await page.keyboard.press('Escape');
  await expect(page.locator('#ideas-dialog')).toBeVisible();
  await expect(read).toBeFocused();
  await page.locator('#ideas-popular-tab').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  await expect(page.locator('#ideas-list > *').first()).toHaveAttribute('data-public-id', 'public-idea-30');
  expect(state.ideasReads.at(-1)).toMatchObject({ sort: 'popular', offset: 0, limit: 24, language: 'ko' });
  await page.locator('#ideas-popular-tab').press('Home');
  await expect(page.locator('#ideas-recent-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ideas-list > *').first()).toHaveAttribute('data-public-id', 'public-idea-1');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ideas-dialog')).toBeHidden();
  await expect(page.locator('#open-ideas')).toBeFocused();
  await expect(page.locator('#ideas-list > *')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue(draft);
  await expect(page.locator('#submit-button')).toBeDisabled();
  await page.locator('#prompt').dispatchEvent('compositionend');
  await expect(page.locator('#submit-button')).toBeEnabled();
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(0);
  expect(state.actions).toHaveLength(0);
});

test('all ideas votes outside the main feed share quotas and use public IDs to block only the owner', async ({ page }) => {
  const ideas = manyIdeas();
  ideas[24].author.alias = ALIAS;
  ideas[25].author = { id: 'public-profile-a', alias: ALIAS };
  const state = await fixture(page, { session: structuredClone(accountA), ideas, mainLimit: 6 });
  await page.locator('#prompt').fill('This draft must not be submitted by voting.');
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  await page.locator('#ideas-next').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(6);
  const own = page.locator('#ideas-list [data-public-id="public-idea-26"]');
  await expect(own.locator('.own-idea-badge')).toHaveText('My idea');
  await expect(own.locator('[data-direction="up"]')).toBeDisabled();
  await expect(own.locator('[data-direction="down"]')).toBeDisabled();
  await expect(own.locator('[data-direction="up"]')).toHaveAccessibleDescription("You can't vote on your own idea.");
  await own.locator('[data-direction="up"]').evaluate(button => { button.disabled = false; button.click(); });
  expect(state.actions).toHaveLength(0);
  const other = page.locator('#ideas-list [data-public-id="public-idea-25"]');
  await expect(other.locator('.own-idea-badge')).toHaveCount(0);
  const voteReply = gate();
  state.holdNextActionResponse = voteReply;
  await other.locator('[data-direction="up"]').click();
  await voteReply.began;
  await own.locator('.community-read').click();
  voteReply.release();
  await expect(other.locator('[data-direction="up"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#idea-dialog')).toBeVisible();
  await expect(page.locator('#idea-body')).toHaveText(ideas[25].body);
  await page.locator('#close-idea').click();
  await expect(own.locator('.community-read')).toBeFocused();
  await expect(page.locator('#ideas-vote-note')).toContainText('2 / 3');
  await expect(page.locator('#community-vote-note')).toContainText('2 / 3');
  expect(state.actions[0]).toMatchObject({ csrf: accountA.csrfToken,
    payload: { action: 'vote', publicId: 'public-idea-25', direction: 'up', proposalRevision: 1, publicationRevision: 1 } });
  await other.locator('[data-direction="up"]').click();
  await expect(other.locator('[data-direction="up"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#ideas-vote-note')).toContainText('3 / 3');
  expect(state.actions[1].payload.direction).toBe('none');
  await page.locator('#ideas-prev').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  await page.locator('#ideas-list [data-public-id="public-idea-1"] [data-direction="down"]').click();
  await expect(page.locator('#ideas-list [data-public-id="public-idea-1"] [data-direction="down"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#community-feed-list [data-public-id="public-idea-1"] [data-direction="down"]')).toHaveAttribute('aria-pressed', 'true');
  expect(state.actions).toHaveLength(3);
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(0);
});

test('all ideas guest voting can cancel or log in without queuing a vote or a submission', async ({ page }) => {
  const state = await fixture(page, { ideas: manyIdeas(), mainLimit: 6 });
  await page.locator('#prompt').fill('A draft remains separate from logging in to vote.');
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  await page.locator('#ideas-next').click();
  const up = page.locator('#ideas-list [data-public-id="public-idea-25"] [data-direction="up"]');
  await up.click();
  await expect(page.locator('#login-dialog')).toBeVisible();
  await page.locator('#login-language-select').selectOption('ko');
  await page.locator('#close-login').click();
  await expect(page.locator('#ideas-dialog')).toBeVisible();
  await expect(up).toBeFocused();
  expect(state.loginCalls).toBe(0);
  await up.click();
  await page.getByRole('button', { name: 'Google 테스트 로그인', exact: true }).click();
  await expect(page.locator('#login-dialog')).toBeHidden();
  await expect(page.locator('#ideas-dialog')).toBeHidden();
  await expect(page.locator('#ideas-list > *')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue('A draft remains separate from logging in to vote.');
  expect(await page.evaluate(() => sessionStorage.getItem('yourgame.pending.v1'))).toBeNull();
  expect(state.actions).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  await page.locator('#ideas-next').click();
  await up.click();
  await expect(up).toHaveAttribute('aria-pressed', 'true');
  expect(state.actions).toHaveLength(1);
});

test('all ideas ignores late sort and closed-page replies and rejects detached vote callbacks', async ({ page }) => {
  const held = gate();
  const ideas = manyIdeas();
  ideas[29].upvotes = 10;
  const state = await fixture(page, { session: structuredClone(accountA), ideas, mainLimit: 6, holdNextIdeas: held });
  await page.locator('#open-ideas').click();
  await held.began;
  await page.locator('#ideas-popular-tab').click();
  await expect(page.locator('#ideas-list > *').first()).toHaveAttribute('data-public-id', 'public-idea-30');
  held.release();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#ideas-popular-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ideas-list > *').first()).toHaveAttribute('data-public-id', 'public-idea-30');
  await page.locator('#ideas-list [data-public-id="public-idea-30"] [data-direction="up"]').evaluate(button => { window.oldIdeasVote = button; });
  state.ideas[29].proposalRevision = 2;
  state.ideas[29].publicationRevision = 2;
  state.ideas[29].body = 'A new revision must not inherit a click on the previous source.';
  const refreshing = gate();
  state.holdNextIdeas = refreshing;
  await page.locator('#ideas-refresh').click();
  await refreshing.began;
  await page.evaluate(() => { window.oldIdeasVote.disabled = false; window.oldIdeasVote.click(); });
  expect(state.actions).toHaveLength(0);
  refreshing.release();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  await page.evaluate(() => window.oldIdeasVote.click());
  expect(state.actions).toHaveLength(0);
  const closing = gate();
  state.holdNextIdeas = closing;
  await page.locator('#ideas-refresh').click();
  await closing.began;
  await page.locator('#close-ideas').click();
  state.ideas = manyIdeas(2);
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-total')).toHaveText('2 ideas');
  closing.release();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#ideas-list > *')).toHaveCount(2);
  expect(state.actions).toHaveLength(0);
});

test('all ideas withdraws reader content, recovers a shrinking page and closes on account changes', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), ideas: manyIdeas(50), mainLimit: 6 });
  await page.locator('#prompt').fill('An account change must preserve this unsent draft.');
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  await page.locator('#ideas-next').click();
  await expect(page.locator('#ideas-page')).toHaveText('2 / 3');
  state.ideas = manyIdeas(10);
  await page.locator('#ideas-refresh').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(10);
  expect(state.ideasReads.slice(-2).map(read => read.offset)).toEqual([24, 0]);
  await page.locator('#ideas-list .community-read').first().click();
  await expect(page.locator('#idea-dialog')).toBeVisible();
  state.ideas = [];
  await page.clock.runFor(46000);
  await expect(page.locator('#idea-dialog')).toBeHidden();
  await expect(page.locator('#idea-body')).toHaveText('');
  await expect(page.locator('#ideas-total')).toHaveText('0 ideas');
  state.ideasFailure = true;
  await page.locator('#ideas-refresh').click();
  await expect(page.locator('#ideas-retry')).toBeVisible();
  await expect(page.locator('#ideas-list > *')).toHaveCount(0);
  await expect(page.locator('#ideas-status')).not.toContainText('PRIVATE_INTERNAL_EVIDENCE');
  await page.locator('#ideas-language-select').selectOption('ko');
  await expect(page.locator('#ideas-status')).toContainText('불러오지 못했습니다');
  state.ideasFailure = false;
  state.ideas = manyIdeas();
  await page.locator('#ideas-retry').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  const accountRead = gate();
  state.holdNextIdeas = accountRead;
  await page.locator('#ideas-refresh').click();
  await accountRead.began;
  state.session = structuredClone(accountB);
  state.me = privateCommunity(accountB);
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'yourgame.auth-pulse.v1', newValue: 'next-account' })));
  await expect(page.locator('#ideas-dialog')).toBeHidden();
  accountRead.release();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#ideas-list > *')).toHaveCount(0);
  await expect(page.locator('#my-rank-alias')).toHaveText(ALIAS_B);
  await expect(page.locator('#prompt')).toHaveValue('An account change must preserve this unsent draft.');
  expect(state.actions).toHaveLength(0);
});

test('all ideas keeps the same unknown vote request across language changes and a rate-limited retry', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), ideas: manyIdeas(), mainLimit: 6 });
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  await page.locator('#ideas-next').click();
  state.malformedAfterNextCommit = true;
  const vote = page.locator('#ideas-list [data-public-id="public-idea-25"] [data-direction="up"]');
  await vote.click();
  await expect(page.locator('#ideas-action-retry')).toBeVisible();
  const first = structuredClone(state.actions[0].payload);
  await page.locator('#ideas-language-select').selectOption('ko');
  expect(state.actions).toHaveLength(1);
  state.nextActionError = { code: 'COMMUNITY_RATE_LIMITED', status: 429 };
  await page.locator('#ideas-action-retry').click();
  await expect(page.locator('#ideas-action-retry')).toBeEnabled();
  await expect(vote).toBeDisabled();
  expect(state.actions[1].payload).toEqual(first);
  await page.locator('#ideas-action-retry').click();
  await expect(page.locator('#ideas-action-retry')).toBeHidden();
  await expect(vote).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#ideas-vote-note')).toContainText('2 / 3');
  expect(state.actions.map(action => action.payload)).toEqual([first, first, first]);
  expect(state.effects).toHaveLength(1);
  expect(state.posts).toHaveLength(0);
});

test('all ideas rejects inconsistent pagination and still reads closed proposals with no round', async ({ page }) => {
  const state = await fixture(page, { ideas: manyIdeas(3), mainLimit: 6 });
  for (const corrupt of [
    data => ({ ...data, sort: 'popular' }),
    data => ({ ...data, offset: 24 }),
    data => ({ ...data, items: data.items.slice(0, 2) }),
    data => ({ ...data, items: [data.items[0], data.items[0], data.items[2]] }),
    data => ({ ...data, hasMore: true }),
    data => ({ ...data, limit: 50 }),
  ]) {
    state.ideasTransform = corrupt;
    await page.locator('#open-ideas').click();
    await expect(page.locator('#ideas-status')).toHaveAttribute('data-kind', 'error');
    await expect(page.locator('#ideas-list > *')).toHaveCount(0);
    await expect(page.locator('#ideas-next')).toBeDisabled();
    await page.locator('#close-ideas').click();
  }
  state.ideasTransform = null;
  state.round = null;
  state.ideas = manyIdeas(1).map(idea => ({ ...idea, roundId: null, votingOpen: false }));
  await page.locator('#community-include-closed').check();
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(1);
  await expect(page.locator('#ideas-list [data-direction="up"]')).toBeDisabled();
  await page.locator('#ideas-list .community-read').click();
  await expect(page.locator('#idea-body')).toHaveText(state.ideas[0].body);
  await page.keyboard.press('Escape');
  await page.mouse.click(1, 1);
  await expect(page.locator('#ideas-dialog')).toBeHidden();
  await expect(page.locator('#open-ideas')).toBeFocused();
  expect(state.actions).toHaveLength(0);
});

test('all ideas background checks preserve unchanged reading and clear it on a failed or changed response', async ({ page }) => {
  const ideas = manyIdeas();
  ideas[24].body = 'A long source for uninterrupted reading.\n'.repeat(40);
  const state = await fixture(page, { session: structuredClone(accountA), ideas, mainLimit: 6 });
  await page.locator('#open-ideas').click();
  await expect(page.locator('#ideas-list > *')).toHaveCount(24);
  await page.locator('#ideas-next').click();
  await page.locator('#ideas-list [data-public-id="public-idea-25"] .community-read').click();
  await page.locator('#idea-dialog').evaluate(dialog => { dialog.scrollTop = 200; });
  const scroll = await page.locator('#idea-dialog').evaluate(dialog => dialog.scrollTop);
  const unchanged = gate();
  state.holdNextIdeas = unchanged;
  // The periodic refresh has no earlier held request that could time out.
  await page.clock.runFor(46000);
  await unchanged.began;
  await expect(page.locator('#idea-dialog')).toBeVisible();
  await expect(page.locator('#idea-body')).toHaveText(ideas[24].body);
  await expect(page.locator('#ideas-list > *')).toHaveCount(0);
  unchanged.release();
  await expect(page.locator('#ideas-list > *')).toHaveCount(6);
  await expect(page.locator('#idea-dialog')).toBeVisible();
  expect(await page.locator('#idea-dialog').evaluate(dialog => dialog.scrollTop)).toBe(scroll);
  state.ideasFailure = true;
  await page.locator('#ideas-refresh').dispatchEvent('click');
  await expect(page.locator('#idea-dialog')).toBeHidden();
  await expect(page.locator('#idea-body')).toHaveText('');
  await expect(page.locator('#ideas-retry')).toBeVisible();
  state.ideasFailure = false;
  await page.locator('#ideas-retry').click();
  await page.locator('#ideas-list [data-public-id="public-idea-25"] .community-read').click();
  state.ideas[24] = { ...state.ideas[24], proposalRevision: 2, publicationRevision: 2, body: 'Changed public source.' };
  await page.locator('#ideas-refresh').dispatchEvent('click');
  await expect(page.locator('#idea-dialog')).toBeHidden();
  await expect(page.locator('#idea-body')).toHaveText('');
  await expect(page.locator('#ideas-list [data-public-id="public-idea-25"] .community-body')).toHaveText('Changed public source.');
  expect(state.actions).toHaveLength(0);
});

test('all ideas handles pending refresh coalescing without rendering an older page or keeping it after a public failure', async ({ page }) => {
  const held = gate();
  const state = await fixture(page, { ideas: manyIdeas(), mainLimit: 6, holdNextIdeas: held });
  await page.locator('#open-ideas').click();
  await held.began;
  const beforePublic = state.publicReads;
  const beforeIdeas = state.ideasReads.length;
  state.ideas = manyIdeas(4);
  await page.locator('#community-refresh').dispatchEvent('click');
  await expect.poll(() => state.publicReads).toBeGreaterThan(beforePublic);
  expect(state.ideasReads).toHaveLength(beforeIdeas);
  const fresh = gate();
  state.holdNextIdeas = fresh;
  held.release();
  await fresh.began;
  await expect(page.locator('#ideas-list > *')).toHaveCount(0);
  fresh.release();
  await expect(page.locator('#ideas-list > *')).toHaveCount(4);
  expect(state.ideasReads).toHaveLength(beforeIdeas + 1);
  state.publicFailure = true;
  await page.locator('#ideas-refresh').click();
  await expect(page.locator('#ideas-retry')).toBeVisible();
  await expect(page.locator('#ideas-list > *')).toHaveCount(0);
  await expect(page.locator('#ideas-next')).toBeDisabled();
  expect(state.actions).toHaveLength(0);
});

test('all ideas fits long data in desktop and mobile dialogs while the three-card main page remains compact', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const me = privateCommunity(accountA);
  me.profile.alias = '아주긴공개별명을가진참여자입니다길이검사'.slice(0, 24);
  const ideas = manyIdeas(50).map((idea, index) => ({ ...idea, body: 'A long public idea with details. '.repeat(60),
    author: { id: index === 0 ? me.profile.id : idea.author.id, alias: me.profile.alias } }));
  const state = await fixture(page, { session: { ...structuredClone(accountA), user: { ...accountA.user, name: 'SYNTHETIC_LONG_NAME_'.repeat(10) } },
    me, ideas, mainLimit: 6, leaders: rankedPlayers(10), proposals: [ownIdea()] });
  const errors = [];
  page.on('pageerror', error => errors.push(error.name));
  for (const locale of ['en', 'ko']) {
    await page.locator('#language-select').selectOption(locale);
    for (const [width, height] of [[1280, 720], [1366, 768], [1440, 810], [1600, 900], [1920, 1080], [320, 740], [360, 780], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.clock.runFor(50);
      if (width >= 1280) await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      const mainGeometry = await page.evaluate(() => {
        const header = document.querySelector('.masthead').getBoundingClientRect();
        const controls = [...document.querySelectorAll('.masthead button,.masthead a,.masthead select')]
          .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height);
        const more = document.getElementById('open-ideas').getBoundingClientRect();
        const essentials = [...document.querySelectorAll('.game-preview,.community-section,#prompt-form,.contribution-board,.process-section')].map(element => element.getBoundingClientRect());
        return { horizontal: document.documentElement.scrollWidth <= innerWidth + 1,
          essentials: essentials.every(rect => rect.bottom <= innerHeight + 1),
          header: controls.every(rect => rect.top >= header.top && rect.bottom <= header.bottom + 1),
          touch: more.width >= 44 && more.height >= 44 };
      });
      expect(mainGeometry.horizontal, locale + ' ' + width).toBe(true);
      expect(mainGeometry.header, locale + ' ' + width).toBe(true);
      expect(mainGeometry.touch, locale + ' ' + width).toBe(true);
      if (width >= 1280) expect(mainGeometry.essentials, locale + ' ' + width).toBe(true);
      await expect(page.locator('#community-feed-list > *')).toHaveCount(3);
      if ([1366, 1440, 390].includes(width)) await page.screenshot({ path: testInfo.outputPath('ideas-main-' + locale + '-' + width + '.png'), fullPage: width < 800 });
      await page.locator('#open-ideas').click();
      await expect(page.locator('#ideas-list > *')).toHaveCount(24);
      const modalGeometry = await page.locator('#ideas-dialog').evaluate(dialog => {
        const rect = dialog.getBoundingClientRect();
        const panel = document.getElementById('ideas-panel');
        const list = document.getElementById('ideas-list');
        const buttons = [...dialog.querySelectorAll('button,select')].filter(element => element.getClientRects().length);
        return { inside: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight + 1,
          noOverflow: dialog.scrollWidth <= dialog.clientWidth + 1 && panel.scrollWidth <= panel.clientWidth + 1,
          scrolls: panel.scrollHeight > panel.clientHeight,
          nativeTable: list.tagName === 'TBODY' && [...list.children].every(row => row.tagName === 'TR' && row.cells.length === 2),
          visibleRows: [...list.children].filter(row => { const bounds = row.getBoundingClientRect();
            return bounds.top >= panel.getBoundingClientRect().top + 36 && bounds.bottom <= panel.getBoundingClientRect().bottom; }).length,
          targets: buttons.every(element => { const target = element.getBoundingClientRect(); return target.width >= 44 && target.height >= 44; }) };
      });
      expect(modalGeometry.inside, locale + ' ' + width).toBe(true);
      expect(modalGeometry.noOverflow, locale + ' ' + width).toBe(true);
      expect(modalGeometry.scrolls, locale + ' ' + width).toBe(true);
      expect(modalGeometry.targets, locale + ' ' + width).toBe(true);
      expect(modalGeometry.nativeTable).toBe(true);
      expect(modalGeometry.visibleRows, locale + ' ' + width).toBeGreaterThanOrEqual(width >= 1280 ? 7 : 4);
      const lastRead = page.locator('#ideas-list .community-read').last();
      await lastRead.scrollIntoViewIfNeeded();
      expect(await page.locator('.ideas-dialog-footer').evaluate(element => element.getBoundingClientRect().bottom <= innerHeight + 1)).toBe(true);
      await lastRead.click();
      await expect(page.locator('#idea-dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(lastRead).toBeFocused();
      await page.locator('#ideas-panel').evaluate(element => { element.scrollTop = 0; });
      if ([1366, 1440, 390].includes(width)) await page.locator('#ideas-dialog').screenshot({ path: testInfo.outputPath('ideas-dialog-' + locale + '-' + width + '.png') });
      await page.locator('#close-ideas').click();
      await expect(page.locator('#open-ideas')).toBeFocused();
    }
  }
  expect(errors).toEqual([]);
  expect(state.actions).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
});

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

function rankedPlayers(count) {
  return Array.from({ length: count }, (_, index) => ({ rank: index + 1,
    author: { id: 'ranked-profile-' + index, alias: 'Player-' + (index + 100).toString(16).padStart(12, '0') },
    points: String(1000 - index), adoptedCount: index % 3 }));
}

test('the top five keep shared ranks and repeat my own public rank separately', async ({ page }) => {
  const me = privateCommunity(accountA);
  me.profile.alias = 'Shared display name';
  me.contribution.points = '998';
  const leaders = rankedPlayers(8);
  leaders[1].rank = 1;
  leaders[2].author = { id: me.profile.id, alias: me.profile.alias };
  const state = await fixture(page, { session: structuredClone(accountA), me, leaders });
  await expect(page.locator('#leaderboard-list .leaderboard-rank')).toHaveText(['1', '1', '3', '4', '5']);
  await expect(page.locator('#leaderboard-list .leaderboard-entry')).toHaveCount(5);
  await expect(page.locator('#leaderboard-list [data-author-id="public-profile-a"]')).toHaveCount(1);
  await expect(page.locator('#my-rank-value')).toHaveText('3');
  await expect(page.locator('#my-rank-alias')).toHaveText(me.profile.alias);
  await expect(page.locator('#my-rank-points')).toHaveText('998');
  await expect(page.locator('.contribution-board')).not.toContainText(accountA.user.name);
  state.me.profile.leaderboardVisible = false;
  await refreshCommunity(page);
  await expect(page.locator('#my-rank-value')).toHaveText('—');
  await expect(page.locator('#my-rank-status')).toContainText('Not currently');
  await expect(page.locator('#my-rank-alias')).toHaveText(me.profile.alias);
  await page.locator('#logout-button').click();
  await expect(page.locator('#my-contribution')).toBeHidden();
  await expect(page.locator('#my-rank-alias')).toHaveText('');
  await expect(page.locator('#my-rank-points')).toHaveText('');
  await expect(page.locator('#my-rank-guest')).toBeVisible();
  const target = await page.locator('#my-rank-login').boundingBox();
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
});

test('My idea badges and self-vote protection use public IDs even when names match', async ({ page }) => {
  const me = privateCommunity(accountA);
  me.profile.alias = 'Same Name';
  const state = await fixture(page, { session: structuredClone(accountA), me, proposals: [ownIdea()],
    ideas: [sharedIdea(1, { author: { id: 'another-public-profile', alias: 'Same Name' } })] });
  const mine = page.locator('[data-public-id="public-owned-private-idea-a"]');
  const other = page.locator('[data-public-id="public-idea-1"]');
  await expect(mine.locator('.own-idea-badge')).toHaveText('My idea');
  await expect(other.locator('.own-idea-badge')).toHaveCount(0);
  for (const direction of ['up', 'down']) {
    const button = mine.locator('[data-direction="' + direction + '"]');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription("You can't vote on your own idea.");
    await button.evaluate(element => { element.disabled = false; element.click(); });
  }
  expect(state.actions).toHaveLength(0);
  await other.locator('[data-direction="up"]').click();
  await expect.poll(() => state.actions.length).toBe(1);
  expect(state.actions[0].payload.publicId).toBe('public-idea-1');
  await page.locator('#language-select').selectOption('ko');
  await expect(mine.locator('.own-idea-badge')).toHaveText('내 의견');
  await expect(mine.locator('[data-direction="up"]')).toHaveAccessibleDescription('내 의견에는 투표할 수 없습니다.');
});

test('anonymous full ranking paginates on the server and preserves locale, draft and dialog focus', async ({ page }) => {
  const leaders = rankedPlayers(27);
  const state = await fixture(page, { leaders });
  await page.locator('#prompt').fill('Keep this idea while browsing rankings.');
  await page.locator('#open-leaderboard').click();
  await expect(page.locator('#leaderboard-full-list .leaderboard-entry')).toHaveCount(20);
  await expect(page.locator('#leaderboard-total')).toHaveText('27 participants');
  expect(state.leaderboardReads).toEqual([{ offset: 0, limit: 20 }]);
  await expect(page.locator('#leaderboard-full-prev')).toBeDisabled();
  await page.locator('#leaderboard-full-next').click();
  await expect(page.locator('#leaderboard-full-list .leaderboard-rank')).toHaveText(['21', '22', '23', '24', '25', '26', '27']);
  await expect(page.locator('#leaderboard-full-next')).toBeDisabled();
  const reads = state.leaderboardReads.length;
  await page.locator('#leaderboard-language-select').selectOption('ko');
  await expect(page.locator('#leaderboard-total')).toHaveText('참여자 27명');
  await expect(page.locator('#leaderboard-full-list .community-alias')).toHaveText(leaders.slice(20).map(row => row.author.alias));
  expect(state.leaderboardReads).toHaveLength(reads);
  await page.keyboard.press('Escape');
  await expect(page.locator('#leaderboard-dialog')).toBeHidden();
  await expect(page.locator('#leaderboard-full-list > *')).toHaveCount(0);
  await expect(page.locator('#open-leaderboard')).toBeFocused();
  await expect(page.locator('#prompt')).toHaveValue('Keep this idea while browsing rankings.');
  await page.locator('#open-leaderboard').click();
  await expect(page.locator('#leaderboard-full-list .leaderboard-entry')).toHaveCount(20);
  const rect = await page.locator('#leaderboard-dialog').boundingBox();
  await page.mouse.click(rect.x - 3, rect.y + 5);
  await expect(page.locator('#leaderboard-dialog')).toBeHidden();
  await expect(page.locator('#open-leaderboard')).toBeFocused();
  expect(state.loginCalls).toBe(0);
  expect(state.actions).toHaveLength(0);
  expect(state.posts).toHaveLength(0);
});

test('open rankings refresh withdrawn rows, recover a shrunken last page and discard read failures', async ({ page }) => {
  const state = await fixture(page, { leaders: rankedPlayers(27) });
  await page.locator('#open-leaderboard').click();
  await expect(page.locator('#leaderboard-full-list .leaderboard-entry')).toHaveCount(20);
  await page.locator('#leaderboard-full-next').click();
  await expect(page.locator('#leaderboard-full-page')).toHaveText('2 / 2');
  state.leaders = state.leaders.slice(0, 19);
  await page.clock.runFor(46000);
  await expect(page.locator('#leaderboard-full-page')).toHaveText('1 / 1');
  await expect(page.locator('#leaderboard-total')).toHaveText('19 participants');
  await expect(page.locator('#leaderboard-full-list .leaderboard-entry')).toHaveCount(19);
  expect(state.leaderboardReads.slice(-2)).toEqual([{ offset: 20, limit: 20 }, { offset: 0, limit: 20 }]);
  state.publicFailure = true;
  await page.clock.runFor(46000);
  await expect(page.locator('#leaderboard-full-list > *')).toHaveCount(0);
  await expect(page.locator('#leaderboard-full-status')).toContainText("Couldn't load");
  await expect(page.locator('#leaderboard-full-retry')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('PRIVATE_INTERNAL_EVIDENCE');
  state.publicFailure = false;
  state.leaderboardFailure = true;
  await page.locator('#leaderboard-full-retry').click();
  await expect(page.locator('#leaderboard-full-retry')).toBeEnabled();
  await expect(page.locator('#leaderboard-full-list > *')).toHaveCount(0);
  state.leaderboardFailure = false;
  state.leaders = [];
  await page.locator('#leaderboard-full-retry').click();
  await expect(page.locator('#leaderboard-total')).toHaveText('0 participants');
  await expect(page.locator('#leaderboard-full-list > *')).toHaveCount(0);
  await expect(page.locator('#leaderboard-full-status')).toBeVisible();
  expect(state.actions).toHaveLength(0);
});

test('late ranking responses and malformed page metadata cannot replace the current dialog', async ({ page }) => {
  const held = gate();
  const state = await fixture(page, { leaders: rankedPlayers(25), holdNextLeaderboard: held });
  await page.locator('#open-leaderboard').click();
  await held.began;
  await page.locator('#close-leaderboard').click();
  state.leaders = rankedPlayers(3);
  await page.locator('#open-leaderboard').click();
  await expect(page.locator('#leaderboard-total')).toHaveText('3 participants');
  held.release();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#leaderboard-full-list .leaderboard-entry')).toHaveCount(3);
  await expect(page.locator('#leaderboard-total')).toHaveText('3 participants');
  await page.locator('#close-leaderboard').click();
  const olderRead = gate();
  state.holdNextLeaderboard = olderRead;
  await page.locator('#open-leaderboard').click();
  await olderRead.began;
  const beforeRefresh = state.leaderboardReads.length;
  const beforePublicRefresh = state.publicReads;
  state.leaders = rankedPlayers(2);
  // Exercise a refresh while the first read is pending, without expiring its
  // 18-second request timeout. Periodic withdrawal/shrink has a separate test.
  await page.locator('#community-refresh').dispatchEvent('click');
  await expect.poll(() => state.publicReads).toBeGreaterThan(beforePublicRefresh);
  expect(state.leaderboardReads).toHaveLength(beforeRefresh);
  const latestRead = gate();
  state.holdNextLeaderboard = latestRead;
  olderRead.release();
  await latestRead.began;
  await expect(page.locator('#leaderboard-full-list > *')).toHaveCount(0);
  latestRead.release();
  await expect(page.locator('#leaderboard-total')).toHaveText('2 participants');
  expect(state.leaderboardReads).toHaveLength(beforeRefresh + 1);
  state.leaders = rankedPlayers(3);
  for (const corrupt of [
    data => ({ ...data, hasMore: true }),
    data => ({ ...data, items: data.items.slice(0, 2) }),
    data => ({ ...data, items: [data.items[0], data.items[0], data.items[2]] }),
    data => ({ ...data, items: [data.items[2], data.items[1], data.items[0]] }),
    data => ({ ...data, items: [{ ...data.items[0], rank: 4 }, ...data.items.slice(1)] }),
  ]) {
    await page.locator('#close-leaderboard').click();
    state.leaderboardTransform = corrupt;
    await page.locator('#open-leaderboard').click();
    await expect(page.locator('#leaderboard-full-status')).toHaveAttribute('data-kind', 'error');
    await expect(page.locator('#leaderboard-full-list > *')).toHaveCount(0);
    await expect(page.locator('#leaderboard-full-next')).toBeDisabled();
    await expect(page.locator('#leaderboard-full-retry')).toBeVisible();
  }
});

test('changing a public name normalizes its payload and updates an open reader without touching the idea draft or IME', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), proposals: [ownIdea()] });
  const draft = '조합 중인 제안 초안은 별명과 별개입니다.';
  await page.locator('#prompt').fill(draft);
  await page.locator('#prompt').dispatchEvent('compositionstart');
  await page.locator('#edit-alias').click();
  await expect(page.locator('#alias-input')).toHaveValue(ALIAS);
  await expect(page.locator('#alias-dialog')).not.toContainText(accountA.user.name);
  const raw = '  Cafe\u0301 Hero  ';
  await page.locator('#alias-input').fill(raw);
  await page.locator('#alias-input').dispatchEvent('compositionstart');
  await page.locator('#alias-form').evaluate(form => form.requestSubmit());
  expect(state.actions).toHaveLength(0);
  await page.locator('#alias-language-select').selectOption('ko');
  await expect(page.locator('#alias-input')).toHaveValue(raw);
  await expect(page.locator('#alias-save')).toBeDisabled();
  await page.locator('#alias-input').dispatchEvent('compositionend');
  const held = gate();
  state.holdNextActionResponse = held;
  await page.locator('#alias-save').click();
  await held.began;
  await page.locator('#close-alias').click();
  await page.locator('[data-public-id="public-owned-private-idea-a"] .community-read').click();
  await expect(page.locator('#idea-dialog')).toBeVisible();
  held.release();
  await expect(page.locator('#idea-author')).toContainText('Café Hero');
  await expect(page.locator('#idea-dialog')).toBeVisible();
  await expect(page.locator('#idea-body')).toHaveText(state.proposals[0].body);
  await expect(page.locator('#my-rank-alias')).toHaveText('Café Hero');
  await expect(page.locator('#leaderboard-list .community-alias')).toHaveText('Café Hero');
  await expect(page.locator('#prompt')).toHaveValue(draft);
  await expect(page.locator('#submit-button')).toBeDisabled();
  expect(state.actions).toHaveLength(1);
  expect(state.actions[0].payload).toMatchObject({ action: 'set_profile_alias', alias: 'Café Hero', revision: 1 });
  expect(state.actions[0].language).toBe('ko');
  expect(state.posts).toHaveLength(0);
  expect(state.patches).toHaveLength(0);
  expect(await page.evaluate(() => sessionStorage.getItem('yourgame.pending.v1'))).toBeNull();
  await page.locator('#close-idea').click();
  await page.locator('#prompt').dispatchEvent('compositionend');
  await expect(page.locator('#submit-button')).toBeEnabled();
  await page.locator('#open-leaderboard').click();
  await expect(page.locator('#leaderboard-full-list .community-alias')).toHaveText('Café Hero');
});

test('invalid names never send and profile conflicts preserve the draft until explicit refresh', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA) });
  await page.locator('#edit-alias').click();
  for (const value of ['<img src=x>', 'A\u200bB', 'A'.repeat(25)]) {
    await page.locator('#alias-input').fill(value);
    await expect(page.locator('#alias-input')).toHaveAttribute('aria-invalid', 'true');
    await page.locator('#alias-form').evaluate(form => form.requestSubmit());
  }
  expect(state.actions).toHaveLength(0);
  await page.locator('#alias-input').fill('My chosen name');
  state.nextActionError = { code: 'INVALID_PROFILE_ALIAS', status: 422 };
  await page.locator('#alias-save').click();
  await expect(page.locator('#alias-message')).toContainText('2–24');
  await expect(page.locator('#alias-input')).toHaveValue('My chosen name');
  state.nextActionError = { code: 'COMMUNITY_REVISION_CONFLICT', status: 409,
    change() { state.me.profile.alias = 'Another session'; state.me.profile.revision = 2; } };
  await page.locator('#alias-save').click();
  await expect(page.locator('#alias-current')).toContainText('Another session');
  await expect(page.locator('#alias-input')).toHaveValue('My chosen name');
  await expect(page.locator('#alias-save')).toBeDisabled();
  await page.locator('#alias-form').evaluate(form => form.requestSubmit());
  expect(state.actions).toHaveLength(2);
  await page.locator('#alias-reload').click();
  await expect(page.locator('#alias-save')).toBeEnabled();
  await expect(page.locator('#alias-input')).toHaveValue('My chosen name');
  await page.locator('#alias-save').click();
  await expect(page.locator('#alias-dialog')).toBeHidden();
  await expect(page.locator('#my-rank-alias')).toHaveText('My chosen name');
  expect(state.actions[2].payload.revision).toBe(2);
  expect(state.effects).toHaveLength(1);
  expect(state.posts).toHaveLength(0);
});

test('an unknown name change keeps the same request through locale changes and dialog reopen', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), malformedAfterNextCommit: true });
  await page.locator('#prompt').fill('Do not send this idea when confirming my name.');
  await page.locator('#edit-alias').click();
  await page.locator('#alias-input').fill('Kept request');
  await page.locator('#alias-save').click();
  await expect(page.locator('#alias-retry')).toBeVisible();
  await expect(page.locator('#alias-input')).toHaveValue('Kept request');
  await expect(page.locator('#alias-input')).toBeDisabled();
  const first = structuredClone(state.actions[0].payload);
  await page.locator('#alias-language-select').selectOption('ko');
  await expect(page.locator('#alias-retry')).toHaveText('같은 요청 결과 다시 확인');
  await page.locator('#close-alias').click();
  await page.locator('#edit-alias').click();
  await expect(page.locator('#alias-input')).toHaveValue('Kept request');
  state.nextActionError = { code: 'COMMUNITY_RATE_LIMITED', status: 429 };
  await page.locator('#alias-retry').click();
  await expect(page.locator('#alias-retry')).toBeEnabled();
  await expect(page.locator('#alias-input')).toBeDisabled();
  expect(state.actions[1].payload).toEqual(first);
  await page.locator('#alias-retry').click();
  await expect(page.locator('#alias-dialog')).toBeHidden();
  await expect(page.locator('#my-rank-alias')).toHaveText('Kept request');
  expect(state.actions[2].payload).toEqual(first);
  expect(state.effects).toHaveLength(1);
  expect(state.posts).toHaveLength(0);
  await expect(page.locator('#prompt')).toHaveValue('Do not send this idea when confirming my name.');
});

test('account changes close name and ranking dialogs and ignore late former-account responses', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), leaders: rankedPlayers(5) });
  const held = gate();
  state.holdNextActionResponse = held;
  await page.locator('#edit-alias').click();
  await page.locator('#alias-input').fill('Former account name');
  await page.locator('#alias-save').click();
  await held.began;
  state.session = structuredClone(accountB);
  state.me = privateCommunity(accountB);
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'yourgame.auth-pulse.v1', newValue: 'account-changed' })));
  await expect(page.locator('#alias-dialog')).toBeHidden();
  await expect(page.locator('#alias-input')).toHaveValue('');
  await expect(page.locator('#my-rank-alias')).toHaveText(ALIAS_B);
  held.release();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#my-rank-alias')).toHaveText(ALIAS_B);
  await expect(page.locator('#community-retry')).toBeHidden();
  const rankingHeld = gate();
  state.holdNextLeaderboard = rankingHeld;
  await page.locator('#open-leaderboard').click();
  await rankingHeld.began;
  state.session = structuredClone(anonymous);
  await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'yourgame.auth-pulse.v1', newValue: 'logged-out' })));
  await expect(page.locator('#leaderboard-dialog')).toBeHidden();
  rankingHeld.release();
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#leaderboard-full-list > *')).toHaveCount(0);
  await expect(page.locator('#my-rank-alias')).toHaveText('');
  await expect(page.locator('#my-rank-guest')).toBeVisible();
  expect(state.actions).toHaveLength(1);
});

test('long public names and large scores fit every desktop frame and narrow ranking dialog', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  const me = privateCommunity(accountA);
  me.profile.alias = '가'.repeat(24);
  me.contribution.points = '-' + '9'.repeat(130) + '.5';
  const leaders = rankedPlayers(25).map((row, index) => ({ ...row,
    author: { ...row.author, alias: '아주긴공개별명이화면밖으로넘치지않도록확인합니다'.slice(0, 24) },
    points: (BigInt('9'.repeat(130)) - BigInt(index)).toString() + '.5' }));
  const ideas = Array.from({ length: 6 }, (_, index) => sharedIdea(index + 1, {
    body: 'A long public idea. '.repeat(100), author: index === 0
      ? { id: me.profile.id, alias: me.profile.alias } : leaders[index].author,
  }));
  const state = await fixture(page, { session: { ...structuredClone(accountA), user: { ...accountA.user, name: 'PRIVATE_LONG_NAME_'.repeat(10) } },
    me, leaders, ideas, proposals: [ownIdea()] });
  for (const locale of ['en', 'ko']) {
    await page.locator('#language-select').selectOption(locale);
    for (const [width, height] of [[1280, 720], [1366, 768], [1600, 900], [1920, 1080], [320, 740], [360, 780], [390, 844]]) {
      await page.setViewportSize({ width, height });
      // Allow the test clock's animation frames and dynamic viewport units to settle.
      await page.clock.runFor(50);
      if (width >= 1280) await expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      const geometry = await page.evaluate(() => {
        const root = document.documentElement;
        const masthead = document.querySelector('.masthead').getBoundingClientRect();
        const headerTargets = [...document.querySelectorAll('.masthead button,.masthead select,.masthead a')]
          .map(element => element.getBoundingClientRect()).filter(rect => rect.width && rect.height);
        const essentials = [...document.querySelectorAll('.game-preview,.community-section,#prompt-form,.contribution-board,.process-section,.my-rank-slot')]
          .map(element => element.getBoundingClientRect());
        return { noHorizontalOverflow: root.scrollWidth <= root.clientWidth + 1,
          pageFits: root.scrollHeight <= innerHeight + 1,
          essentialsInside: essentials.every(rect => rect.top >= 0 && rect.bottom <= innerHeight + 1),
          headerOneLine: headerTargets.every(rect => rect.top >= masthead.top && rect.bottom <= masthead.bottom + 1),
          editTouch: document.querySelector('#edit-alias').getBoundingClientRect().width >= 44
            && document.querySelector('#edit-alias').getBoundingClientRect().height >= 44 };
      });
      expect(geometry.noHorizontalOverflow, locale + ' ' + width).toBe(true);
      expect(geometry.headerOneLine, locale + ' ' + width).toBe(true);
      expect(geometry.editTouch, locale + ' ' + width).toBe(true);
      if (width >= 1280) {
        expect(geometry.pageFits, locale + ' ' + width).toBe(true);
        expect(geometry.essentialsInside, locale + ' ' + width).toBe(true);
      }
      if ([1280, 1366, 320, 390].includes(width)) await page.screenshot({
        path: testInfo.outputPath('ranking-' + locale + '-' + width + '.png'), fullPage: width < 800 });
      await page.locator('#open-leaderboard').click();
      await expect(page.locator('#leaderboard-full-list .leaderboard-entry')).toHaveCount(20);
      expect(await page.locator('#leaderboard-dialog').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight + 1
          && element.scrollWidth <= element.clientWidth + 1;
      }), 'ranking modal ' + locale + ' ' + width).toBe(true);
      if (width === 390) await page.locator('#leaderboard-dialog').screenshot({ path: testInfo.outputPath('full-ranking-' + locale + '-390.png') });
      await page.locator('#close-leaderboard').click();
      await page.locator('#edit-alias').click();
      await expect(page.locator('#alias-input')).toHaveValue(me.profile.alias);
      expect(await page.locator('#alias-dialog').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight + 1
          && element.scrollWidth <= element.clientWidth + 1
          && parseFloat(getComputedStyle(document.getElementById('alias-input')).fontSize) >= 16;
      }), 'name dialog ' + locale + ' ' + width).toBe(true);
      if (width === 320) await page.locator('#alias-dialog').screenshot({ path: testInfo.outputPath('alias-' + locale + '-320.png') });
      await page.keyboard.press('Escape');
      await expect(page.locator('#alias-dialog')).toBeHidden();
      await expect(page.locator('#edit-alias')).toBeFocused();
    }
  }
  expect(state.actions).toHaveLength(0);
});

test('blank preview and empty feeds remain honest in the compact desktop and mobile layout', async ({ page }, testInfo) => {
  const state = await fixture(page);
  await expect(page.locator('#community-feed-status')).toHaveText('No ideas open for voting right now.');
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
  await expect(page.locator('#community-feed-status')).toHaveText('지금 투표할 수 있는 의견이 없습니다.');
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
  await expect(page.locator('#leaderboard-list .leaderboard-points')).toHaveText(me.contribution.points);
  await expect(page.locator('#my-rank-points')).toHaveText(me.contribution.points);
  await expect(page.locator('.contribution-board')).not.toContainText(accountA.user.name);
  await expect(page.locator('.community-section')).not.toContainText(accountA.user.name);
  await expect(page.locator('#leaderboard-privacy, #publication-dialog')).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('.contribution-board').screenshot({ path: testInfo.outputPath('contribution-exact-points-320.png') });
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#leaderboard-list .leaderboard-points')).toHaveText(me.contribution.points);
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
  await expect(page.locator('#community-feed-list > *')).toHaveCount(0);
  await page.locator('#community-include-closed').check();
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

test('unknown vote results retain the same request through history filters, a read outage and rotated CSRF token', async ({ page }) => {
  const state = await fixture(page, { session: structuredClone(accountA), ideas: [sharedIdea()], failAfterNextCommit: true });
  await page.locator('#prompt').fill('Draft kept while checking the original vote');
  await voteButton(page).click();
  await expect(page.locator('#community-retry')).toBeEnabled();
  await expect(page.locator('#community-feedback-message')).toContainText("Couldn't confirm");
  expect(state.effects).toHaveLength(1);
  state.publicFailure = true;
  state.meFailure = true;
  await page.locator('#community-include-closed').check();
  await expect(page.locator('#community-feed-panel')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#community-retry')).toBeEnabled();
  await refreshCommunity(page);
  await expect(page.locator('#community-retry')).toBeEnabled();
  await expect(page.locator('#community-feedback-message')).toContainText("Couldn't confirm");
  state.publicFailure = false;
  state.meFailure = false;
  await page.locator('#community-include-closed').uncheck();
  await expect(page.locator('#community-feed-panel')).toHaveAttribute('aria-busy', 'false');
  expect(state.actions).toHaveLength(1);
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
  await expect(page.locator('#community-include-closed')).not.toBeChecked();
  await expect(page.locator('#prompt')).toHaveValue('Draft kept while checking the original vote');
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
  await expect(page.locator('#leaderboard-list .leaderboard-points')).toHaveText('0');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('#my-contribution-summary')).toContainText('0');
  expect(state.me.contribution).toEqual({ points: '0', adoptedCount: 0, rank: 1 });
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

test('a populated desktop workspace fits 16:9 with the top five and a separate personal rank', async ({ page }, testInfo) => {
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
      await expect(page.locator('#leaderboard-list .leaderboard-entry')).toHaveCount(5);
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

for (const scenario of [
  { name: 'own idea', own: true, serverTime: START },
  { name: 'closed voting after 23:00 KST', own: false, serverTime: Date.parse(CLOSE) + 5 * 60000 },
  { name: 'delayed first release', own: false, serverTime: Date.parse(RELEASE) + 5 * 60000 },
]) {
  test(`${scenario.name} keeps the full desktop workspace visible with readable vote state`, async ({ page }, testInfo) => {
    test.setTimeout(60000);
    const body = 'Synthetic layout source text. '.repeat(80).slice(0, 2000);
    expect(new TextEncoder().encode(body).length).toBe(2000);
    const session = structuredClone(accountA);
    session.user.name = 'A long synthetic account name 긴 이름 '.repeat(10);
    session.user.isAdmin = true;
    const me = privateCommunity(session);
    if (!scenario.own) me.voteQuota = null;
    const ideas = Array.from({ length: scenario.own ? 5 : 6 }, (_, index) => sharedIdea(index + 1, {
      body, upvotes: 9876 + index, downvotes: 1234,
      votingOpen: scenario.own,
      // Frozen first-round ideas and waiting next-round ideas are both readable.
      roundId: scenario.own || index % 2 === 0 ? 'initial' : null,
    }));
    const leaders = Array.from({ length: 10 }, (_, index) => ({ rank: index + 1,
      author: { id: 'geometry-leader-' + index, alias: 'Player-' + (index + 100).toString(16).padStart(12, '0') },
      points: String(10000 - index * 11) + '.5', adoptedCount: 3,
    }));
    const state = await fixture(page, { session, me, ideas, leaders, serverTime: scenario.serverTime,
      proposals: scenario.own ? [ownIdea(body)] : [],
      ...(scenario.own ? {} : { round: null,
        collection: { id: 'pending', status: 'open', closesAt: null, releaseAt: null, initialClosed: true } }),
    });
    if (!scenario.own) await page.locator('#community-include-closed').check();
    await page.locator('#prompt').fill(body);
    await expect(page.locator('#admin-link')).toHaveAttribute('href', '/master');
    const errors = [];
    page.on('pageerror', error => errors.push(error.name));
    for (const locale of ['en', 'ko']) {
      await page.locator('#language-select').selectOption(locale);
      for (const [width, height] of [[1280, 720], [1366, 768], [1600, 900], [1920, 1080]]) {
        await page.setViewportSize({ width, height });
        await page.clock.runFor(50);
        if (!(await page.locator('#community-prev').isDisabled())) await page.locator('#community-prev').click();
        for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
          if (pageNumber === 2) await page.locator('#community-next').click();
          await expect(page.locator('#community-page')).toHaveText(`${pageNumber} / 2`);
          await expect(page.locator('.community-entry')).toHaveCount(3);
          await expect(page.locator('#leaderboard-list .leaderboard-entry')).toHaveCount(5);
          await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
          const geometry = await page.evaluate(() => {
            const inside = element => { const box = element.getBoundingClientRect();
              return box.top >= 0 && box.left >= 0 && box.right <= innerWidth + .5 && box.bottom <= innerHeight + .5; };
            const voting = document.querySelector('.community-section').getBoundingClientRect();
            const composer = document.querySelector('.submission-section').getBoundingClientRect();
            const essentials = document.querySelectorAll('.masthead,.hero,.game-preview,.community-section,#prompt-form,.contribution-board,.process-section,.community-entry,.leaderboard-entry');
            const controls = document.querySelectorAll('.vote-button,.community-read,#community-prev,#community-next,#submit-button,#open-my-proposals');
            return {
              allSectionsVisible: [...essentials].every(inside),
              pageFits: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
              votingAboveComposer: voting.bottom <= composer.top,
              controlsUsable: [...controls].every(element => { const box = element.getBoundingClientRect(); return box.width >= 44 && box.height >= 44; }),
              readSharesVoteRow: [...document.querySelectorAll('.community-entry')].every(entry => {
                const vote = entry.querySelector('.vote-button').getBoundingClientRect();
                const read = entry.querySelector('.community-read').getBoundingClientRect();
                return Math.abs(vote.top - read.top) <= .5 && Math.abs(vote.bottom - read.bottom) <= .5;
              }),
              stateNotesReadable: [...document.querySelectorAll('.vote-note')].every(element => inside(element)
                && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility === 'visible'
                && element.clientHeight >= 10 && element.textContent.trim().length > 0),
              noDocumentClipping: !['hidden', 'clip'].includes(getComputedStyle(document.body).overflowY)
                && !['hidden', 'clip'].includes(getComputedStyle(document.documentElement).overflowY),
            };
          });
          expect(geometry, `${scenario.name} ${locale} ${width} page ${pageNumber}`).toEqual({
            allSectionsVisible: true, pageFits: true, votingAboveComposer: true, controlsUsable: true,
            readSharesVoteRow: true, stateNotesReadable: true, noDocumentClipping: true,
          });
          if (!scenario.own) {
            await expect(page.locator('.vote-note')).toHaveCount(3);
            await expect(page.locator('.vote-button:enabled')).toHaveCount(0);
          } else if (pageNumber === 2) {
            await expect(page.locator('.own-idea-badge')).toHaveCount(1);
            await expect(page.locator('[data-public-id="public-owned-private-idea-a"] .vote-button:enabled')).toHaveCount(0);
          }
        }
        await page.screenshot({ path: testInfo.outputPath(`state-${locale}-${width}.png`), fullPage: true });
      }
    }
    await expect(page.locator('#prompt')).toHaveValue(body);
    expect(errors).toEqual([]);
    expect(state.posts).toHaveLength(0);
    expect(state.patches).toHaveLength(0);
    expect(state.actions).toHaveLength(0);
    expect(state.loginCalls).toBe(0);
  });
}
