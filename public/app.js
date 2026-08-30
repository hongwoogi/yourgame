import { i18n } from './i18n.js';
import './public-messages.js';

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
  const requestedAdmin = entryParameters.get('admin') === '1';
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
    'proposal-count', 'edit-banner', 'cancel-edit', 'reload-edit', 'copy-edit',
    'connection-notice', 'connection-message', 'retry-connection', 'collection-dot',
    'collection-label', 'collection-deadline', 'countdown-title', 'countdown', 'release-message',
    'release-note', 'count-days', 'count-hours', 'count-minutes', 'count-seconds',
  ].map((id) => [id, byId(id)]));

  let status = null;
  let user = null;
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
  let newDraft = readStorage('localStorage', DRAFT_KEY) || '';
  if (newDraft.length > 100000) newDraft = '';
  ui.prompt.value = newDraft;

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
  }

  function renderTime({ passive = false } = {}) {
    const now = serverNow();
    const target = Date.parse(status?.firstReleaseAt || FIRST_RELEASE);
    const remaining = Math.max(0, Math.ceil((target - now) / 1000));
    const published = status?.game?.published === true;
    const operations = operatingState();
    const releasePaused = operations.mode !== 'active' || (!published && operations.developmentPaused);
    ui.countdown.hidden = remaining === 0 || published || releasePaused;
    ui['release-message'].hidden = remaining > 0 && !published && !releasePaused;
    if (releasePaused) {
      ui['countdown-title'].textContent = operations.mode === 'ended' ? t('endedTitle')
        : operations.mode === 'maintenance' ? t('maintenanceTitle') : t('developmentTitle');
      ui['release-message'].textContent = operations.mode === 'ended' ? t('endedMessage')
        : operations.mode === 'maintenance' ? t('maintenanceMessage') : t('developmentMessage');
    } else if (published) {
      ui['countdown-title'].textContent = t('firstGame');
      ui['release-message'].textContent = t('gamePublished');
    } else if (remaining === 0) {
      ui['countdown-title'].textContent = t('gamePreparingTitle');
      ui['release-message'].textContent = t('gamePreparing');
    } else {
      ui['countdown-title'].textContent = t('countdownDefault');
      const values = [Math.floor(remaining / 86400), Math.floor(remaining / 3600) % 24, Math.floor(remaining / 60) % 60, remaining % 60];
      ['count-days', 'count-hours', 'count-minutes', 'count-seconds'].forEach((key, index) => {
        ui[key].textContent = String(values[index]).padStart(2, '0');
      });
      ui.countdown.setAttribute('aria-label', t('countdownTime', { days: values[0], hours: values[1], minutes: values[2], seconds: values[3] }));
    }
    ui['release-note'].textContent = !statusReady ? (releasePaused ? t('operationChecking') : t('deviceTime'))
      : releasePaused ? t('pausedReleaseNote')
      : published ? t('publishedNote')
        : remaining === 0 ? t('delayedNote')
          : t('releaseNote');
    const initialClosed = status?.collection?.initialClosed === true || now >= Date.parse(FIRST_CLOSE);
    const open = proposalsOpen();
    ui['collection-dot'].classList.toggle('is-open', open);
    ui['collection-label'].textContent = !statusReady ? t('collectionChecking')
      : operations.proposalsPaused ? (operations.mode === 'ended' ? t('collectionEnded') : operations.mode === 'maintenance' ? t('collectionMaintenance') : t('collectionPaused'))
      : open ? (initialClosed ? t('collectionNext') : t('collectionOpen')) : t('collectionPreparing');
    ui['collection-deadline'].textContent = operations.proposalsPaused ? t('deadlinePaused') : initialClosed
      ? t('deadlineNext')
      : t('initialDeadline');
    const boundary = `${initialClosed}-${remaining === 0}`;
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
      ui['my-proposals'].open = false;
    } else user = nextUser;
    csrfToken = data.csrfToken || csrfToken;
    googleNonce = data.googleNonce || googleNonce;
    sessionReady = Boolean(csrfToken && googleNonce);
    renderControls();
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
    ui['my-proposals'].open = false;
    renderControls();
  }

  async function refreshStatus() {
    const sequence = ++statusReadSequence;
    try {
      const data = await request('/api/status');
      if (sequence !== statusReadSequence) return status;
      if (!data.collection || !data.firstReleaseAt || !data.serverTime) throw new RequestError(m('collectionUnavailable'));
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

  function safetyView(proposal) {
    const states = {
      pending: [t('safetyPendingLabel'), t('safetyPendingMessage')],
      approved: [t('safetyApprovedLabel'), t('safetyApprovedMessage')],
      held: [t('safetyHeldLabel'), t('safetyHeldMessage')],
      blocked: [t('safetyBlockedLabel'), t('safetyBlockedMessage')],
    };
    const status = proposal?.safety?.status;
    const item = Object.hasOwn(states, status) ? states[status] : [t('safetyUnknownLabel'), t('safetyUnknownMessage')];
    return { status: Object.hasOwn(states, status) ? status : 'unknown', label: item[0], message: item[1] };
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
      const safety = safetyView(proposal);
      const safetyNote = document.createElement('div');
      safetyNote.className = 'proposal-safety';
      safetyNote.dataset.status = safety.status;
      const safetyLabel = document.createElement('strong');
      safetyLabel.textContent = safety.label;
      const safetyMessage = document.createElement('span');
      safetyMessage.textContent = safety.message;
      if (proposal.editable && ['held', 'blocked'].includes(safety.status)) {
        safetyMessage.textContent += t('editReReview');
      }
      safetyNote.append(safetyLabel, safetyMessage);
      meta.append(time, actions);
      article.append(meta, body, safetyNote);
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
          if (!identityRetry) throw new RequestError(m('otherTabAccount'));
          authEpoch += 1;
          sessionReady = false;
          renderControls();
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
        feedback(m('editSaved', { status: () => safetyView(data.proposal).label }));
      } else {
        newDraft = '';
        ui.prompt.value = '';
        writeStorage('localStorage', DRAFT_KEY, null);
        attempt = null;
        writeStorage('sessionStorage', ATTEMPT_KEY, null);
        feedback(m('submitted', { status: () => safetyView(data.proposal).label }));
      }
      ui['my-proposals'].open = true;
      renderProposals();
    } catch (error) {
      if (epoch !== authEpoch) return;
      if (error.data?.quota) {
        try { acceptQuota(error.data.quota); } catch { quota = null; }
      }
      const safetyRejected = error.data?.error?.code === 'PROPOSAL_SAFETY_REJECTED';
      const editRateLimited = error.data?.error?.code === 'EDIT_RATE_LIMITED';
      const attemptRateLimited = error.data?.error?.code === 'PROPOSAL_ATTEMPT_RATE_LIMITED';
      const retryWait = error.retryAfterSeconds ? m('retrySeconds', { seconds: error.retryAfterSeconds }) : m('retrySoon');
      feedback(safetyRejected
        ? m('safetyRejected', { result: m(editingAtSend ? 'rejectedEditPrefix' : 'rejectedNewPrefix') })
        : editRateLimited ? m('editRateLimited', { wait: retryWait })
          : attemptRateLimited ? m('attemptRateLimited', { wait: retryWait })
          : error.status === 0 && !editingAtSend
        ? m('sendUnknown')
        : errorMessage(error), 'error', { reason: safetyRejected ? 'safety' : error.status === 429 && !editRateLimited && !attemptRateLimited ? 'quota' : '' });
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
    window.location.assign('/admin');
  }

  async function handleAdminEntry() {
    if (!adminEntryPending || !sessionReady) return false;
    adminEntryPending = false;
    clearPending();
    saveCurrentDraft();
    // Consuming these flags prevents Back/reload from reopening the same login modal.
    const nextUrl = new URL(window.location.href);
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
        closeLogin(true);
        try {
          await refreshStatus();
          await loadPrivate();
          await resumeExplicitSend();
        } catch (error) {
          clearPending();
          feedback(m('autoSendUnprepared'), 'error');
          connectionError(errorMessage(error));
        }
        return;
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

  async function openLogin(forSubmission = false, { forAdmin = false } = {}) {
    if (authenticating || submitting) return;
    if (!forSubmission || forAdmin) clearPending();
    saveCurrentDraft();
    loginPurpose = forAdmin ? 'admin' : forSubmission ? 'submission' : 'login';
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
    let freshLoginCompleted = false;
    authenticating = true;
    ui['close-login'].disabled = true;
    ui['google-button-area'].inert = true;
    loginMessage(forAdmin ? m('checkingAdmin') : m('checkingLoginQuota'));
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
      feedback(operatingState().proposalsPaused ? m('loggedInPaused', { notice: pausedSubmissionMessage() }) : m('loggedIn'),
        operatingState().proposalsPaused ? 'error' : 'success', { reason: operatingState().proposalsPaused ? 'service' : '' });
      writeStorage('localStorage', AUTH_PULSE_KEY, String(Date.now()));
      await resumeExplicitSend();
    } catch (error) {
      if (!forAdmin && freshLoginCompleted && user) {
        clearPending();
        authenticating = false;
        closeLogin();
        feedback(m('loginPreparationFailed'), 'error');
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
    try { await refreshStatus(); } catch { /* prepareGoogle explains unavailable configuration. */ }
    await prepareGoogle();
  });
  ui['retry-connection'].addEventListener('click', () => { synchronize(); });
  ui['login-dialog'].addEventListener('cancel', (event) => {
    if (authenticating) event.preventDefault();
    else { clearPending(); googleGeneration += 1; }
  });
  ui['login-dialog'].addEventListener('close', () => {
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

  function renderLoginChrome() {
    const forAdmin = loginPurpose === 'admin';
    ui['login-title'].textContent = t(forAdmin ? 'adminLoginTitle' : 'loginTitle');
    ui['login-description'].textContent = t(forAdmin ? 'adminLoginDescription' : 'loginDescription');
    ui['login-draft-note'].textContent = loginPurpose === 'submission' && operatingState().proposalsPaused
      ? localize(pausedSubmissionMessage())
      : t(forAdmin ? 'adminLoginNote' : loginPurpose === 'submission' ? 'submissionLoginNote' : 'headerLoginNote');
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
  }

  i18n.bindLanguageControls();
  i18n.apply();
  i18n.subscribe(renderLocale);
  renderLocale();
  i18n.init().then(() => {
    renderLocale();
    setInterval(renderTime, 1000);
    synchronize({ resumePending: true });
  });
})();
