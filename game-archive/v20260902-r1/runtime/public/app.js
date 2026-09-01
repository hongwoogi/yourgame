import { i18n } from './i18n.js';
import './public-messages.js';
import { PROFILE_ALIAS_LIMITS, normalizeProfileAlias, isValidProfileAlias } from './profile-policy.js';
import { countdownParts, formatReleaseDate } from './release-time.js';
import { createGameHost } from './game-host.js';

(() => {
  'use strict';

  const t = (key, params) => i18n.t(`public.${key}`, params);
  const m = (key, params = {}) => ({ key, params });
  function localize(value) {
    if (typeof value === 'function') return localize(value());
    if (!value || typeof value === 'string') return value || '';
    if (Object.hasOwn(value, 'api')) return i18n.apiError(value.api, t(value.fallback || 'requestFailed'));
    return t(value.key, Object.fromEntries(Object.entries(value.params || {}).map(([key, item]) =>
      [key, typeof item === 'function' || (item && typeof item === 'object') ? localize(item) : item])));
  }
  const errorMessage = (error) => error?.uiMessage || m('requestFailed');
  let feedbackMessage = '';
  let connectionMessage = '';
  let currentLoginMessage = '';
  let googleButtonLocale = null;

  const FIRST_RELEASE = '2026-09-01T00:00:00+09:00';
  const FIRST_CLOSE = '2026-08-31T23:00:00+09:00';
  const DRAFT_KEY = 'yourgame.draft.v1';
  const PENDING_KEY = 'yourgame.pending.v1';
  const ATTEMPT_KEY = 'yourgame.attempt.v1';
  const AUTH_PULSE_KEY = 'yourgame.auth-pulse.v1';
  const PENDING_MAX_AGE = 10 * 60 * 1000;
  const entryParameters = new URLSearchParams(window.location.search);
  const requestedAdmin = entryParameters.get('master') === '1' || entryParameters.get('admin') === '1';
  const requestedReauthentication = requestedAdmin && entryParameters.get('reauth') === '1';
  const encoder = new TextEncoder();
  const byId = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'prompt', 'prompt-form', 'submit-button', 'submit-label', 'submit-icon', 'submit-spinner',
    'byte-count', 'prompt-hint', 'submission-title', 'form-feedback', 'form-message',
    'login-button', 'logout-button', 'user-name', 'admin-link', 'login-dialog', 'close-login',
    'login-title', 'login-description', 'service-notice', 'service-title', 'service-message', 'service-detail',
    'google-signin', 'google-button-area', 'login-message', 'login-draft-note', 'retry-google',
    'quota-container', 'quota-status', 'quota-note', 'my-proposals', 'proposal-list',
    'proposal-count', 'open-my-proposals', 'my-proposals-dialog', 'close-my-proposals',
    'edit-banner', 'cancel-edit', 'reload-edit', 'copy-edit',
    'connection-notice', 'connection-message', 'retry-connection', 'collection-dot',
    'collection-label', 'collection-deadline', 'countdown-title', 'countdown', 'release-message',
    'release-note', 'release-date-time', 'count-hours', 'count-minutes', 'count-seconds',
    'game-preview-canvas', 'community-feed-panel', 'community-feed-status', 'community-feed-list',
    'community-refresh', 'community-vote-note', 'leaderboard-status', 'leaderboard-list',
    'my-contribution', 'my-contribution-summary', 'community-prev', 'community-next', 'community-page',
    'community-feedback', 'community-feedback-message', 'community-retry',
    'idea-dialog', 'idea-title', 'idea-author', 'idea-body', 'close-idea',
    'my-rank-value', 'my-rank-alias', 'my-rank-points', 'my-rank-status', 'my-rank-guest',
    'my-rank-login', 'my-rank-loading', 'my-rank-loading-message', 'my-rank-retry', 'edit-alias',
    'open-leaderboard', 'leaderboard-dialog', 'close-leaderboard', 'leaderboard-total',
    'leaderboard-full-panel', 'leaderboard-full-list', 'leaderboard-full-status',
    'leaderboard-full-retry', 'leaderboard-full-prev', 'leaderboard-full-next', 'leaderboard-full-page',
    'alias-dialog', 'close-alias', 'alias-form', 'alias-input', 'alias-count', 'alias-current',
    'alias-message', 'alias-retry', 'alias-reload', 'alias-cancel', 'alias-save',
    'open-ideas', 'ideas-dialog', 'close-ideas', 'ideas-total', 'ideas-vote-note',
    'ideas-panel', 'ideas-status', 'ideas-table', 'ideas-list', 'ideas-refresh', 'ideas-retry',
    'ideas-prev', 'ideas-next', 'ideas-page', 'ideas-feedback', 'ideas-feedback-message', 'ideas-action-retry',
  ].map((id) => [id, byId(id)]));

  let status = null;
  const gameHost = createGameHost({ surface: document.querySelector('.preview-surface'),
    placeholder: ui['game-preview-canvas'], note: document.querySelector('#preview-note span[data-i18n]') });
  let user = null;
  let communityData = null;
  let communityError = '';
  let communityLoading = true;
  let communitySort = 'recent';
  let communityPage = 0;
  let includeClosedIdeas = false;
  let communitySequence = 0;
  let communityMe = null;
  let communityMeSequence = 0;
  let communityMePromise = null;
  let communityMePromiseEpoch = -1;
  let communityMeLoading = false;
  let communityMeError = '';
  let communityFeedbackMessage = '';
  let communityAttempt = null;
  let communityMutating = false;
  let communityMutationSequence = 0;
  let activeIdea = null;
  let ideaReturnFocus = null;
  let ideaReturnContext = null;
  let proposalsReturnFocus = null;
  const IDEAS_PAGE_SIZE = 24;
  let fullIdeas = null;
  let ideasSort = 'recent';
  let ideasOffset = 0;
  let ideasLoading = false;
  let ideasRefreshQueued = false;
  let ideasKeepReader = false;
  let ideasError = '';
  let ideasSequence = 0;
  let ideasReturnFocus = null;
  const LEADERBOARD_PAGE_SIZE = 20;
  let fullLeaderboard = null;
  let leaderboardOffset = 0;
  let leaderboardLoading = false;
  let leaderboardRefreshQueued = false;
  let leaderboardError = '';
  let leaderboardSequence = 0;
  let leaderboardReturnFocus = null;
  let aliasEditor = null;
  let aliasReturnFocus = null;
  let csrfToken = null;
  let googleNonce = null;
  let sessionReady = false;
  let statusReady = false;
  let statusReadSequence = 0;
  let submissionBlock = null;
  let proposals = [];
  let quota = null;
  let privateReady = false;
  let editing = null;
  let editDrafts = { activeId: null, items: {} };
  let submitting = false;
  let authenticating = false;
  let composing = false;
  let adminEntryPending = requestedAdmin;
  let adminRedirecting = false;
  let loginPurpose = 'login';
  let synchronizing = false;
  let privatePromise = null;
  let privatePromiseEpoch = -1;
  let privatePromiseMutationVersion = -1;
  let authEpoch = 0;
  let sessionReadSequence = 0;
  let proposalMutationVersion = 0;
  let googleLoadPromise = null;
  let googleGeneration = 0;
  let googleButtonGeneration = -1;
  let googleButtonWidth = 0;
  let preservePendingOnClose = false;
  let loginReturnFocus = null;
  let serverBase = null;
  let serverMonotonicBase = null;
  let pollTimer = null;
  let pollFailures = 0;
  let quotaWakeAttempt = 0;
  let lastBoundary = '';
  let lastSyncAt = 0;
  let storageWarningShown = false;
  // The server-rendered textarea can receive input while this module or one of
  // its imports is still downloading. That live text wins over a stored draft.
  const earlyDraft = ui.prompt.value !== ui.prompt.defaultValue;
  let newDraft = readStorage('localStorage', DRAFT_KEY) || '';
  if (newDraft.length > 100000) newDraft = '';
  if (earlyDraft) newDraft = ui.prompt.value;
  else ui.prompt.value = newDraft;

  function readStorage(kind, key) {
    try { return window[kind].getItem(key); } catch { return null; }
  }

  function writeStorage(kind, key, value) {
    try {
      if (value === null) window[kind].removeItem(key);
      else window[kind].setItem(key, value);
      return true;
    } catch {
      if (kind === 'localStorage' && !storageWarningShown) {
        storageWarningShown = true;
        feedback(m('storageUnavailable'), 'error');
      }
      return false;
    }
  }

  function readJson(kind, key) {
    try { return JSON.parse(readStorage(kind, key) || 'null'); } catch { return null; }
  }

  function editStorageKey() { return user ? `yourgame.edits.v1.${user.id}` : null; }

  function saveEditDrafts() {
    const key = editStorageKey();
    if (key) writeStorage('localStorage', key, JSON.stringify(editDrafts));
  }

  function saveCurrentDraft() {
    if (editing && user) {
      editDrafts.items[editing.id] = { body: ui.prompt.value, revision: editing.revision };
      editDrafts.activeId = editing.id;
      saveEditDrafts();
    } else {
      newDraft = ui.prompt.value;
      writeStorage('localStorage', DRAFT_KEY, newDraft || null);
    }
  }

  let pending = readJson('sessionStorage', PENDING_KEY);
  if (requestedAdmin || !validPending(pending)) clearPending();
  let attempt = readJson('sessionStorage', ATTEMPT_KEY);
  if (!attempt || typeof attempt.body !== 'string' || typeof attempt.requestId !== 'string') attempt = null;

  function validPending(value) {
    return value && typeof value.body === 'string' && typeof value.requestId === 'string'
      && Number.isFinite(value.createdAt) && Date.now() >= value.createdAt
      && Date.now() - value.createdAt < PENDING_MAX_AGE && encoder.encode(value.body).length <= 2000;
  }

  function clearPending() {
    pending = null;
    writeStorage('sessionStorage', PENDING_KEY, null);
  }

  function submissionAttempt(body) {
    if (!attempt || attempt.body !== body) {
      attempt = { body, requestId: crypto.randomUUID() };
      writeStorage('sessionStorage', ATTEMPT_KEY, JSON.stringify(attempt));
    }
    return attempt;
  }

  function queueAfterLogin(body) {
    const nextAttempt = submissionAttempt(body);
    pending = { ...nextAttempt, createdAt: Date.now() };
    writeStorage('sessionStorage', PENDING_KEY, JSON.stringify(pending));
  }

  function serverNow() {
    return serverBase === null ? Date.now() : serverBase + performance.now() - serverMonotonicBase;
  }

  function synchronizeClock(value, elapsed) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      serverBase = timestamp + Math.max(0, elapsed) / 2;
      serverMonotonicBase = performance.now();
    }
  }

  class RequestError extends Error {
    constructor(message, responseStatus = 0, data = null, retryAfterSeconds = 0) {
      super(localize(message));
      this.uiMessage = message;
      this.status = responseStatus;
      this.data = data;
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    const started = performance.now();
    try {
      const headers = { Accept: 'application/json', 'X-Yourgame-Language': i18n.locale };
      if (method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
      }
      const response = await fetch(path, {
        method, headers, credentials: 'same-origin', cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      });
      let data;
      try { data = await response.json(); }
      catch { throw new RequestError(m('invalidResponse'), response.status); }
      if (!response.ok) {
        // Use a known error code, never raw server review evidence or foreign-language text.
        const message = { api: typeof data?.error?.code === 'string' ? data.error.code : 'UNKNOWN',
          fallback: response.status >= 500 ? 'serverFailed' : 'requestFailed' };
        const retryAfter = Number(response.headers.get('Retry-After'));
        throw new RequestError(message, response.status, data,
          Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 3600 ? Math.ceil(retryAfter) : 0);
      }
      if (data.serverTime) synchronizeClock(data.serverTime, performance.now() - started);
      return data;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(error.name === 'AbortError'
        ? m('timeout')
        : m('offlineRequest'));
    } finally { clearTimeout(timeout); }
  }

  function feedback(message, kind = 'success', { reload = false, copy = false, reason = '' } = {}) {
    ui['form-feedback'].hidden = !message;
    ui['form-feedback'].dataset.kind = kind;
    ui['form-feedback'].dataset.reason = reason;
    feedbackMessage = message;
    ui['form-message'].textContent = localize(message);
    ui['reload-edit'].hidden = !reload;
    ui['copy-edit'].hidden = !copy;
  }

  function connectionError(message) {
    connectionMessage = message;
    ui['connection-message'].textContent = localize(message);
    ui['connection-notice'].hidden = false;
  }

  function loginMessage(message, isError = false) {
    currentLoginMessage = message;
    ui['login-message'].textContent = localize(message);
    ui['login-message'].classList.toggle('is-error', isError);
  }

  function limits() {
    return { bytes: status?.limits?.bytes || 2000, submissions: status?.limits?.submissions || 3 };
  }

  function operatingState() {
    // Older status fixtures omit service; the collection status still limits submissions.
    const service = status?.service || {};
    const ended = service.mode === 'ended' || status?.collection?.status === 'ended' || submissionBlock?.mode === 'ended';
    const maintenance = service.mode === 'maintenance' || submissionBlock?.mode === 'maintenance';
    return {
      mode: ended ? 'ended' : maintenance ? 'maintenance' : 'active',
      proposalsPaused: ended || maintenance || service.proposalsEnabled === false
        || status?.collection?.status === 'paused' || Boolean(submissionBlock),
      developmentPaused: ended || maintenance || service.developmentEnabled === false,
      message: typeof service.message === 'string' ? service.message.slice(0, 2000) : '',
    };
  }

  function proposalsOpen() {
    return statusReady && status?.collection?.status === 'open' && !operatingState().proposalsPaused;
  }

  function pausedSubmissionMessage() {
    const { mode } = operatingState();
    return m(mode === 'ended' ? 'pausedEnded' : mode === 'maintenance' ? 'pausedMaintenance' : 'pausedIntake');
  }

  function cancelPausedSend() {
    const wasPending = Boolean(pending);
    clearPending();
    if (ui['login-dialog'].open && loginPurpose === 'submission') {
      ui['login-draft-note'].textContent = localize(pausedSubmissionMessage());
    }
    if (wasPending) feedback(pausedSubmissionMessage(), 'error', { reason: 'service' });
  }

  function renderService() {
    const state = operatingState();
    const notice = ui['service-notice'];
    notice.hidden = !state.proposalsPaused && !state.developmentPaused && !state.message;
    notice.dataset.mode = state.mode;
    notice.dataset.paused = String(state.proposalsPaused);
    const title = state.mode === 'ended' ? t('serviceEndedTitle')
      : state.mode === 'maintenance' ? t('serviceMaintenanceTitle')
        : state.proposalsPaused ? t('serviceIntakeTitle')
          : state.developmentPaused ? t('serviceDevelopmentTitle') : t('serviceAnnouncement');
    const detail = state.proposalsPaused
      ? t('servicePausedDetail')
      : state.developmentPaused ? t('developmentPausedDetail') : '';
    for (const [key, text] of [['service-title', title], ['service-message', state.message], ['service-detail', detail]]) {
      if (ui[key].textContent !== text) ui[key].textContent = text;
    }
    ui['service-message'].hidden = !state.message;
    ui['service-detail'].hidden = !detail;
  }

  function isServiceRejection(error) {
    return error.status === 423 || ['SERVICE_ENDED', 'SERVICE_MAINTENANCE', 'PROPOSALS_PAUSED'].includes(error.data?.error?.code);
  }

  function applyServiceRejection(error) {
    const code = error.data?.error?.code;
    submissionBlock = { mode: code === 'SERVICE_ENDED' ? 'ended' : code === 'SERVICE_MAINTENANCE' ? 'maintenance' : 'active' };
    // A status read started before this rejection cannot reopen the form afterward.
    statusReadSequence += 1;
    cancelPausedSend();
    saveCurrentDraft();
    feedback(pausedSubmissionMessage(), 'error', { reason: 'service' });
    renderControls();
    renderTime();
  }

  function shortTime(value, includeSeconds = false) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return t('timeChecking');
    return new Intl.DateTimeFormat(i18n.intlLocale, {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit',
      ...(includeSeconds ? { second: '2-digit' } : {}), hourCycle: 'h23',
    }).format(date);
  }

  function proposalDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat(i18n.intlLocale, {
      timeZone: 'Asia/Seoul', month: i18n.locale === 'ko' ? '2-digit' : 'short', day: '2-digit', hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23',
    }).format(date) + ' KST';
  }

  function renderBytes() {
    const count = encoder.encode(ui.prompt.value).length;
    const max = limits().bytes;
    ui['byte-count'].replaceChildren(document.createTextNode(count.toLocaleString(i18n.intlLocale) + ' '));
    const suffix = document.createElement('span');
    suffix.textContent = '/ ' + max.toLocaleString(i18n.intlLocale) + ' bytes';
    ui['byte-count'].append(suffix);
    ui['byte-count'].classList.toggle('is-over', count > max);
    ui.prompt.setAttribute('aria-invalid', count > max ? 'true' : 'false');
    ui['prompt-hint'].textContent = count > max
      ? t('bytesOver', { bytes: (count - max).toLocaleString(i18n.intlLocale) })
      : t('promptHint');
    return count;
  }

  function renderControls() {
    const count = renderBytes();
    const loggedIn = Boolean(user);
    const operations = operatingState();
    renderService();
    ui['login-button'].hidden = loggedIn;
    ui['login-button'].disabled = authenticating || !sessionReady;
    ui['admin-link'].hidden = user?.isAdmin !== true;
    ui['logout-button'].hidden = !loggedIn;
    ui['logout-button'].disabled = authenticating || submitting;
    ui['user-name'].hidden = !loggedIn;
    ui['user-name'].textContent = user?.name || '';
    ui['user-name'].title = user?.name || '';
    ui['edit-banner'].hidden = !editing;
    ui['cancel-edit'].disabled = submitting;
    ui.prompt.disabled = submitting;
    ui['quota-container'].classList.toggle('is-authenticated', loggedIn);
    ui['quota-container'].classList.toggle('is-empty', loggedIn && quota?.remaining === 0);
    if (!loggedIn) {
      ui['quota-status'].textContent = t('quotaAnonymous');
      ui['quota-note'].textContent = t('quotaLimit');
    } else if (!quota) {
      ui['quota-status'].textContent = t('quotaChecking');
      ui['quota-note'].textContent = t('quotaHistory');
    } else {
      ui['quota-status'].textContent = t('quotaRemaining', { remaining: quota.remaining, limit: quota.limit });
      ui['quota-note'].textContent = quota.remaining === 0 && quota.nextAvailableAt
        ? t('quotaNext', { time: shortTime(quota.nextAvailableAt, true) })
        : t('quotaRefill');
    }
    const editingLocked = editing && (!editing.editable || editing.conflict);
    const noQuota = loggedIn && (!quota || quota.remaining <= 0);
    ui['submit-button'].disabled = submitting || authenticating || composing || !sessionReady || !statusReady
      || (loggedIn && !privateReady)
      || count > limits().bytes || Boolean(editingLocked) || (!editing && noQuota)
      || !proposalsOpen();
    ui['submit-label'].textContent = submitting ? (editing ? t('saving') : t('sending'))
      : operations.proposalsPaused ? (operations.mode === 'ended' ? t('intakeEnded') : t('intakePaused'))
      : editing ? (editingLocked ? t('editCheck') : t('saveEdit'))
        : loggedIn && quota?.remaining === 0 ? t('quotaWaiting') : t('send');
    ui['submit-spinner'].hidden = !submitting;
    ui['submit-icon'].hidden = submitting;
    ui['prompt-form'].setAttribute('aria-busy', submitting ? 'true' : 'false');
    ui['my-proposals'].hidden = !loggedIn || !privateReady;
    ui['open-my-proposals'].hidden = !loggedIn;
    ui['open-my-proposals'].disabled = !privateReady || submitting || authenticating;
    if (!loggedIn || !privateReady) closeMyProposals({ restoreFocus: false });
    updateCommunityControls();
  }

  function renderTime({ passive = false } = {}) {
    const now = serverNow();
    const daily = status?.collection?.schedule === 'daily-kst-v1';
    // These are separate server dates: after 23:00 the open collection targets
    // tomorrow's release, while tonight's release is still the next one.
    const targetDate = daily ? status.nextReleaseAt : status?.firstReleaseAt || FIRST_RELEASE;
    const target = Date.parse(targetDate);
    const collectionExpired = daily && now >= Date.parse(status.collection.closesAt);
    const { remaining, hours, minutes, seconds } = countdownParts(target, now);
    ui['release-date-time'].textContent = formatReleaseDate(target, i18n.locale);
    ui['release-date-time'].dateTime = targetDate;
    ui['release-date-time'].title = t('releaseTimezoneTitle');
    const published = status?.game?.published === true;
    const operations = operatingState();
    gameHost.update({ game: status?.game, locale: i18n.locale, active: statusReady && operations.mode === 'active' });
    const releasePaused = operations.mode !== 'active' || ((daily || !published) && operations.developmentPaused);
    ui.countdown.hidden = remaining === 0 || (!daily && published) || releasePaused;
    ui['release-message'].hidden = remaining > 0 && (daily || !published) && !releasePaused;
    if (releasePaused) {
      ui['countdown-title'].textContent = operations.mode === 'ended' ? t('endedTitle')
        : operations.mode === 'maintenance' ? t('maintenanceTitle') : t('developmentTitle');
      ui['release-message'].textContent = operations.mode === 'ended' ? t('endedMessage')
        : operations.mode === 'maintenance' ? t('maintenanceMessage') : t('developmentMessage');
    } else if (!daily && published) {
      ui['countdown-title'].textContent = t('firstGame');
      ui['release-message'].textContent = t('gamePublished');
    } else if (remaining === 0) {
      ui['countdown-title'].textContent = t(daily ? 'dailyReleaseCheckingTitle' : 'gamePreparingTitle');
      ui['release-message'].textContent = t(daily ? 'dailyReleaseChecking' : 'gamePreparing');
    } else {
      ui['countdown-title'].textContent = t(daily ? 'dailyCountdown' : 'countdownDefault');
      const values = [hours, minutes, seconds];
      ['count-hours', 'count-minutes', 'count-seconds'].forEach((key, index) => {
        ui[key].textContent = String(values[index]).padStart(2, '0');
      });
      ui.countdown.setAttribute('aria-label', t('countdownTime', { hours, minutes, seconds }));
    }
    ui['release-note'].textContent = !statusReady ? (releasePaused ? t('operationChecking') : t('deviceTime'))
      : releasePaused ? t('pausedReleaseNote')
      : daily ? t(published ? 'dailyPublishedNote' : 'dailyReleaseNote')
      : published ? t('publishedNote')
        : remaining === 0 ? t('delayedNote')
          : t('releaseNote');
    const initialClosed = status?.collection?.initialClosed === true || now >= Date.parse(FIRST_CLOSE);
    const open = proposalsOpen();
    ui['collection-dot'].classList.toggle('is-open', open && !collectionExpired);
    ui['collection-label'].textContent = !statusReady ? t('collectionChecking')
      : operations.proposalsPaused ? (operations.mode === 'ended' ? t('collectionEnded') : operations.mode === 'maintenance' ? t('collectionMaintenance') : t('collectionPaused'))
      : collectionExpired ? t('collectionChecking')
      : open ? (daily ? t('dailyCollectionOpen') : initialClosed ? t('collectionNext') : t('collectionOpen')) : t('collectionPreparing');
    ui['collection-deadline'].textContent = operations.proposalsPaused ? t('deadlinePaused')
      : daily ? (collectionExpired ? t('dailyCollectionChecking')
        : t('dailyCollectionDeadline', { time: formatReleaseDate(status.collection.closesAt, i18n.locale) })) : initialClosed
      ? t('deadlineNext')
      : t('initialDeadline');
    const boundary = daily ? `${status.collection.cycleId}-${collectionExpired}-${remaining === 0}`
      : `${initialClosed}-${remaining === 0}`;
    if (!passive && lastBoundary && lastBoundary !== boundary && statusReady) schedulePoll(0);
    if (!passive) lastBoundary = boundary;
    if (!passive && statusReady && sessionReady && user && !document.hidden && !submitting && !authenticating
      && quota?.remaining === 0 && quota.nextAvailableAt
      && Date.parse(quota.nextAvailableAt) <= now && now - quotaWakeAttempt > 15000) {
      quotaWakeAttempt = now;
      // Replenishing a quota only enables the button. It never replays a send intent.
      loadPrivate().catch(() => {});
    }
  }

  function applySession(data) {
    const nextUser = data.user || null;
    if ((user?.id || null) !== (nextUser?.id || null)) {
      authEpoch += 1;
      resetCommunityIdentity();
      proposals = [];
      quota = null;
      privateReady = false;
      editing = null;
      user = nextUser;
      const stored = user ? readJson('localStorage', editStorageKey()) : null;
      editDrafts = stored && stored.items && typeof stored.items === 'object'
        ? { activeId: stored.activeId || null, items: stored.items } : { activeId: null, items: {} };
      ui.prompt.value = newDraft;
      ui['proposal-list'].replaceChildren();
      closeMyProposals({ restoreFocus: false });
    } else user = nextUser;
    csrfToken = data.csrfToken || csrfToken;
    googleNonce = data.googleNonce || googleNonce;
    sessionReady = Boolean(csrfToken && googleNonce);
    renderControls();
    renderCommunity();
  }

  async function refreshSession() {
    const epoch = authEpoch;
    const sequence = ++sessionReadSequence;
    try {
      const data = await request('/api/session');
      // Both stale successes and stale failures must leave the newer session untouched.
      if (epoch !== authEpoch || sequence !== sessionReadSequence) return { user, csrfToken, googleNonce };
      if (!data || !data.csrfToken || !data.googleNonce) throw new RequestError(m('sessionUnavailable'));
      applySession(data);
      return data;
    } catch (error) {
      if (epoch !== authEpoch || sequence !== sessionReadSequence) return { user, csrfToken, googleNonce };
      sessionReady = false;
      renderControls();
      throw error;
    }
  }

  function invalidatePrivate({ identityChanged = false } = {}) {
    clearPending();
    saveCurrentDraft();
    proposals = [];
    quota = null;
    privateReady = false;
    if (identityChanged) {
      editing = null;
      ui.prompt.value = newDraft;
    }
    ui['proposal-list'].replaceChildren();
    closeMyProposals({ restoreFocus: false });
    renderControls();
  }

  async function refreshStatus() {
    const sequence = ++statusReadSequence;
    try {
      const data = await request('/api/status');
      if (sequence !== statusReadSequence) return status;
      if (!data.collection || !data.firstReleaseAt || !data.serverTime) throw new RequestError(m('collectionUnavailable'));
      if (data.collection.schedule === 'daily-kst-v1'
        && (!/^daily-\d{4}-\d{2}-\d{2}$/.test(data.collection.cycleId || '')
          || ![data.collection.opensAt, data.collection.closesAt, data.collection.releaseAt, data.nextReleaseAt]
            .every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))
          || Date.parse(data.collection.opensAt) >= Date.parse(data.collection.closesAt)
          || Date.parse(data.collection.closesAt) >= Date.parse(data.collection.releaseAt))) {
        throw new RequestError(m('collectionUnavailable'));
      }
      if (data.service !== undefined && (!data.service || !['active', 'maintenance', 'ended'].includes(data.service.mode)
        || typeof data.service.proposalsEnabled !== 'boolean' || typeof data.service.developmentEnabled !== 'boolean'
        || typeof data.service.message !== 'string')) throw new RequestError(m('operationsUnavailable'));
      const wasPaused = operatingState().proposalsPaused;
      status = data;
      submissionBlock = null;
      statusReady = true;
      if (operatingState().proposalsPaused) cancelPausedSend();
      else if (wasPaused && ui['form-feedback'].dataset.reason === 'service') {
        feedback(m('intakeResumed'));
      }
      renderTime();
      renderControls();
      return data;
    } catch (error) {
      if (sequence !== statusReadSequence) return status;
      statusReady = false;
      renderControls();
      renderTime();
      throw error;
    }
  }

  function acceptQuota(value) {
    if (!value || !Number.isInteger(value.remaining) || !Number.isInteger(value.limit)) {
      throw new RequestError(m('quotaUnavailable'));
    }
    quota = { remaining: Math.max(0, value.remaining), limit: value.limit, nextAvailableAt: value.nextAvailableAt || null };
  }

  function renderProposals() {
    ui['proposal-list'].replaceChildren();
    ui['my-proposals'].hidden = !user || !privateReady;
    if (!user || !privateReady) return;
    ui['proposal-count'].textContent = String(proposals.length);
    if (!proposals.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-proposals';
      empty.textContent = t('noProposals');
      ui['proposal-list'].append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const proposal of proposals) {
      const article = document.createElement('article');
      article.className = 'proposal-item';
      const meta = document.createElement('div');
      meta.className = 'proposal-meta';
      const time = document.createElement('time');
      time.dateTime = proposal.createdAt;
      time.textContent = proposalDate(proposal.createdAt);
      const actions = document.createElement('div');
      actions.className = 'proposal-meta-right';
      const state = document.createElement('span');
      state.textContent = proposal.editable ? (operatingState().proposalsPaused ? t('editPaused') : t('editable')) : t('editClosed');
      if (proposal.closesAt && Number.isFinite(Date.parse(proposal.closesAt))) {
        state.title = t('dailyEditDeadline', { time: formatReleaseDate(proposal.closesAt, i18n.locale) });
      }
      actions.append(state);
      if (proposal.editable) {
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'text-button proposal-edit';
        editButton.textContent = t('edit');
        editButton.disabled = submitting || authenticating;
        editButton.setAttribute('aria-label', t('editAria', { date: proposalDate(proposal.createdAt) }));
        editButton.addEventListener('click', () => beginEdit(proposal));
        actions.append(editButton);
      }
      const body = document.createElement('p');
      body.className = 'proposal-body';
      body.textContent = proposal.body;
      meta.append(time, actions);
      article.append(meta, body);
      fragment.append(article);
    }
    ui['proposal-list'].append(fragment);
  }

  async function loadPrivate({ restoreEdit = false, identityRetry = true } = {}) {
    if (!user) return;
    const epoch = authEpoch;
    const expectedOwnerId = user.id;
    const mutationVersion = proposalMutationVersion;
    if (privatePromise && privatePromiseEpoch === epoch && privatePromiseMutationVersion === mutationVersion) return privatePromise;
    privatePromiseEpoch = epoch;
    privatePromiseMutationVersion = mutationVersion;
    const promise = (async () => {
      try {
        const data = await request('/api/proposals');
        if (authEpoch !== epoch || mutationVersion !== proposalMutationVersion || !user) return;
        if (typeof data.ownerId !== 'string' || !data.ownerId) {
          throw new RequestError(m('ownerUnavailable'));
        }
        if (data.ownerId !== expectedOwnerId || data.ownerId !== user.id) {
          // A shared cookie may change before another tab announces its login.
          // Never display this response, restore an edit, or carry its pending send into the new account.
          invalidatePrivate({ identityChanged: true });
          authEpoch += 1;
          resetCommunityIdentity();
          sessionReady = false;
          renderControls();
          if (!identityRetry) {
            connectionError(m('recheckAccount'));
            throw new RequestError(m('otherTabAccount'));
          }
          try { await refreshSession(); }
          catch (error) {
            connectionError(m('recheckAccount'));
            throw error;
          }
          if (!user || !sessionReady) throw new RequestError(m('accountChanged'));
          return await loadPrivate({ restoreEdit: false, identityRetry: false });
        }
        if (!Array.isArray(data.proposals)) throw new RequestError(m('proposalsUnavailable'));
        const hadNoQuota = quota?.remaining === 0;
        acceptQuota(data.quota);
        privateReady = true;
        proposals = data.proposals.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        if (editing) {
          const current = proposals.find((entry) => entry.id === editing.id);
          editing.editable = current?.editable === true;
          editing.conflict = Boolean(current && current.revision !== editing.revision);
          if (!editing.editable) feedback(m('editRoundClosed'), 'error', { copy: true });
          else if (editing.conflict) feedback(m('editChangedSaved'), 'error', { reload: true, copy: true });
        } else if (restoreEdit && editDrafts.activeId && !pending) {
          const previous = proposals.find((entry) => entry.id === editDrafts.activeId);
          if (previous) beginEdit(previous, { focus: false });
        }
        renderProposals();
        renderControls();
        loadCommunityMe().catch(() => {});
        if (hadNoQuota && quota.remaining > 0 && !editing && ui['form-feedback'].dataset.reason === 'quota') {
          feedback(m('quotaReturned'));
        }
        return data;
      } catch (error) {
        if (authEpoch === epoch && mutationVersion === proposalMutationVersion) {
          invalidatePrivate();
          connectionError(m('recordsUnavailable'));
          if (error.status === 401) {
            applySession({ user: null, csrfToken, googleNonce });
            sessionReady = false;
            renderControls();
            try { await refreshSession(); } catch { /* The connection notice stays visible. */ }
          }
        }
        throw error;
      }
    })();
    privatePromise = promise;
    try { return await promise; }
    finally { if (privatePromise === promise) privatePromise = null; }
  }

  async function synchronize({ resumePending = false } = {}) {
    if (synchronizing || authenticating || submitting) return false;
    synchronizing = true;
    ui['retry-connection'].disabled = true;
    try {
      const results = await Promise.allSettled([refreshStatus(), refreshSession()]);
      // Admin access must remain reachable when public status or proposal reads fail.
      const handledAdminEntry = results[1].status === 'fulfilled' && await handleAdminEntry();
      if (adminRedirecting) return true;
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) {
        throw failure.reason;
      }
      if (user) await loadPrivate({ restoreEdit: resumePending });
      ui['connection-notice'].hidden = true;
      pollFailures = 0;
      lastSyncAt = Date.now();
      if (!handledAdminEntry && resumePending && validPending(pending)) {
        if (user) await resumeExplicitSend();
        else if (pending.body === ui.prompt.value) await openLogin(true);
        else clearPending();
      }
      return true;
    } catch (error) {
      pollFailures += 1;
      connectionError(errorMessage(error));
      return false;
    } finally {
      synchronizing = false;
      ui['retry-connection'].disabled = false;
      renderControls();
      schedulePoll(Math.min(180000, 45000 * 2 ** Math.min(pollFailures, 2)));
    }
  }

  function schedulePoll(delay = 45000) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      if (document.hidden || submitting || authenticating || synchronizing) { schedulePoll(); return; }
      try {
        await refreshStatus();
        if (!sessionReady) await refreshSession();
        if (user) await loadPrivate();
        loadCommunity().catch(() => {});
        ui['connection-notice'].hidden = true;
        pollFailures = 0;
        lastSyncAt = Date.now();
      } catch (error) {
        pollFailures += 1;
        connectionError(errorMessage(error));
      } finally { schedulePoll(Math.min(180000, 45000 * 2 ** Math.min(pollFailures, 2))); }
    }, delay);
  }

  function beginEdit(proposal, { focus = true, useLatest = false } = {}) {
    if (!user || !privateReady || submitting || authenticating) return;
    closeMyProposals({ restoreFocus: false });
    saveCurrentDraft();
    clearPending();
    const saved = !useLatest && editDrafts.items[proposal.id];
    editing = {
      id: proposal.id, revision: saved?.revision || proposal.revision,
      editable: proposal.editable === true, conflict: Boolean(saved && saved.revision !== proposal.revision),
    };
    ui.prompt.value = typeof saved?.body === 'string' ? saved.body : proposal.body;
    saveCurrentDraft();
    feedback(!editing.editable ? m('editClosedDraft')
      : editing.conflict ? m('editChanged')
        : m('editFree'), editing.editable && !editing.conflict ? 'success' : 'error',
    { reload: editing.conflict, copy: !editing.editable || editing.conflict });
    renderControls();
    if (focus) ui.prompt.focus();
  }

  function endEdit({ removeDraft = false } = {}) {
    if (editing) {
      if (removeDraft) delete editDrafts.items[editing.id];
      else saveCurrentDraft();
      editDrafts.activeId = null;
      saveEditDrafts();
    }
    editing = null;
    ui.prompt.value = newDraft;
    renderControls();
  }

  function validateBody(body) {
    if (!body.trim()) {
      feedback(m('emptyBody'), 'error');
      ui.prompt.focus();
      return false;
    }
    if (encoder.encode(body).length > limits().bytes) {
      feedback(m('bodyTooLarge'), 'error');
      ui.prompt.focus();
      return false;
    }
    return true;
  }

  async function sendProposal(body, requestId) {
    if (submitting || composing || !user || !privateReady || !validateBody(body)) return;
    if (!proposalsOpen()) {
      clearPending();
      feedback(operatingState().proposalsPaused ? pausedSubmissionMessage()
        : m('notOpen'), 'error',
      { reason: operatingState().proposalsPaused ? 'service' : '' });
      return;
    }
    submitting = true;
    proposalMutationVersion += 1;
    const editingAtSend = editing ? { ...editing } : null;
    const epoch = authEpoch;
    clearPending();
    feedback('');
    renderControls();
    renderProposals();
    try {
      const data = await request('/api/proposals', {
        method: editingAtSend ? 'PATCH' : 'POST',
        body: editingAtSend ? { id: editingAtSend.id, body, revision: editingAtSend.revision } : { body, requestId },
      });
      if (epoch !== authEpoch || !user) return;
      if (!data.proposal) throw new RequestError(m('resultUnknown'));
      acceptQuota(data.quota);
      proposals = [data.proposal, ...proposals.filter((entry) => entry.id !== data.proposal.id)]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      if (editingAtSend) {
        endEdit({ removeDraft: true });
        feedback(m('editSaved'));
      } else {
        newDraft = '';
        ui.prompt.value = '';
        writeStorage('localStorage', DRAFT_KEY, null);
        attempt = null;
        writeStorage('sessionStorage', ATTEMPT_KEY, null);
        feedback(m('submitted'));
      }
      loadCommunityMe({ force: true }).catch(() => {});
      loadCommunity().catch(() => {});
      renderProposals();
    } catch (error) {
      if (epoch !== authEpoch) return;
      if (error.data?.quota) {
        try { acceptQuota(error.data.quota); } catch { quota = null; }
      }
      const editRateLimited = error.data?.error?.code === 'EDIT_RATE_LIMITED';
      const attemptRateLimited = error.data?.error?.code === 'PROPOSAL_ATTEMPT_RATE_LIMITED';
      const retryWait = error.retryAfterSeconds ? m('retrySeconds', { seconds: error.retryAfterSeconds }) : m('retrySoon');
      feedback(editRateLimited ? m('editRateLimited', { wait: retryWait })
          : attemptRateLimited ? m('attemptRateLimited', { wait: retryWait })
          : error.status === 0 && !editingAtSend
        ? m('sendUnknown')
        : errorMessage(error), 'error', { reason: error.status === 429 && !editRateLimited && !attemptRateLimited ? 'quota' : '' });
      if (isServiceRejection(error)) {
        applyServiceRejection(error);
        await refreshStatus().catch(() => {});
      } else if (error.status === 409 && editingAtSend) {
        editing.conflict = true;
        await loadPrivate().catch(() => {});
        feedback(errorMessage(error), 'error', { reload: editing?.editable === true, copy: Boolean(editing) });
      } else if (error.status === 401 || error.status === 403) {
        if (error.status === 401) {
          applySession({ user: null, csrfToken, googleNonce });
          feedback(m('loginExpired'), 'error');
        }
        await refreshSession().catch(() => { sessionReady = false; });
      }
    } finally {
      submitting = false;
      renderControls();
      renderProposals();
    }
  }

  async function resumeExplicitSend() {
    const queued = pending;
    clearPending();
    if (!validPending(queued) || !user || editing) return;
    if (composing || !proposalsOpen()) {
      feedback(operatingState().proposalsPaused ? pausedSubmissionMessage()
        : m('autoSendNotReady'), 'error',
      { reason: operatingState().proposalsPaused ? 'service' : '' });
      return;
    }
    if (ui.prompt.value !== queued.body) {
      feedback(m('autoSendChanged'));
      return;
    }
    if (!privateReady || !quota) {
      feedback(m('autoSendNoQuotaInfo'), 'error');
      return;
    }
    if (quota.remaining <= 0) {
      const nextTime = quota.nextAvailableAt;
      feedback(m('autoSendNoQuota', { when: nextTime ? m('nextSlotTime', { time: () => shortTime(nextTime, true) }) : m('nextSlotAvailable') }), 'error', { reason: 'quota' });
      return;
    }
    await sendProposal(queued.body, queued.requestId);
  }

  function loadGoogle() {
    if (window.google?.accounts?.id) return Promise.resolve();
    if (googleLoadPromise) return googleLoadPromise;
    googleLoadPromise = new Promise((resolve, reject) => {
      const previous = document.getElementById('google-gis-script');
      previous?.remove();
      const script = document.createElement('script');
      script.id = 'google-gis-script';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      const timer = setTimeout(() => {
        script.remove();
        googleLoadPromise = null;
        reject(new RequestError(m('googleTimeout')));
      }, 15000);
      script.onload = () => {
        clearTimeout(timer);
        if (window.google?.accounts?.id) resolve();
        else { googleLoadPromise = null; reject(new RequestError(m('googleUnavailable'))); }
      };
      script.onerror = () => {
        clearTimeout(timer);
        googleLoadPromise = null;
        script.remove();
        reject(new RequestError(m('googleConnection')));
      };
      document.head.append(script);
    });
    return googleLoadPromise;
  }

  function navigateToAdmin() {
    if (adminRedirecting || user?.isAdmin !== true) return;
    adminRedirecting = true;
    clearPending();
    saveCurrentDraft();
    // This is an entry shortcut only. The server authorizes every admin request.
    window.location.assign('/master');
  }

  async function handleAdminEntry() {
    if (!adminEntryPending || !sessionReady) return false;
    adminEntryPending = false;
    clearPending();
    saveCurrentDraft();
    // Consuming these flags prevents Back/reload from reopening the same login modal.
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('master');
    nextUrl.searchParams.delete('admin');
    nextUrl.searchParams.delete('reauth');
    window.history.replaceState(window.history.state, '', nextUrl.pathname + nextUrl.search + nextUrl.hash);
    if (user?.isAdmin === true && !requestedReauthentication) navigateToAdmin();
    else await openLogin(false, { forAdmin: true });
    return true;
  }

  function renderGoogleButton(generation = googleButtonGeneration) {
    if (generation !== googleGeneration || !ui['login-dialog'].open || authenticating
      || !window.google?.accounts?.id) return;
    const availableWidth = Math.floor(ui['google-signin'].getBoundingClientRect().width);
    const width = Math.min(350, availableWidth);
    if (width <= 0 || (generation === googleButtonGeneration && width === googleButtonWidth && googleButtonLocale === i18n.locale)) return;
    googleButtonGeneration = generation;
    googleButtonWidth = width;
    googleButtonLocale = i18n.locale;
    ui['google-signin'].replaceChildren();
    window.google.accounts.id.renderButton(ui['google-signin'], {
      type: 'standard', theme: 'outline', size: 'large', text: 'continue_with',
      shape: 'rectangular', width, locale: i18n.locale, logo_alignment: 'left',
    });
  }

  async function prepareGoogle() {
    const generation = ++googleGeneration;
    googleButtonGeneration = -1;
    googleButtonWidth = 0;
    ui['retry-google'].hidden = true;
    ui['google-signin'].replaceChildren();
    loginMessage(m('loginPreparing'));
    try {
      await refreshSession();
      if (generation !== googleGeneration || !ui['login-dialog'].open) return;
      if (user && loginPurpose !== 'admin') {
        const forCommunity = loginPurpose === 'community';
        closeLogin(true);
        try {
          await refreshStatus();
          await loadPrivate();
          if (forCommunity) communityFeedback(m('communityLoginDone'));
          else await resumeExplicitSend();
        } catch (error) {
          clearPending();
          if (forCommunity) communityFeedback(m('communityLoginPreparationFailed'), 'error');
          else feedback(m('autoSendUnprepared'), 'error');
          connectionError(errorMessage(error));
        }
        return;
      }
      // The parallel session read can finish before the initial settings read.
      if (!status?.googleClientId) {
        await refreshStatus();
        if (generation !== googleGeneration || !ui['login-dialog'].open) return;
      }
      if (!status?.googleClientId) throw new RequestError(m('googleConfig'));
      await loadGoogle();
      if (generation !== googleGeneration || !ui['login-dialog'].open) return;
      window.google.accounts.id.initialize({
        client_id: status.googleClientId, nonce: googleNonce, auto_select: false,
        callback: (response) => handleGoogleCredential(response, generation),
        ux_mode: 'popup', context: 'signin',
      });
      renderGoogleButton(generation);
      loginMessage(loginPurpose === 'admin' ? m('googleAdminPrompt') : m('googlePrompt'));
    } catch (error) {
      if (generation !== googleGeneration) return;
      loginMessage(errorMessage(error), true);
      ui['retry-google'].hidden = false;
    }
  }

  async function openLogin(forSubmission = false, { forAdmin = false, forCommunity = false } = {}) {
    if (authenticating || submitting) return;
    if (!forSubmission || forAdmin) clearPending();
    saveCurrentDraft();
    loginPurpose = forAdmin ? 'admin' : forSubmission ? 'submission' : forCommunity ? 'community' : 'login';
    loginReturnFocus = document.activeElement;
    renderLoginChrome();
    if (!ui['login-dialog'].open) ui['login-dialog'].showModal();
    await prepareGoogle();
  }

  function closeLogin(preservePending = false) {
    if (authenticating) return;
    preservePendingOnClose = preservePending;
    if (!preservePending) clearPending();
    googleGeneration += 1;
    if (ui['login-dialog'].open) ui['login-dialog'].close();
  }

  async function handleGoogleCredential(response, generation) {
    if (authenticating || generation !== googleGeneration || !ui['login-dialog'].open) return;
    if (!response.credential) {
      loginMessage(m('googleIncomplete'), true);
      return;
    }
    const forAdmin = loginPurpose === 'admin';
    const forCommunity = loginPurpose === 'community';
    let freshLoginCompleted = false;
    authenticating = true;
    ui['close-login'].disabled = true;
    ui['google-button-area'].inert = true;
    loginMessage(forAdmin ? m('checkingAdmin') : forCommunity ? m('communityLoginChecking') : m('checkingLoginQuota'));
    renderControls();
    try {
      const data = await request('/api/login', { method: 'POST', body: { credential: response.credential } });
      // Login rotates the session. Use the new CSRF token before any automatic submission.
      authEpoch += 1;
      sessionReadSequence += 1;
      applySession(data);
      freshLoginCompleted = true;
      await refreshSession();
      if (!user) throw new RequestError(m('loginUnavailable'));
      if (forAdmin) {
        clearPending();
        authenticating = false;
        closeLogin(true);
        writeStorage('localStorage', AUTH_PULSE_KEY, String(Date.now()));
        if (user.isAdmin === true) navigateToAdmin();
        else {
          feedback(m('adminDenied'), 'error');
          await loadPrivate().catch(() => {});
        }
        return;
      }
      // Operations may have been paused while the Google popup was open.
      await refreshStatus();
      await loadPrivate();
      authenticating = false;
      closeLogin(true);
      if (forCommunity) communityFeedback(m('communityLoginDone'));
      else feedback(operatingState().proposalsPaused ? m('loggedInPaused', { notice: pausedSubmissionMessage() }) : m('loggedIn'),
        operatingState().proposalsPaused ? 'error' : 'success', { reason: operatingState().proposalsPaused ? 'service' : '' });
      writeStorage('localStorage', AUTH_PULSE_KEY, String(Date.now()));
      if (!forCommunity) await resumeExplicitSend();
    } catch (error) {
      if (!forAdmin && freshLoginCompleted && user) {
        clearPending();
        authenticating = false;
        closeLogin();
        if (forCommunity) communityFeedback(m('communityLoginPreparationFailed'), 'error');
        else feedback(m('loginPreparationFailed'), 'error');
      } else {
        if (forAdmin) clearPending();
        loginMessage(errorMessage(error), true);
        ui['retry-google'].hidden = false;
        googleButtonGeneration = -1;
        ui['google-signin'].replaceChildren();
        try { await refreshSession(); } catch { sessionReady = false; }
      }
    } finally {
      authenticating = false;
      ui['close-login'].disabled = false;
      ui['google-button-area'].inert = false;
      renderControls();
      renderProposals();
    }
  }

  async function logout() {
    if (submitting || authenticating) return;
    authenticating = true;
    clearPending();
    saveCurrentDraft();
    authEpoch += 1;
    renderControls();
    renderProposals();
    try {
      const data = await request('/api/logout', { method: 'POST', body: {} });
      applySession({ ...data, user: null });
      window.google?.accounts?.id?.disableAutoSelect();
      ui['proposal-list'].replaceChildren();
      ui['my-proposals'].hidden = true;
      feedback(m('loggedOut'));
      writeStorage('localStorage', AUTH_PULSE_KEY, String(Date.now()));
      await refreshSession();
    } catch (error) {
      feedback(user ? m('logoutFailed') : m('logoutReconnect'), 'error');
      if (!user) sessionReady = false;
    } finally {
      authenticating = false;
      renderControls();
      renderProposals();
    }
  }

  ui.prompt.addEventListener('input', () => {
    saveCurrentDraft();
    if (pending && pending.body !== ui.prompt.value) clearPending();
    if (!editing?.conflict && editing?.editable !== false && ui['form-feedback'].dataset.kind !== 'error') feedback('');
    renderControls();
  });
  // Persist pre-listener input using the same path as ordinary typing. This is
  // draft recovery only: it creates neither a submission nor a login intent.
  if (earlyDraft) saveCurrentDraft();

  ui.prompt.addEventListener('compositionstart', () => {
    composing = true;
    renderControls();
  });
  ui.prompt.addEventListener('compositionend', () => {
    composing = false;
    saveCurrentDraft();
    renderControls();
  });

  ui['prompt-form'].addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting || authenticating || composing) return;
    const body = ui.prompt.value;
    saveCurrentDraft();
    if (!validateBody(body)) return;
    if (!statusReady || !sessionReady) {
      feedback(m('connectionFirst'), 'error');
      await synchronize();
      return;
    }
    if (!proposalsOpen()) {
      clearPending();
      feedback(operatingState().proposalsPaused ? pausedSubmissionMessage()
        : m('notAccepting'), 'error',
      { reason: operatingState().proposalsPaused ? 'service' : '' });
      return;
    }
    if (!user) {
      queueAfterLogin(body);
      await openLogin(true);
      return;
    }
    if (editing && (!editing.editable || editing.conflict)) return;
    if (!editing && (!quota || quota.remaining <= 0)) {
      clearPending();
      feedback(m('noQuota'), 'error', { reason: 'quota' });
      await loadPrivate().catch(() => {});
      return;
    }
    await sendProposal(body, editing ? null : submissionAttempt(body).requestId);
  });

  ui['login-button'].addEventListener('click', () => { openLogin(false); });
  ui['logout-button'].addEventListener('click', logout);
  ui['close-login'].addEventListener('click', () => closeLogin());
  ui['retry-google'].addEventListener('click', async () => {
    const generation = googleGeneration;
    try { await refreshStatus(); } catch { /* prepareGoogle explains unavailable configuration. */ }
    if (generation !== googleGeneration || !ui['login-dialog'].open || authenticating) return;
    await prepareGoogle();
  });
  ui['retry-connection'].addEventListener('click', () => { synchronize(); });
  ui['login-dialog'].addEventListener('cancel', (event) => {
    if (authenticating) event.preventDefault();
    else { clearPending(); googleGeneration += 1; }
  });
  ui['login-dialog'].addEventListener('close', () => {
    if (ui['login-dialog'].open) return;
    ui['google-signin'].replaceChildren();
    googleButtonGeneration = -1;
    googleButtonWidth = 0;
    if (!preservePendingOnClose) clearPending();
    preservePendingOnClose = false;
    loginPurpose = 'login';
    if (loginReturnFocus?.isConnected && !loginReturnFocus.hidden) loginReturnFocus.focus();
  });
  ui['login-dialog'].addEventListener('click', (event) => {
    if (event.target !== ui['login-dialog']) return;
    const rect = ui['login-dialog'].getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeLogin();
  });
  ui['cancel-edit'].addEventListener('click', () => {
    if (submitting) return;
    endEdit();
    feedback(m('editCancelled'));
    ui.prompt.focus();
  });
  ui['reload-edit'].addEventListener('click', () => {
    const latest = proposals.find((entry) => entry.id === editing?.id);
    if (latest) beginEdit(latest, { useLatest: true });
  });
  ui['copy-edit'].addEventListener('click', () => {
    if (!editing || submitting) return;
    const body = ui.prompt.value;
    endEdit();
    ui.prompt.value = body;
    saveCurrentDraft();
    renderControls();
    feedback(m('editCopied'));
    ui.prompt.focus();
  });
  window.addEventListener('online', () => { synchronize(); });
  window.addEventListener('offline', () => { connectionError(m('offline')); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) synchronize(); });
  window.addEventListener('storage', (event) => {
    if (event.key === AUTH_PULSE_KEY && !submitting && !authenticating) synchronize();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastSyncAt > 15000) synchronize();
  });
  window.addEventListener('resize', () => { renderGoogleButton(); });


  function communityFeedback(message, kind = 'success') {
    communityFeedbackMessage = message;
    ui['community-feedback'].hidden = !message;
    ui['community-feedback'].dataset.kind = kind;
    ui['community-feedback-message'].textContent = localize(message);
    ui['community-retry'].hidden = !communityAttempt?.unknown;
    updateCommunityControls();
  }

  function resetCommunityIdentity() {
    communityMeSequence += 1;
    communityMutationSequence += 1;
    communityMe = null;
    communityMeLoading = false;
    communityMeError = '';
    communityAttempt = null;
    communityMutating = false;
    communityFeedbackMessage = '';
    ui['community-feedback'].hidden = true;
    ui['community-feedback-message'].textContent = '';
    ui['community-retry'].hidden = true;
    ui['my-contribution'].hidden = true;
    ui['my-contribution-summary'].textContent = '';
    for (const id of ['my-rank-value', 'my-rank-alias', 'my-rank-points', 'my-rank-status']) {
      ui[id].textContent = '';
      ui[id].removeAttribute('title');
      ui[id].removeAttribute('aria-label');
    }
    closeAlias({ restoreFocus: false });
    closeIdeas({ restoreFocus: false });
    closeLeaderboard({ restoreFocus: false });
    closeMyProposals({ restoreFocus: false });
  }

  function publicAuthor(value) {
    return value && typeof value.id === 'string' && value.id.length > 0
      && isValidProfileAlias(value.alias);
  }
  const pointString = value => typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) && value.length <= 500;
  const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
  const leaderboardEntry = row => row && publicAuthor(row.author) && pointString(row.points)
    && Number.isSafeInteger(row.rank) && row.rank > 0 && nonnegativeInteger(row.adoptedCount);

  const publicIdea = value => value && typeof value.id === 'string' && value.id.length > 0 && typeof value.body === 'string'
      && encoder.encode(value.body).length <= 2000 && publicAuthor(value.author)
      && Number.isSafeInteger(value.proposalRevision) && value.proposalRevision > 0
      && Number.isSafeInteger(value.publicationRevision) && value.publicationRevision > 0
      && Number.isFinite(Date.parse(value.createdAt)) && nonnegativeInteger(value.upvotes)
      && nonnegativeInteger(value.downvotes) && typeof value.votingOpen === 'boolean'
      && (typeof value.roundId === 'string' || (value.roundId === null && value.votingOpen === false));
  const publicRound = value => value === null || (value && typeof value.id === 'string'
    && ['open', 'closed', 'waiting'].includes(value.status));

  function validateCommunity(data, includeClosed) {
    if (!data || !Array.isArray(data.recent) || !Array.isArray(data.popular)
      || data.recent.length > 100 || data.popular.length > 100
      || !data.recent.every(publicIdea) || !data.popular.every(publicIdea) || !Array.isArray(data.leaderboard?.items)
      || !data.leaderboard.items.every(leaderboardEntry)
      || !publicRound(data.round)
      || (data.includeClosed !== undefined && data.includeClosed !== includeClosed)) {
      throw new RequestError(m('communityInvalid'));
    }
    return data;
  }

  function validateCommunityMe(data) {
    const profile = data?.profile;
    if (!profile || !publicAuthor(profile) || typeof profile.leaderboardVisible !== 'boolean'
      || !Number.isSafeInteger(profile.revision) || profile.revision < 1
      || !pointString(data.contribution?.points) || !nonnegativeInteger(data.contribution?.adoptedCount)
      || !(data.contribution.rank === null || (Number.isSafeInteger(data.contribution.rank) && data.contribution.rank > 0))
      || !Array.isArray(data.votes) || !data.votes.every(vote => vote && typeof vote.publicId === 'string'
        && ['up', 'down'].includes(vote.direction) && typeof vote.roundId === 'string'
        && Number.isSafeInteger(vote.proposalRevision) && Number.isSafeInteger(vote.publicationRevision))
      || !Array.isArray(data.publications) || !data.publications.every(item => item
        && typeof item.proposalId === 'string' && Number.isSafeInteger(item.proposalRevision)
        && nonnegativeInteger(item.publicationRevision) && typeof item.requested === 'boolean'
        && typeof item.eligible === 'boolean')
      || (data.voteQuota !== null && (!data.voteQuota || !nonnegativeInteger(data.voteQuota.remaining)
        || !nonnegativeInteger(data.voteQuota.used) || !nonnegativeInteger(data.voteQuota.limit)))) {
      throw new RequestError(m('communityPrivateUnavailable'));
    }
    return data;
  }

  async function loadCommunity() {
    const sequence = ++communitySequence;
    const requestedIncludeClosed = includeClosedIdeas;
    communityLoading = true;
    communityError = '';
    refreshOpenLeaderboard();
    refreshOpenIdeas();
    renderCommunity();
    try {
      const data = validateCommunity(await request('/api/community' + (requestedIncludeClosed ? '?includeClosed=1' : '')), requestedIncludeClosed);
      if (sequence !== communitySequence || requestedIncludeClosed !== includeClosedIdeas) return;
      communityData = data;
    } catch (error) {
      if (sequence !== communitySequence) return;
      // A failed refresh must not keep displaying content that may have been withdrawn.
      communityData = null;
      communityError = m('communityUnavailable');
      if (ui['ideas-dialog'].open) {
        clearIdeasView();
        ideasError = m('ideasUnavailable');
        renderIdeasDialog();
      }
      if (ui['leaderboard-dialog'].open) {
        clearLeaderboardView();
        leaderboardError = m('leaderboardUnavailable');
        renderLeaderboardDialog();
      }
    } finally {
      if (sequence === communitySequence) {
        communityLoading = false;
        renderCommunity();
      }
    }
  }

  async function loadCommunityMe({ force = false, identityRetry = true } = {}) {
    if (!user || !sessionReady) return;
    const epoch = authEpoch;
    const ownerId = user.id;
    if (!force && communityMePromise && communityMePromiseEpoch === epoch) return communityMePromise;
    const sequence = ++communityMeSequence;
    communityMeLoading = true;
    communityMeError = '';
    communityMePromiseEpoch = epoch;
    const promise = (async () => {
      try {
        const data = await request('/api/community?view=me');
        if (epoch !== authEpoch || sequence !== communityMeSequence || user?.id !== ownerId) return;
        if (typeof data?.ownerId !== 'string' || !data.ownerId) throw new RequestError(m('communityPrivateUnavailable'));
        if (data.ownerId !== ownerId) {
          // A shared cookie can change before its cross-tab notification arrives.
          // Never render another account's profile, score or voting history.
          invalidatePrivate({ identityChanged: true });
          authEpoch += 1;
          resetCommunityIdentity();
          sessionReady = false;
          communityFeedback(m('communityAccountChanged'), 'error');
          renderControls();
          if (!identityRetry) throw new RequestError(m('communityAccountChanged'));
          await refreshSession();
          if (user && sessionReady) {
            await loadPrivate({ restoreEdit: false });
            await loadCommunityMe({ force: true, identityRetry: false });
          }
          return;
        }
        communityMe = validateCommunityMe(data);
        renderProposals();
        renderCommunity();
        refreshIdeaDialog();
      } catch (error) {
        if (epoch !== authEpoch || sequence !== communityMeSequence) return;
        communityMe = null;
        communityMeError = m('myRankUnavailable');
        if (error.status === 401) {
          clearPending();
          applySession({ user: null, csrfToken, googleNonce });
          sessionReady = false;
          renderControls();
          refreshSession().catch(() => {});
        } else if (!communityAttempt?.unknown) {
          communityFeedback(m('communityPrivateUnavailable'), 'error');
        }
        renderProposals();
        renderCommunity();
        refreshIdeaDialog();
      } finally {
        if (epoch === authEpoch && sequence === communityMeSequence) {
          communityMeLoading = false;
          renderCommunity();
        }
      }
    })();
    communityMePromise = promise;
    try { return await promise; }
    finally { if (communityMePromise === promise) communityMePromise = null; }
  }

  function voteFor(idea) {
    return communityMe?.votes.find(vote => vote.publicId === idea.id && vote.roundId === idea.roundId
      && vote.proposalRevision === idea.proposalRevision && vote.publicationRevision === idea.publicationRevision);
  }

  function sourceIdeas(source = 'main') {
    return source === 'all'
      ? ui['ideas-dialog'].open && !ideasLoading ? fullIdeas?.items || [] : []
      : [...(communityData?.recent || []), ...(communityData?.popular || [])];
  }

  function sourceRound(source = 'main') {
    return source === 'all' ? fullIdeas?.round : communityData?.round;
  }

  function votingIsOpen(idea, round) {
    return idea.votingOpen && round?.status === 'open' && idea.roundId === round.id
      && (!round.closesAt || Date.parse(round.closesAt) > serverNow());
  }

  function voteQuotaText(round) {
    return !user ? t('voteLoginNote') : !communityMe ? t('voteSettingsLoading')
      : !communityMe.voteQuota?.roundId || communityMe.voteQuota.roundId !== round?.id
        || round?.status !== 'open' ? t('votingWaiting')
        : t('voteQuota', { remaining: communityMe.voteQuota.remaining, limit: communityMe.voteQuota.limit })
          + ' · ' + t('voteQuotaNote');
  }

  function validateIdeasPage(data, sort, offset, includeClosed) {
    if (!data || !Array.isArray(data.items) || data.items.length > IDEAS_PAGE_SIZE
      || !data.items.every(publicIdea) || !publicRound(data.round)
      || data.sort !== sort || data.offset !== offset || data.limit !== IDEAS_PAGE_SIZE
      || !nonnegativeInteger(data.total) || typeof data.hasMore !== 'boolean'
      || data.items.length !== Math.max(0, Math.min(IDEAS_PAGE_SIZE, data.total - offset))
      || data.hasMore !== (offset + data.items.length < data.total)
      || (data.includeClosed !== undefined && data.includeClosed !== includeClosed)
      || new Set(data.items.map(idea => idea.id)).size !== data.items.length) {
      throw new RequestError(m('ideasInvalid'));
    }
    return data;
  }

  function clearIdeasView() {
    ideasSequence += 1;
    ideasLoading = false;
    ideasRefreshQueued = false;
    ideasKeepReader = false;
    ideasError = '';
    fullIdeas = null;
    if (activeIdea?.source === 'all') closeIdea();
    renderIdeasDialog();
  }

  async function loadIdeasPage(offset = ideasOffset, { adjustPage = true, preserveReader = false } = {}) {
    if (!ui['ideas-dialog'].open) return;
    const sequence = ++ideasSequence;
    const epoch = authEpoch;
    const sort = ideasSort;
    const requestedIncludeClosed = includeClosedIdeas;
    const requestedOffset = Math.max(0, offset);
    ideasOffset = requestedOffset;
    ideasLoading = true;
    ideasKeepReader = preserveReader && activeIdea?.source === 'all';
    ideasError = '';
    fullIdeas = null;
    if (activeIdea?.source === 'all' && !ideasKeepReader) closeIdea();
    renderIdeasDialog();
    try {
      const data = validateIdeasPage(await request('/api/community?view=ideas&sort=' + sort
        + '&offset=' + requestedOffset + '&limit=' + IDEAS_PAGE_SIZE + (requestedIncludeClosed ? '&includeClosed=1' : '')),
      sort, requestedOffset, requestedIncludeClosed);
      if (sequence !== ideasSequence || epoch !== authEpoch || !ui['ideas-dialog'].open
        || sort !== ideasSort || requestedIncludeClosed !== includeClosedIdeas) return;
      if (ideasRefreshQueued) return;
      const lastOffset = Math.max(0, Math.floor((data.total - 1) / IDEAS_PAGE_SIZE) * IDEAS_PAGE_SIZE);
      if (requestedOffset > lastOffset) {
        if (!adjustPage) throw new RequestError(m('ideasInvalid'));
        await loadIdeasPage(lastOffset, { adjustPage: false });
        return;
      }
      fullIdeas = data;
    } catch (error) {
      if (sequence !== ideasSequence || epoch !== authEpoch || !ui['ideas-dialog'].open) return;
      fullIdeas = null;
      ideasError = m('ideasUnavailable');
    } finally {
      if (sequence === ideasSequence && epoch === authEpoch) {
        ideasLoading = false;
        if (ideasRefreshQueued && ui['ideas-dialog'].open) {
          ideasRefreshQueued = false;
          loadIdeasPage(ideasOffset, { preserveReader: ideasKeepReader }).catch(() => {});
        } else renderIdeasDialog();
      }
    }
  }

  function refreshOpenIdeas() {
    if (!ui['ideas-dialog'].open) return;
    if (ideasLoading) {
      ideasRefreshQueued = true;
      fullIdeas = null;
      renderIdeasDialog();
    } else loadIdeasPage(ideasOffset, { preserveReader: true }).catch(() => {});
  }

  function updateIdeasControls() {
    const busy = communityMutating || submitting || authenticating;
    ui['open-ideas'].disabled = busy;
    ui['ideas-refresh'].disabled = busy || ideasLoading;
    ui['ideas-retry'].hidden = !ideasError;
    ui['ideas-retry'].disabled = busy || ideasLoading;
    ui['ideas-prev'].disabled = busy || ideasLoading || !fullIdeas || ideasOffset === 0;
    ui['ideas-next'].disabled = busy || ideasLoading || !fullIdeas?.hasMore;
    for (const tab of document.querySelectorAll('[data-ideas-sort]')) tab.disabled = busy;
    ui['ideas-vote-note'].textContent = voteQuotaText(fullIdeas?.round);
    ui['ideas-feedback'].hidden = !communityFeedbackMessage;
    ui['ideas-feedback'].dataset.kind = ui['community-feedback'].dataset.kind || '';
    ui['ideas-feedback-message'].textContent = localize(communityFeedbackMessage);
    ui['ideas-action-retry'].hidden = !communityAttempt?.unknown;
    ui['ideas-action-retry'].disabled = busy || !user || !sessionReady || communityAttempt?.actorId !== user?.id;
  }

  function renderIdeasDialog() {
    const focused = document.activeElement;
    const focusedArticle = focused?.closest?.('#ideas-list [data-public-id]');
    const focusId = focusedArticle?.dataset.publicId;
    const focusDirection = focused?.dataset.direction;
    const focusRead = focused?.classList.contains('community-read');
    const loginReturnId = loginReturnFocus?.closest?.('#ideas-list [data-public-id]')?.dataset.publicId;
    const loginReturnDirection = loginReturnFocus?.dataset.direction;
    ui['ideas-total'].textContent = fullIdeas ? t('ideasTotal', { total: fullIdeas.total.toLocaleString(i18n.intlLocale) }) : '';
    const message = ideasError || (ideasLoading ? m('communityLoading') : fullIdeas && !fullIdeas.items.length
      ? m(includeClosedIdeas ? 'communityEmpty' : 'currentIdeasEmpty') : '');
    ui['ideas-status'].hidden = !message;
    ui['ideas-status'].textContent = localize(message);
    ui['ideas-status'].dataset.kind = ideasError ? 'error' : '';
    ui['ideas-panel'].setAttribute('aria-busy', String(ideasLoading));
    ui['ideas-panel'].setAttribute('aria-labelledby', ideasSort === 'recent' ? 'ideas-recent-tab' : 'ideas-popular-tab');
    for (const tab of document.querySelectorAll('[data-ideas-sort]')) {
      const selected = tab.dataset.ideasSort === ideasSort;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    ui['ideas-page'].textContent = fullIdeas ? t('feedPage', { page: Math.floor(ideasOffset / IDEAS_PAGE_SIZE) + 1,
      pages: Math.max(1, Math.ceil(fullIdeas.total / IDEAS_PAGE_SIZE)) }) : '';
    ui['ideas-list'].replaceChildren();
    ui['ideas-table'].hidden = !fullIdeas?.items.length;
    for (const [index, idea] of (fullIdeas?.items || []).entries()) {
      ui['ideas-list'].append(createCommunityCard(idea, 'all', index));
    }
    if (loginReturnId) {
      const row = [...ui['ideas-list'].children].find(element => element.dataset.publicId === loginReturnId);
      // Locale/session rendering can replace the underlying card while Google
      // is open. Preserve the return target without touching its auth flow.
      loginReturnFocus = [...(row?.querySelectorAll('[data-direction]') || [])]
        .find(button => button.dataset.direction === loginReturnDirection)
        || byId(ideasSort === 'recent' ? 'ideas-recent-tab' : 'ideas-popular-tab');
    }
    updateCommunityControls();
    if (focusId && ui['ideas-dialog'].open && !ui['idea-dialog'].open && !ui['login-dialog'].open) {
      const article = [...ui['ideas-list'].children].find(element => element.dataset.publicId === focusId);
      const replacement = focusRead ? article?.querySelector('.community-read')
        : [...(article?.querySelectorAll('[data-direction]') || [])].find(button => button.dataset.direction === focusDirection);
      if (replacement && !replacement.disabled) replacement.focus({ preventScroll: true });
    }
  }

  function openIdeas() {
    if (ui['ideas-dialog'].open || submitting || authenticating || communityMutating) return;
    saveCurrentDraft();
    ideasReturnFocus = document.activeElement;
    ideasSort = communitySort;
    ideasOffset = 0;
    ui['ideas-dialog'].showModal();
    loadIdeasPage(0).catch(() => {});
  }

  function closeIdeas({ restoreFocus = true } = {}) {
    if (!restoreFocus) ideasReturnFocus = null;
    clearIdeasView();
    if (ui['ideas-dialog'].open) ui['ideas-dialog'].close();
  }

  function createLeaderboardRow(entry) {
    const row = document.createElement('li');
    row.className = 'leaderboard-entry';
    row.dataset.authorId = entry.author.id;
    row.classList.toggle('is-own-rank', communityMe?.profile.id === entry.author.id);
    for (const [className, text] of [['leaderboard-rank', entry.rank.toLocaleString(i18n.intlLocale)],
      ['community-alias', entry.author.alias], ['leaderboard-points', entry.points]]) {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      span.title = text;
      if (className === 'leaderboard-points') span.setAttribute('aria-label', t('pointsAria', { points: entry.points }));
      if (className === 'leaderboard-rank') span.setAttribute('aria-label', t('rankAria', { rank: text }));
      row.append(span);
    }
    return row;
  }

  function renderMyRank() {
    const ready = Boolean(user && communityMe);
    ui['my-rank-guest'].hidden = Boolean(user);
    ui['my-rank-login'].disabled = !sessionReady || authenticating || submitting;
    ui['my-rank-loading'].hidden = !user || ready;
    ui['my-rank-loading-message'].textContent = user && !ready
      ? localize(communityMeError || m('myRankLoading')) : '';
    ui['my-rank-retry'].disabled = !sessionReady || communityMeLoading || authenticating;
    ui['my-contribution'].hidden = !ready;
    if (!ready) {
      for (const id of ['my-rank-value', 'my-rank-alias', 'my-rank-points', 'my-rank-status', 'my-contribution-summary']) {
        ui[id].textContent = '';
        ui[id].removeAttribute('title');
        ui[id].removeAttribute('aria-label');
      }
      return;
    }
    const { rank, points, adoptedCount } = communityMe.contribution;
    ui['my-rank-value'].textContent = rank === null ? '—' : rank.toLocaleString(i18n.intlLocale);
    ui['my-rank-value'].title = rank === null ? t('myRankNotListed') : t('rankAria', { rank });
    ui['my-rank-value'].setAttribute('aria-label', ui['my-rank-value'].title);
    ui['my-rank-alias'].textContent = communityMe.profile.alias;
    ui['my-rank-alias'].title = communityMe.profile.alias;
    ui['my-rank-points'].textContent = points;
    ui['my-rank-points'].title = points;
    ui['my-rank-points'].setAttribute('aria-label', t('pointsAria', { points }));
    ui['my-rank-status'].hidden = rank !== null;
    ui['my-rank-status'].textContent = rank === null ? t('myRankNotListed') : '';
    ui['my-contribution-summary'].textContent = t('yourContribution', { points, count: adoptedCount });
  }

  function validateLeaderboardPage(data, offset) {
    if (!data || !Array.isArray(data.items) || data.items.length > LEADERBOARD_PAGE_SIZE
      || !data.items.every(leaderboardEntry) || data.offset !== offset || data.limit !== LEADERBOARD_PAGE_SIZE
      || !nonnegativeInteger(data.total) || typeof data.hasMore !== 'boolean'
      || data.items.length !== Math.max(0, Math.min(LEADERBOARD_PAGE_SIZE, data.total - offset))
      || data.hasMore !== (offset + data.items.length < data.total)
      || new Set(data.items.map(row => row.author.id)).size !== data.items.length
      || data.items.some((row, index) => row.rank > data.total || (index > 0 && row.rank < data.items[index - 1].rank))) {
      throw new RequestError(m('leaderboardInvalid'));
    }
    return data;
  }

  async function loadLeaderboardPage(offset = leaderboardOffset, { adjustPage = true } = {}) {
    if (!ui['leaderboard-dialog'].open) return;
    const sequence = ++leaderboardSequence;
    const epoch = authEpoch;
    leaderboardOffset = Math.max(0, offset);
    const requestedOffset = leaderboardOffset;
    leaderboardLoading = true;
    leaderboardError = '';
    fullLeaderboard = null;
    renderLeaderboardDialog();
    try {
      const data = validateLeaderboardPage(await request('/api/community?view=leaderboard&offset='
        + requestedOffset + '&limit=' + LEADERBOARD_PAGE_SIZE), requestedOffset);
      if (sequence !== leaderboardSequence || epoch !== authEpoch || !ui['leaderboard-dialog'].open) return;
      if (leaderboardRefreshQueued) return;
      const lastOffset = Math.max(0, Math.floor((data.total - 1) / LEADERBOARD_PAGE_SIZE) * LEADERBOARD_PAGE_SIZE);
      if (data.offset > lastOffset) {
        if (!adjustPage) throw new RequestError(m('leaderboardInvalid'));
        await loadLeaderboardPage(lastOffset, { adjustPage: false });
        return;
      }
      fullLeaderboard = data;
    } catch (error) {
      if (sequence !== leaderboardSequence || epoch !== authEpoch || !ui['leaderboard-dialog'].open) return;
      fullLeaderboard = null;
      leaderboardError = m('leaderboardUnavailable');
    } finally {
      if (sequence === leaderboardSequence && epoch === authEpoch) {
        leaderboardLoading = false;
        if (leaderboardRefreshQueued && ui['leaderboard-dialog'].open) {
          leaderboardRefreshQueued = false;
          loadLeaderboardPage().catch(() => {});
        } else renderLeaderboardDialog();
      }
    }
  }

  function refreshOpenLeaderboard() {
    if (!ui['leaderboard-dialog'].open) return;
    if (leaderboardLoading) {
      // Coalesce refreshes behind the current read; its old snapshot is discarded.
      leaderboardRefreshQueued = true;
      fullLeaderboard = null;
      renderLeaderboardDialog();
    } else loadLeaderboardPage().catch(() => {});
  }

  function renderLeaderboardDialog() {
    ui['leaderboard-full-panel'].setAttribute('aria-busy', String(leaderboardLoading));
    ui['leaderboard-total'].textContent = fullLeaderboard
      ? t('leaderboardTotal', { total: fullLeaderboard.total.toLocaleString(i18n.intlLocale) }) : '';
    const message = leaderboardError || (leaderboardLoading ? m('leaderboardLoading')
      : fullLeaderboard && !fullLeaderboard.items.length ? m('leaderboardEmpty') : '');
    ui['leaderboard-full-status'].textContent = localize(message);
    ui['leaderboard-full-status'].hidden = !message;
    ui['leaderboard-full-status'].dataset.kind = leaderboardError ? 'error' : '';
    ui['leaderboard-full-list'].replaceChildren();
    for (const entry of fullLeaderboard?.items || []) ui['leaderboard-full-list'].append(createLeaderboardRow(entry));
    ui['leaderboard-full-prev'].disabled = leaderboardLoading || !fullLeaderboard || leaderboardOffset === 0;
    ui['leaderboard-full-next'].disabled = leaderboardLoading || !fullLeaderboard || !fullLeaderboard.hasMore;
    ui['leaderboard-full-retry'].hidden = !leaderboardError;
    ui['leaderboard-full-retry'].disabled = leaderboardLoading;
    ui['leaderboard-full-page'].textContent = fullLeaderboard ? t('leaderboardPage', {
      page: Math.floor(leaderboardOffset / LEADERBOARD_PAGE_SIZE) + 1,
      pages: Math.max(1, Math.ceil(fullLeaderboard.total / LEADERBOARD_PAGE_SIZE)),
    }) : '';
  }

  function openLeaderboard() {
    if (ui['leaderboard-dialog'].open) return;
    saveCurrentDraft();
    leaderboardReturnFocus = document.activeElement;
    ui['leaderboard-dialog'].showModal();
    loadLeaderboardPage(0).catch(() => {});
  }

  function clearLeaderboardView() {
    leaderboardSequence += 1;
    leaderboardLoading = false;
    leaderboardRefreshQueued = false;
    leaderboardError = '';
    fullLeaderboard = null;
    renderLeaderboardDialog();
  }

  function closeLeaderboard({ restoreFocus = true } = {}) {
    if (!restoreFocus) leaderboardReturnFocus = null;
    clearLeaderboardView();
    if (ui['leaderboard-dialog'].open) ui['leaderboard-dialog'].close();
    else leaderboardReturnFocus = null;
  }

  function openAlias() {
    if (!user || !communityMe || !sessionReady || submitting || authenticating || communityMutating
      || ui['alias-dialog'].open) return;
    const prior = communityAttempt?.unknown && communityAttempt.actorId === user.id
      && communityAttempt.payload.action === 'set_profile_alias' ? communityAttempt : null;
    if (communityAttempt?.unknown && !prior) return;
    saveCurrentDraft();
    aliasReturnFocus = document.activeElement;
    aliasEditor = { actorId: user.id, profileId: communityMe.profile.id,
      revision: prior?.payload.revision || communityMe.profile.revision, composing: false,
      reloading: false, validationShown: false, message: '', kind: '' };
    ui['alias-input'].value = prior?.payload.alias || communityMe.profile.alias;
    renderAlias();
    ui['alias-dialog'].showModal();
    ui['alias-input'].focus();
  }

  function renderAlias() {
    if (!aliasEditor) return;
    if (!user || aliasEditor.actorId !== user.id || (communityMe && aliasEditor.profileId !== communityMe.profile.id)) {
      closeAlias({ restoreFocus: false });
      return;
    }
    const pendingAlias = communityAttempt?.actorId === aliasEditor.actorId
      && communityAttempt.payload.action === 'set_profile_alias' ? communityAttempt : null;
    const unknown = Boolean(pendingAlias?.unknown);
    const busy = communityMutating || submitting || authenticating || aliasEditor.reloading;
    const conflict = Boolean(communityMe && aliasEditor.revision !== communityMe.profile.revision);
    const normalized = normalizeProfileAlias(ui['alias-input'].value);
    const counted = ui['alias-input'].value.normalize('NFC').trim();
    ui['alias-count'].textContent = t('aliasCount', { count: [...counted].length,
      maxCount: PROFILE_ALIAS_LIMITS.maxCodePoints, bytes: encoder.encode(counted).length,
      maxBytes: PROFILE_ALIAS_LIMITS.maxBytes });
    ui['alias-input'].disabled = busy || unknown;
    ui['alias-input'].setAttribute('aria-invalid', String(aliasEditor.validationShown && !normalized));
    ui['alias-current'].textContent = communityMe ? t('aliasCurrent', { alias: communityMe.profile.alias }) : '';
    const message = communityMutating && pendingAlias ? m('aliasSaving')
      : unknown ? pendingAlias.message || m('communityUnknown')
        : conflict ? m('aliasConflict')
          : !communityMe ? m('communityPrivateUnavailable')
            : aliasEditor.validationShown && !normalized ? { api: 'INVALID_PROFILE_ALIAS' } : aliasEditor.message;
    ui['alias-message'].textContent = localize(message);
    ui['alias-message'].hidden = !message;
    ui['alias-message'].dataset.kind = unknown || conflict || !communityMe
      || (aliasEditor.validationShown && !normalized) ? 'error' : aliasEditor.kind;
    ui['alias-form'].setAttribute('aria-busy', String(communityMutating && Boolean(pendingAlias)));
    ui['alias-save'].disabled = busy || Boolean(communityAttempt?.unknown) || !sessionReady || !communityMe
      || conflict || aliasEditor.composing || !normalized || normalized === communityMe.profile.alias;
    ui['alias-save'].textContent = t(communityMutating && pendingAlias ? 'saving' : 'saveAlias');
    ui['alias-retry'].hidden = !unknown;
    ui['alias-retry'].disabled = busy || !sessionReady;
    ui['alias-reload'].hidden = unknown || (!conflict && Boolean(communityMe));
    ui['alias-reload'].disabled = busy || !sessionReady;
  }

  function clearAliasEditor() {
    aliasEditor = null;
    ui['alias-input'].value = '';
    ui['alias-input'].removeAttribute('aria-invalid');
    for (const id of ['alias-current', 'alias-message', 'alias-count']) ui[id].textContent = '';
    ui['alias-save'].disabled = true;
    ui['alias-retry'].hidden = true;
    ui['alias-reload'].hidden = true;
  }

  function closeAlias({ restoreFocus = true } = {}) {
    if (!restoreFocus) aliasReturnFocus = null;
    clearAliasEditor();
    if (ui['alias-dialog'].open) ui['alias-dialog'].close();
    else aliasReturnFocus = null;
  }

  async function reloadAliasProfile() {
    if (!aliasEditor || communityMutating || communityAttempt?.unknown || aliasEditor.reloading) return;
    const editor = aliasEditor;
    const epoch = authEpoch;
    editor.reloading = true;
    renderAlias();
    await loadCommunityMe({ force: true });
    if (editor !== aliasEditor || epoch !== authEpoch || user?.id !== editor.actorId) return;
    editor.reloading = false;
    if (communityMe && communityMe.profile.id === editor.profileId) {
      editor.revision = communityMe.profile.revision;
      editor.message = m('aliasRefreshed');
      editor.kind = '';
    }
    renderAlias();
  }

  function reflectAlias(profileId, alias) {
    if (!profileId || !isValidProfileAlias(alias)) return;
    if (communityMe?.profile.id === profileId) communityMe.profile.alias = alias;
    for (const idea of [...(communityData?.recent || []), ...(communityData?.popular || []), ...(fullIdeas?.items || [])]) {
      if (idea.author.id === profileId) idea.author.alias = alias;
    }
    for (const row of [...(communityData?.leaderboard.items || []), ...(fullLeaderboard?.items || [])]) {
      if (row.author.id === profileId) row.author.alias = alias;
    }
    renderCommunity();
  }

  function updateCommunityControls() {
    const busy = communityMutating || submitting || authenticating;
    for (const toggle of document.querySelectorAll('[data-ideas-history-toggle]')) {
      toggle.checked = includeClosedIdeas;
      toggle.disabled = busy;
    }
    for (const button of document.querySelectorAll('[data-community-action]')) {
      button.disabled = busy || Boolean(communityAttempt?.unknown) || button.dataset.baseDisabled === 'true';
    }
    ui['community-refresh'].disabled = communityLoading || communityMutating;
    ui['community-retry'].hidden = !communityAttempt?.unknown;
    ui['community-retry'].disabled = busy || !user || !sessionReady
      || communityAttempt?.actorId !== user?.id;
    ui['edit-alias'].disabled = busy || !user || !sessionReady || !communityMe
      || (Boolean(communityAttempt?.unknown) && communityAttempt.payload.action !== 'set_profile_alias');
    renderMyRank();
    renderAlias();
    updateIdeasControls();
    refreshIdeaDialog();
  }

  function createCommunityCard(idea, source = 'main', index = 0) {
    const tableRow = source === 'all';
    const mine = communityMe?.profile.id === idea.author.id;
    const ownNoteId = 'own-vote-' + source + '-' + index;
    const article = document.createElement(tableRow ? 'tr' : 'article');
    article.className = tableRow ? 'ideas-row' : 'community-entry';
    article.dataset.publicId = idea.id;
    article.dataset.ideaSource = source;
    const header = document.createElement(tableRow ? 'span' : 'div');
    header.className = 'community-entry-header';
    const alias = document.createElement('strong');
    alias.className = 'community-alias';
    alias.textContent = idea.author.alias;
    alias.title = idea.author.alias;
    const authorLine = document.createElement(tableRow ? 'span' : 'div');
    authorLine.className = 'community-author';
    authorLine.append(alias);
    if (mine) {
      const badge = document.createElement('span');
      badge.className = 'own-idea-badge';
      badge.textContent = t('yourIdea');
      authorLine.append(badge);
    }
    const time = document.createElement('time');
    time.dateTime = idea.createdAt;
    time.textContent = proposalDate(idea.createdAt);
    const details = document.createElement(tableRow ? 'span' : 'div');
    details.className = 'community-entry-details';
    details.append(time);
    header.append(authorLine, details);
    const body = document.createElement(tableRow ? 'span' : 'p');
    body.className = 'community-body';
    body.textContent = idea.body;
    const voting = document.createElement('div');
    voting.className = 'community-votes';
    const vote = voteFor(idea);
    const open = votingIsOpen(idea, sourceRound(source));
    for (const direction of ['up', 'down']) {
      const selected = vote?.direction === direction;
      const count = direction === 'up' ? idea.upvotes : idea.downvotes;
      const button = document.createElement('button');
      button.className = 'vote-button';
      button.type = 'button';
      button.dataset.communityAction = 'vote';
      button.dataset.direction = direction;
      button.dataset.baseDisabled = String(!open || mine || !sessionReady
        || (Boolean(user) && (!communityMe || !communityMe.voteQuota || communityMe.voteQuota.roundId !== idea.roundId
          || (!vote && communityMe.voteQuota.remaining <= 0))));
      button.setAttribute('aria-pressed', String(selected));
      if (mine) button.setAttribute('aria-describedby', ownNoteId);
      button.setAttribute('aria-label', t('voteCountAria', { action: t(selected
        ? direction === 'up' ? 'removeUpvote' : 'removeDownvote'
        : direction === 'up' ? 'upvote' : 'downvote'), count }));
      if (tableRow) button.title = button.getAttribute('aria-label');
      const arrow = document.createElement('span');
      arrow.textContent = direction === 'up' ? '↑' : '↓';
      arrow.setAttribute('aria-hidden', 'true');
      const number = document.createElement('span');
      number.textContent = count.toLocaleString(i18n.intlLocale);
      button.append(arrow, number);
      button.addEventListener('click', () => castVote(idea, direction, source));
      voting.append(button);
    }
    if (!open) {
      const note = document.createElement('span');
      note.className = 'vote-note';
      note.textContent = t('votingClosed');
      details.append(note);
    }
    const read = document.createElement('button');
    read.type = 'button';
    read.className = 'text-button community-read';
    read.textContent = t('readIdea');
    read.setAttribute('aria-label', t('readIdeaAria', { alias: idea.author.alias }));
    read.setAttribute('aria-haspopup', 'dialog');
    read.setAttribute('aria-controls', 'idea-dialog');
    read.addEventListener('click', () => openIdea(idea, read, source));
    let noteContainer = article;
    if (tableRow) {
      const detailsCell = document.createElement('td');
      detailsCell.className = 'ideas-details-cell';
      const votesCell = document.createElement('td');
      votesCell.className = 'ideas-votes-cell';
      const excerpt = document.createElement('span');
      excerpt.className = 'ideas-excerpt';
      const arrow = document.createElement('span');
      arrow.className = 'ideas-open-mark';
      arrow.textContent = '↗';
      arrow.setAttribute('aria-hidden', 'true');
      excerpt.append(body, arrow);
      body.id = 'idea-excerpt-' + source + '-' + index;
      read.setAttribute('aria-describedby', body.id);
      read.classList.add('ideas-row-read');
      read.replaceChildren(excerpt, header);
      detailsCell.append(read);
      votesCell.append(voting);
      article.append(detailsCell, votesCell);
      noteContainer = detailsCell;
    } else {
      voting.append(read);
      article.append(header, body, voting);
    }
    if (mine) {
      const note = document.createElement('span');
      note.className = 'sr-only';
      note.id = ownNoteId;
      note.textContent = t('ownVoteExplanation');
      noteContainer.append(note);
    }
    return article;
  }

  function renderCommunity() {
    const rows = communityData?.[communitySort] || [];
    const pages = Math.max(1, Math.ceil(rows.length / 3));
    communityPage = Math.min(communityPage, pages - 1);
    const statusMessage = communityError || (!communityData || (communityLoading && !rows.length) ? m('communityLoading')
      : !rows.length ? m(includeClosedIdeas ? 'communityEmpty' : 'currentIdeasEmpty') : '');
    ui['community-feed-status'].hidden = !statusMessage;
    ui['community-feed-status'].textContent = localize(statusMessage);
    ui['community-feed-status'].dataset.kind = communityError ? 'error' : '';
    ui['community-feed-panel'].setAttribute('aria-busy', String(communityLoading));
    ui['community-feed-panel'].setAttribute('aria-labelledby', communitySort === 'recent' ? 'feed-recent-tab' : 'feed-popular-tab');
    for (const tab of document.querySelectorAll('[data-feed-sort]')) {
      const selected = tab.dataset.feedSort === communitySort;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    ui['community-prev'].disabled = communityPage === 0;
    ui['community-next'].disabled = communityPage >= pages - 1;
    ui['community-page'].textContent = t('feedPage', { page: communityPage + 1, pages });
    ui['community-feed-list'].replaceChildren();
    for (const [index, idea] of rows.slice(communityPage * 3, communityPage * 3 + 3).entries()) {
      ui['community-feed-list'].append(createCommunityCard(idea, 'main', communityPage * 3 + index));
    }
    ui['community-vote-note'].hidden = !communityData;
    ui['community-vote-note'].textContent = voteQuotaText(communityData?.round);
    const leaders = (communityData?.leaderboard.items || []).slice(0, 5);
    ui['leaderboard-status'].hidden = Boolean(communityData && leaders.length);
    ui['leaderboard-status'].textContent = localize(communityError || (!communityData ? m('leaderboardLoading') : m('leaderboardEmpty')));
    ui['leaderboard-status'].dataset.kind = communityError ? 'error' : '';
    ui['leaderboard-list'].replaceChildren();
    for (const entry of leaders) ui['leaderboard-list'].append(createLeaderboardRow(entry));
    ui['community-feedback-message'].textContent = localize(communityFeedbackMessage);
    renderIdeasDialog();
    renderLeaderboardDialog();
    updateCommunityControls();
  }

  function openMyProposals() {
    if (!user || !privateReady || submitting || authenticating || ui['my-proposals-dialog'].open) return;
    saveCurrentDraft();
    proposalsReturnFocus = document.activeElement;
    renderProposals();
    ui['my-proposals-dialog'].showModal();
  }

  function closeMyProposals({ restoreFocus = true } = {}) {
    if (!restoreFocus) proposalsReturnFocus = null;
    if (ui['my-proposals-dialog'].open) ui['my-proposals-dialog'].close();
  }

  function openIdea(idea, sourceButton, source = 'main') {
    activeIdea = { id: idea.id, proposalRevision: idea.proposalRevision,
      publicationRevision: idea.publicationRevision, body: idea.body, source,
      alias: idea.author.alias, createdAt: idea.createdAt };
    ideaReturnFocus = sourceButton;
    ideaReturnContext = { id: idea.id, source };
    refreshIdeaDialog();
    if (activeIdea && !ui['idea-dialog'].open) ui['idea-dialog'].showModal();
  }

  function refreshIdeaDialog() {
    if (!activeIdea) return;
    // A background check disables list actions, but doesn't interrupt reading
    // the unchanged source. A completed failure or revision change closes it.
    if (activeIdea.source === 'all' && ideasLoading && ideasKeepReader) {
      ui['idea-title'].textContent = t('ideaTitle');
      ui['idea-author'].textContent = activeIdea.alias + ' · ' + proposalDate(activeIdea.createdAt);
      return;
    }
    const idea = sourceIdeas(activeIdea.source).find(item => item.id === activeIdea.id);
    // A replaced or withdrawn revision must not linger in an open reader.
    if (!idea || idea.proposalRevision !== activeIdea.proposalRevision
      || idea.publicationRevision !== activeIdea.publicationRevision || idea.body !== activeIdea.body) {
      closeIdea();
      return;
    }
    ui['idea-title'].textContent = t('ideaTitle');
    ui['idea-author'].textContent = idea.author.alias + ' · ' + proposalDate(idea.createdAt);
    activeIdea.alias = idea.author.alias;
    if (ui['idea-body'].textContent !== idea.body) ui['idea-body'].textContent = idea.body;
  }

  function closeIdea() {
    activeIdea = null;
    ui['idea-body'].textContent = '';
    ui['idea-author'].textContent = '';
    if (ui['idea-dialog'].open) ui['idea-dialog'].close();
    else { ideaReturnFocus = null; ideaReturnContext = null; }
  }

  function castVote(idea, direction, source = 'main') {
    if (communityMutating || submitting || authenticating) return;
    const current = sourceIdeas(source).find(item => item.id === idea.id);
    if (!current || current.proposalRevision !== idea.proposalRevision || current.publicationRevision !== idea.publicationRevision
      || current.body !== idea.body || !votingIsOpen(current, sourceRound(source))
      || communityMe?.profile.id === current.author.id) {
      communityFeedback(m('voteChanged'), 'error'); return;
    }
    if (!user) {
      clearPending();
      openLogin(false, { forCommunity: true });
      return;
    }
    if (communityAttempt?.unknown) { communityFeedback(m('communityRetryFirst'), 'error'); return; }
    if (!communityMe || !sessionReady) { communityFeedback(m('communityPrivateUnavailable'), 'error'); return; }
    const existing = voteFor(idea);
    const nextDirection = existing?.direction === direction ? 'none' : direction;
    if (!communityMe.voteQuota || communityMe.voteQuota.roundId !== idea.roundId
      || (!existing && communityMe.voteQuota.remaining <= 0)) {
      communityFeedback({ api: 'VOTE_QUOTA_EXCEEDED', fallback: 'communityPrivateUnavailable' }, 'error'); return;
    }
    performCommunityAction({ action: 'vote', publicId: idea.id, proposalRevision: idea.proposalRevision,
      publicationRevision: idea.publicationRevision, roundId: idea.roundId, direction: nextDirection },
    nextDirection === 'none' ? 'voteRemoved' : 'voteRecorded');
  }

  async function performCommunityAction(action, successKey, { retry = false } = {}) {
    if (communityMutating || submitting || authenticating || !user || !sessionReady) return;
    if (!retry && communityAttempt?.unknown) { communityFeedback(m('communityRetryFirst'), 'error'); return; }
    const attempt = retry ? communityAttempt : { payload: { ...action, requestId: crypto.randomUUID() },
      successKey, actorId: user.id, publicProfileId: communityMe?.profile.id || null, unknown: false };
    if (!attempt || attempt.actorId !== user.id) return;
    const changingAlias = attempt.payload.action === 'set_profile_alias';
    const epoch = authEpoch;
    const sequence = ++communityMutationSequence;
    communityAttempt = attempt;
    communityMutating = true;
    // Reads started before a write cannot overwrite its result afterward.
    communitySequence += 1;
    communityLoading = false;
    communityMeSequence += 1;
    communityMeLoading = false;
    ideasSequence += 1;
    ideasLoading = false;
    ideasRefreshQueued = false;
    updateCommunityControls();
    renderProposals();
    try {
      const result = await request('/api/community', { method: 'POST', body: attempt.payload });
      if (epoch !== authEpoch || sequence !== communityMutationSequence || user?.id !== attempt.actorId) return;
      if (result?.ok !== true) throw new RequestError(m('communityResultInvalid'));
      communityAttempt = null;
      if (changingAlias) {
        reflectAlias(attempt.publicProfileId, attempt.payload.alias);
        closeAlias();
      } else {
        communityData = null;
        if (activeIdea?.source !== 'all') closeIdea();
      }
      communityFeedback(m(attempt.successKey));
      await Promise.allSettled([loadCommunity(), loadCommunityMe({ force: true })]);
    } catch (error) {
      if (epoch !== authEpoch || sequence !== communityMutationSequence || user?.id !== attempt.actorId) return;
      if (error.status === 0 || error.status >= 500 || (error.status >= 200 && error.status < 300)) {
        attempt.unknown = true;
        attempt.message = m('communityUnknown');
        communityFeedback(m('communityUnknown'), 'error');
      } else if (retry && error.data?.error?.code === 'COMMUNITY_RATE_LIMITED') {
        // The rate check happens before receipt lookup. It says nothing about
        // whether the earlier request committed, so preserve that request.
        attempt.unknown = true;
        attempt.message = m('communityRetryThrottled');
        communityFeedback(attempt.message, 'error');
      } else if (retry && error.data?.error?.code === 'CSRF_REJECTED') {
        // This retry was rejected before the server could look up the original
        // receipt. Keep its identity while obtaining the current CSRF token.
        attempt.unknown = true;
        attempt.message = m('communityUnknown');
        communityFeedback(m('communityUnknown'), 'error');
        await refreshSession().catch(() => { sessionReady = false; });
      } else {
        communityAttempt = null;
        communityFeedback(errorMessage(error), 'error');
        if (error.status === 401) {
          clearPending();
          applySession({ user: null, csrfToken, googleNonce });
          sessionReady = false;
          await refreshSession().catch(() => {});
        } else if (error.data?.error?.code === 'CSRF_REJECTED') {
          await refreshSession().catch(() => { sessionReady = false; });
        }
        await Promise.allSettled([loadCommunity(), loadCommunityMe({ force: true })]);
      }
      if (changingAlias && aliasEditor?.actorId === attempt.actorId) {
        aliasEditor.message = communityFeedbackMessage;
        aliasEditor.kind = 'error';
      }
    } finally {
      if (sequence === communityMutationSequence) {
        communityMutating = false;
        renderProposals();
        renderCommunity();
        renderControls();
      }
    }
  }

  for (const toggle of document.querySelectorAll('[data-ideas-history-toggle]')) {
    toggle.addEventListener('change', () => {
      if (communityMutating || submitting || authenticating || includeClosedIdeas === toggle.checked) {
        updateCommunityControls();
        return;
      }
      includeClosedIdeas = toggle.checked;
      communityPage = 0;
      // Never leave rows from the previous scope visible while its replacement
      // loads. Keep the unrelated ranking, draft and session state intact.
      if (communityData) communityData = { ...communityData, recent: [], popular: [] };
      if (activeIdea) closeIdea();
      ideasOffset = 0;
      clearIdeasView();
      ui['ideas-panel'].scrollTop = 0;
      loadCommunity().catch(() => {});
    });
  }
  for (const tab of document.querySelectorAll('[data-feed-sort]')) {
    tab.addEventListener('click', () => { communitySort = tab.dataset.feedSort; communityPage = 0; renderCommunity(); });
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      communitySort = event.key === 'Home' ? 'recent' : event.key === 'End' ? 'popular' : communitySort === 'recent' ? 'popular' : 'recent';
      communityPage = 0;
      renderCommunity();
      byId(communitySort === 'recent' ? 'feed-recent-tab' : 'feed-popular-tab').focus();
    });
  }
  ui['community-refresh'].addEventListener('click', () => {
    loadCommunity().catch(() => {});
    loadCommunityMe({ force: true }).catch(() => {});
  });
  ui['community-retry'].addEventListener('click', () => performCommunityAction(null, null, { retry: true }));
  ui['community-prev'].addEventListener('click', () => {
    communityPage = Math.max(0, communityPage - 1);
    renderCommunity();
  });
  ui['community-next'].addEventListener('click', () => {
    communityPage += 1;
    renderCommunity();
  });
  ui['open-ideas'].addEventListener('click', openIdeas);
  ui['close-ideas'].addEventListener('click', () => closeIdeas());
  const refreshIdeas = () => {
    if (ideasLoading || communityMutating || submitting || authenticating) return;
    loadCommunity().catch(() => {});
    loadCommunityMe({ force: true }).catch(() => {});
  };
  ui['ideas-refresh'].addEventListener('click', refreshIdeas);
  ui['ideas-retry'].addEventListener('click', refreshIdeas);
  ui['ideas-action-retry'].addEventListener('click', () => performCommunityAction(null, null, { retry: true }));
  for (const tab of document.querySelectorAll('[data-ideas-sort]')) {
    const changeSort = sort => {
      if (communityMutating || submitting || authenticating || ideasSort === sort) return;
      ideasSort = sort;
      ideasRefreshQueued = false;
      ui['ideas-panel'].scrollTop = 0;
      loadIdeasPage(0).catch(() => {});
    };
    tab.addEventListener('click', () => changeSort(tab.dataset.ideasSort));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const sort = event.key === 'Home' ? 'recent' : event.key === 'End' ? 'popular'
        : ideasSort === 'recent' ? 'popular' : 'recent';
      changeSort(sort);
      byId(ideasSort === 'recent' ? 'ideas-recent-tab' : 'ideas-popular-tab').focus();
    });
  }
  ui['ideas-prev'].addEventListener('click', () => {
    if (ideasLoading || communityMutating || !fullIdeas || ideasOffset === 0) return;
    ui['ideas-panel'].scrollTop = 0;
    loadIdeasPage(ideasOffset - IDEAS_PAGE_SIZE).catch(() => {});
    ui['ideas-panel'].focus();
  });
  ui['ideas-next'].addEventListener('click', () => {
    if (ideasLoading || communityMutating || !fullIdeas?.hasMore) return;
    ui['ideas-panel'].scrollTop = 0;
    loadIdeasPage(ideasOffset + IDEAS_PAGE_SIZE).catch(() => {});
    ui['ideas-panel'].focus();
  });
  ui['ideas-dialog'].addEventListener('cancel', event => { event.preventDefault(); closeIdeas(); });
  ui['ideas-dialog'].addEventListener('close', () => {
    if (ui['ideas-dialog'].open) return;
    clearIdeasView();
    const target = ideasReturnFocus;
    ideasReturnFocus = null;
    if (target?.isConnected && !target.disabled && target.getClientRects().length && !ui['login-dialog'].open) target.focus();
  });
  ui['my-rank-login'].addEventListener('click', () => { openLogin(false); });
  ui['my-rank-retry'].addEventListener('click', () => { loadCommunityMe({ force: true }).catch(() => {}); });
  ui['open-leaderboard'].addEventListener('click', openLeaderboard);
  ui['close-leaderboard'].addEventListener('click', () => closeLeaderboard());
  ui['leaderboard-full-retry'].addEventListener('click', () => { loadLeaderboardPage().catch(() => {}); });
  ui['leaderboard-full-prev'].addEventListener('click', () => {
    if (!leaderboardLoading && fullLeaderboard && leaderboardOffset > 0) {
      loadLeaderboardPage(leaderboardOffset - LEADERBOARD_PAGE_SIZE).catch(() => {});
    }
  });
  ui['leaderboard-full-next'].addEventListener('click', () => {
    if (!leaderboardLoading && fullLeaderboard?.hasMore) {
      loadLeaderboardPage(leaderboardOffset + LEADERBOARD_PAGE_SIZE).catch(() => {});
    }
  });
  ui['leaderboard-dialog'].addEventListener('cancel', event => { event.preventDefault(); closeLeaderboard(); });
  ui['leaderboard-dialog'].addEventListener('close', () => {
    if (ui['leaderboard-dialog'].open) return;
    clearLeaderboardView();
    const target = leaderboardReturnFocus;
    leaderboardReturnFocus = null;
    if (target?.isConnected && !target.disabled && target.getClientRects().length) target.focus();
  });
  ui['edit-alias'].addEventListener('click', openAlias);
  ui['close-alias'].addEventListener('click', () => closeAlias());
  ui['alias-cancel'].addEventListener('click', () => closeAlias());
  ui['alias-retry'].addEventListener('click', () => performCommunityAction(null, null, { retry: true }));
  ui['alias-reload'].addEventListener('click', () => { reloadAliasProfile().catch(() => {}); });
  ui['alias-dialog'].addEventListener('cancel', event => { event.preventDefault(); closeAlias(); });
  ui['alias-dialog'].addEventListener('close', () => {
    if (ui['alias-dialog'].open) return;
    clearAliasEditor();
    const target = aliasReturnFocus;
    aliasReturnFocus = null;
    if (target?.isConnected && !target.disabled && target.getClientRects().length) target.focus();
  });
  ui['alias-input'].addEventListener('compositionstart', () => {
    if (aliasEditor) { aliasEditor.composing = true; renderAlias(); }
  });
  ui['alias-input'].addEventListener('compositionend', () => {
    if (aliasEditor) { aliasEditor.composing = false; aliasEditor.validationShown = true; renderAlias(); }
  });
  ui['alias-input'].addEventListener('input', () => {
    if (aliasEditor) {
      aliasEditor.message = '';
      aliasEditor.kind = '';
      aliasEditor.validationShown = !aliasEditor.composing;
      renderAlias();
    }
  });
  ui['alias-form'].addEventListener('submit', event => {
    event.preventDefault();
    if (!aliasEditor || aliasEditor.composing || aliasEditor.reloading || !user || !sessionReady
      || !communityMe || aliasEditor.actorId !== user.id || aliasEditor.profileId !== communityMe.profile.id) return;
    aliasEditor.validationShown = true;
    const alias = normalizeProfileAlias(ui['alias-input'].value);
    if (!alias || aliasEditor.revision !== communityMe.profile.revision || alias === communityMe.profile.alias) {
      renderAlias();
      return;
    }
    aliasEditor.message = '';
    performCommunityAction({ action: 'set_profile_alias', alias, revision: aliasEditor.revision }, 'aliasSaved');
  });
  for (const [dialog, close] of [[ui['leaderboard-dialog'], closeLeaderboard], [ui['alias-dialog'], closeAlias],
    [ui['ideas-dialog'], closeIdeas], [ui['idea-dialog'], closeIdea]]) {
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
  }
  ui['open-my-proposals'].addEventListener('click', openMyProposals);
  ui['close-my-proposals'].addEventListener('click', () => closeMyProposals());
  ui['my-proposals-dialog'].addEventListener('close', () => {
    if (ui['my-proposals-dialog'].open) return;
    const target = proposalsReturnFocus;
    proposalsReturnFocus = null;
    if (target?.isConnected && !target.hidden && !target.disabled) target.focus();
  });
  ui['close-idea'].addEventListener('click', closeIdea);
  ui['idea-dialog'].addEventListener('cancel', event => {
    event.preventDefault();
    closeIdea();
  });
  ui['idea-dialog'].addEventListener('close', () => {
    if (ui['idea-dialog'].open) return;
    activeIdea = null;
    ui['idea-body'].textContent = '';
    ui['idea-author'].textContent = '';
    const target = ideaReturnFocus;
    const context = ideaReturnContext;
    ideaReturnFocus = null;
    ideaReturnContext = null;
    if (ui['login-dialog'].open || ui['alias-dialog'].open || ui['leaderboard-dialog'].open) return;
    if (target?.isConnected && !target.hidden && !target.disabled && target.getClientRects().length) target.focus();
    else if (context?.source === 'all') {
      if (!ui['ideas-dialog'].open) return;
      const row = [...ui['ideas-list'].children].find(element => element.dataset.publicId === context.id);
      (row?.querySelector('.community-read') || byId(ideasSort === 'recent' ? 'ideas-recent-tab' : 'ideas-popular-tab')).focus();
    } else if (target) byId(communitySort === 'recent' ? 'feed-recent-tab' : 'feed-popular-tab').focus();
  });
  try {
    const context = ui['game-preview-canvas'].getContext('2d');
    if (context) {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, ui['game-preview-canvas'].width, ui['game-preview-canvas'].height);
    }
  } catch { /* The CSS white canvas remains visible even if 2D rendering is unavailable. */ }

  function renderLoginChrome() {
    const forAdmin = loginPurpose === 'admin';
    const forCommunity = loginPurpose === 'community';
    ui['login-title'].textContent = t(forAdmin ? 'adminLoginTitle' : forCommunity ? 'communityLoginTitle' : 'loginTitle');
    ui['login-description'].textContent = t(forAdmin ? 'adminLoginDescription' : forCommunity ? 'communityLoginDescription' : 'loginDescription');
    ui['login-draft-note'].textContent = loginPurpose === 'submission' && operatingState().proposalsPaused
      ? localize(pausedSubmissionMessage())
      : t(forAdmin ? 'adminLoginNote' : forCommunity ? 'communityLoginNote' : loginPurpose === 'submission' ? 'submissionLoginNote' : 'headerLoginNote');
  }

  function renderLocale() {
    // Language changes only redraw copy: no save, login, quota fetch or pending send.
    renderControls();
    renderTime({ passive: true });
    renderProposals();
    renderLoginChrome();
    ui['form-message'].textContent = localize(feedbackMessage);
    ui['connection-message'].textContent = localize(connectionMessage);
    ui['login-message'].textContent = localize(currentLoginMessage);
    document.querySelector('meta[property="og:locale"]')?.setAttribute('content', i18n.locale === 'ko' ? 'ko_KR' : 'en_US');
    renderGoogleButton();
    renderCommunity();
    refreshIdeaDialog();
  }

  i18n.bindLanguageControls();
  i18n.apply();
  i18n.subscribe(renderLocale);
  renderLocale();
  i18n.init().then(() => {
    renderLocale();
    setInterval(renderTime, 1000);
    synchronize({ resumePending: true });
    loadCommunity().catch(() => {});
  });
})();
