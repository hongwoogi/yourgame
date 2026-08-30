(() => {
  'use strict';

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
        feedback('이 브라우저에서 임시 저장을 사용할 수 없어요. 창을 닫기 전에 작성한 내용을 복사해 주세요.', 'error');
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
    constructor(message, responseStatus = 0, data = null) {
      super(message);
      this.status = responseStatus;
      this.data = data;
    }
  }

  async function request(path, { method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    const started = performance.now();
    try {
      const headers = { Accept: 'application/json' };
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
      catch { throw new RequestError('서버 응답을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.', response.status); }
      if (!response.ok) {
        const message = response.status < 500 && typeof data?.error?.message === 'string'
          ? data.error.message.slice(0, 500) : '서버 연결에 실패했어요. 작성한 내용은 그대로 두고 잠시 후 다시 시도해 주세요.';
        throw new RequestError(message, response.status, data);
      }
      if (data.serverTime) synchronizeClock(data.serverTime, performance.now() - started);
      return data;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw new RequestError(error.name === 'AbortError'
        ? '응답이 늦어 서버 연결을 확인하지 못했어요. 작성한 내용은 보관됩니다. 잠시 후 다시 시도해 주세요.'
        : '인터넷 또는 서버 연결을 확인해 주세요. 작성한 내용은 그대로 보관됩니다.');
    } finally { clearTimeout(timeout); }
  }

  function feedback(message, kind = 'success', { reload = false, copy = false, reason = '' } = {}) {
    ui['form-feedback'].hidden = !message;
    ui['form-feedback'].dataset.kind = kind;
    ui['form-feedback'].dataset.reason = reason;
    ui['form-message'].textContent = message;
    ui['reload-edit'].hidden = !reload;
    ui['copy-edit'].hidden = !copy;
  }

  function connectionError(message) {
    ui['connection-message'].textContent = message;
    ui['connection-notice'].hidden = false;
  }

  function loginMessage(message, isError = false) {
    ui['login-message'].textContent = message;
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
    const reason = mode === 'ended' ? '서비스가 종료되어'
      : mode === 'maintenance' ? '서비스 점검 중이라' : '제안 접수가 일시정지되어';
    return `${reason} 새 제안과 수정 내용을 접수하지 않아요. 작성한 내용은 보관되며 자동 전송하지 않습니다.`;
  }

  function cancelPausedSend() {
    const wasPending = Boolean(pending);
    clearPending();
    if (ui['login-dialog'].open && loginPurpose === 'submission') {
      ui['login-draft-note'].textContent = pausedSubmissionMessage();
    }
    if (wasPending) feedback(pausedSubmissionMessage(), 'error', { reason: 'service' });
  }

  function renderService() {
    const state = operatingState();
    const notice = ui['service-notice'];
    notice.hidden = !state.proposalsPaused && !state.developmentPaused && !state.message;
    notice.dataset.mode = state.mode;
    notice.dataset.paused = String(state.proposalsPaused);
    const title = state.mode === 'ended' ? '서비스가 종료되었습니다'
      : state.mode === 'maintenance' ? '서비스 점검 중입니다'
        : state.proposalsPaused ? '제안 접수를 일시정지했습니다'
          : state.developmentPaused ? '자동 개발을 일시정지했습니다' : '운영 공지';
    const detail = state.proposalsPaused
      ? '새 제안과 수정은 접수하지 않습니다. 작성한 초안과 기존 접수 내역은 보존되며, 로그인과 내 제안 조회는 계속 이용할 수 있어요.'
      : state.developmentPaused ? '새 게임 개발·공개는 대기 중입니다. 제안 접수는 계속 이용할 수 있어요.' : '';
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
    if (!Number.isFinite(date.getTime())) return '시각 확인 중';
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit',
      ...(includeSeconds ? { second: '2-digit' } : {}), hourCycle: 'h23',
    }).format(date);
  }

  function proposalDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit',
      minute: '2-digit', hourCycle: 'h23',
    }).format(date) + ' KST';
  }

  function renderBytes() {
    const count = encoder.encode(ui.prompt.value).length;
    const max = limits().bytes;
    ui['byte-count'].replaceChildren(document.createTextNode(count.toLocaleString('en-US') + ' '));
    const suffix = document.createElement('span');
    suffix.textContent = '/ ' + max.toLocaleString('en-US') + ' bytes';
    ui['byte-count'].append(suffix);
    ui['byte-count'].classList.toggle('is-over', count > max);
    ui.prompt.setAttribute('aria-invalid', count > max ? 'true' : 'false');
    ui['prompt-hint'].textContent = count > max
      ? `${(count - max).toLocaleString('ko-KR')}바이트를 줄여주세요. 한글과 이모지는 한 글자에 여러 바이트를 사용해요.`
      : '작은 아이디어도 좋아요. 구체적일수록 도움이 됩니다.';
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
      ui['quota-status'].textContent = '로그인 후 제안할 수 있어요';
      ui['quota-note'].textContent = '최근 60분 동안 최대 3개';
    } else if (!quota) {
      ui['quota-status'].textContent = '남은 횟수 확인 중';
      ui['quota-note'].textContent = '제출 기록을 확인하고 있어요';
    } else {
      ui['quota-status'].textContent = `남은 제안 ${quota.remaining} / ${quota.limit}`;
      ui['quota-note'].textContent = quota.remaining === 0 && quota.nextAvailableAt
        ? `다음 제출 가능 ${shortTime(quota.nextAvailableAt, true)} KST`
        : '제출한 지 60분이 지나면 횟수가 돌아와요';
    }
    const editingLocked = editing && (!editing.editable || editing.conflict);
    const noQuota = loggedIn && (!quota || quota.remaining <= 0);
    ui['submit-button'].disabled = submitting || authenticating || composing || !sessionReady || !statusReady
      || (loggedIn && !privateReady)
      || count > limits().bytes || Boolean(editingLocked) || (!editing && noQuota)
      || !proposalsOpen();
    ui['submit-label'].textContent = submitting ? (editing ? '저장 중…' : '접수 중…')
      : operations.proposalsPaused ? (operations.mode === 'ended' ? '접수 종료' : '접수 일시정지')
      : editing ? (editingLocked ? '수정 상태 확인' : '수정 저장')
        : loggedIn && quota?.remaining === 0 ? '횟수 충전 대기' : '제안 보내기';
    ui['submit-spinner'].hidden = !submitting;
    ui['submit-icon'].hidden = submitting;
    ui['prompt-form'].setAttribute('aria-busy', submitting ? 'true' : 'false');
    ui['my-proposals'].hidden = !loggedIn || !privateReady;
  }

  function renderTime() {
    const now = serverNow();
    const target = Date.parse(status?.firstReleaseAt || FIRST_RELEASE);
    const remaining = Math.max(0, Math.ceil((target - now) / 1000));
    const published = status?.game?.published === true;
    const operations = operatingState();
    const releasePaused = operations.mode !== 'active' || (!published && operations.developmentPaused);
    ui.countdown.hidden = remaining === 0 || published || releasePaused;
    ui['release-message'].hidden = remaining > 0 && !published && !releasePaused;
    if (releasePaused) {
      ui['countdown-title'].textContent = operations.mode === 'ended' ? '서비스 종료'
        : operations.mode === 'maintenance' ? '서비스 점검 중' : '자동 개발 일시정지';
      ui['release-message'].textContent = operations.mode === 'ended' ? '서비스 운영이 종료되었습니다.'
        : operations.mode === 'maintenance' ? '운영 점검을 진행하고 있어요.' : '다음 개발을 기다리고 있어요.';
    } else if (published) {
      ui['countdown-title'].textContent = '첫 번째 게임';
      ui['release-message'].textContent = '첫 게임이 공개되었습니다.';
    } else if (remaining === 0) {
      ui['countdown-title'].textContent = '첫 번째 게임 공개 준비 중';
      ui['release-message'].textContent = '첫 게임을 준비하고 있어요.';
    } else {
      ui['countdown-title'].textContent = '첫 번째 게임 공개까지';
      const values = [Math.floor(remaining / 86400), Math.floor(remaining / 3600) % 24, Math.floor(remaining / 60) % 60, remaining % 60];
      ['count-days', 'count-hours', 'count-minutes', 'count-seconds'].forEach((key, index) => {
        ui[key].textContent = String(values[index]).padStart(2, '0');
      });
      ui.countdown.setAttribute('aria-label', `공개 목표까지 ${values[0]}일 ${values[1]}시간 ${values[2]}분 ${values[3]}초`);
    }
    ui['release-note'].textContent = !statusReady ? (releasePaused ? '운영 상태를 다시 확인하고 있습니다.' : '서버 연결을 확인 중입니다. 기기 시간으로 표시합니다.')
      : releasePaused ? '운영 재개와 새 공개가 확인되기 전에는 공개 완료로 표시하지 않습니다.'
      : published ? '공개 상태는 서버에서 확인한 정보입니다.'
        : remaining === 0 ? '공개 목표 시각이 지났습니다. 준비 상태를 확인하고 있어요.'
          : '한국시간 기준 · 제작과 검증을 마친 뒤 공개합니다.';
    const initialClosed = status?.collection?.initialClosed === true || now >= Date.parse(FIRST_CLOSE);
    const open = proposalsOpen();
    ui['collection-dot'].classList.toggle('is-open', open);
    ui['collection-label'].textContent = !statusReady ? '제안 모집 상태 확인 중'
      : operations.proposalsPaused ? (operations.mode === 'ended' ? '제안 접수가 종료되었습니다' : operations.mode === 'maintenance' ? '점검 중 · 제안 접수 일시정지' : '제안 접수 일시정지')
      : open ? (initialClosed ? '다음 회차 제안을 모집하고 있어요' : '지금, 첫 제안을 모집하고 있어요') : '제안 모집을 준비하고 있어요';
    ui['collection-deadline'].textContent = operations.proposalsPaused ? '새 제안·수정 접수 중단 · 작성한 내용과 기존 접수 내역은 보존됩니다' : initialClosed
      ? '첫 회차 모집 마감 · 지금 보낸 제안은 다음 회차에 접수됩니다'
      : '첫 제안 마감 · 08.31 23:00 KST';
    const boundary = `${initialClosed}-${remaining === 0}`;
    if (lastBoundary && lastBoundary !== boundary && statusReady) schedulePoll(0);
    lastBoundary = boundary;
    if (statusReady && sessionReady && user && !document.hidden && !submitting && !authenticating
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
      if (!data || !data.csrfToken || !data.googleNonce) throw new RequestError('로그인 연결 정보를 확인하지 못했어요. 다시 연결해 주세요.');
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
      if (!data.collection || !data.firstReleaseAt || !data.serverTime) throw new RequestError('모집 상태를 확인하지 못했어요. 다시 연결해 주세요.');
      if (data.service !== undefined && (!data.service || !['active', 'maintenance', 'ended'].includes(data.service.mode)
        || typeof data.service.proposalsEnabled !== 'boolean' || typeof data.service.developmentEnabled !== 'boolean'
        || typeof data.service.message !== 'string')) throw new RequestError('운영 상태를 확인하지 못했어요. 작성한 내용은 보관됩니다.');
      const wasPaused = operatingState().proposalsPaused;
      status = data;
      submissionBlock = null;
      statusReady = true;
      if (operatingState().proposalsPaused) cancelPausedSend();
      else if (wasPaused && ui['form-feedback'].dataset.reason === 'service') {
        feedback('제안 접수가 재개됐어요. 작성한 내용을 확인한 뒤 전송 버튼을 눌러주세요. 자동 전송하지 않습니다.');
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
      throw new RequestError('남은 제출 횟수를 확인하지 못했어요. 다시 연결해 주세요.');
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
      empty.textContent = '아직 보낸 제안이 없어요. 첫 아이디어를 남겨주세요.';
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
      state.textContent = proposal.editable ? (operatingState().proposalsPaused ? '저장 일시정지' : '수정 가능') : '수정 마감';
      actions.append(state);
      if (proposal.editable) {
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.className = 'text-button proposal-edit';
        editButton.textContent = '수정 ↗';
        editButton.disabled = submitting || authenticating;
        editButton.setAttribute('aria-label', `${proposalDate(proposal.createdAt)}에 보낸 제안 수정`);
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
          throw new RequestError('제출 기록의 계정을 확인하지 못했어요. 연결을 다시 확인해 주세요.');
        }
        if (data.ownerId !== expectedOwnerId || data.ownerId !== user.id) {
          // A shared cookie may change before another tab announces its login.
          // Never display this response, restore an edit, or carry its pending send into the new account.
          invalidatePrivate({ identityChanged: true });
          if (!identityRetry) throw new RequestError('다른 창에서 로그인 상태가 바뀌었어요. 연결을 다시 확인해 주세요.');
          authEpoch += 1;
          sessionReady = false;
          renderControls();
          try { await refreshSession(); }
          catch (error) {
            connectionError('로그인 계정을 다시 확인하지 못했어요. 입력한 내용은 보관되며 자동 전송하지 않습니다.');
            throw error;
          }
          if (!user || !sessionReady) throw new RequestError('로그인 상태가 바뀌었어요. 다시 로그인해 주세요.');
          return await loadPrivate({ restoreEdit: false, identityRetry: false });
        }
        if (!Array.isArray(data.proposals)) throw new RequestError('내 제안 목록을 확인하지 못했어요. 다시 연결해 주세요.');
        const hadNoQuota = quota?.remaining === 0;
        acceptQuota(data.quota);
        privateReady = true;
        proposals = data.proposals.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        if (editing) {
          const current = proposals.find((entry) => entry.id === editing.id);
          editing.editable = current?.editable === true;
          editing.conflict = Boolean(current && current.revision !== editing.revision);
          if (!editing.editable) feedback('이 제안은 모집이 마감되어 더 이상 수정할 수 없어요. 작성 중인 내용은 새 제안으로 가져올 수 있습니다.', 'error', { copy: true });
          else if (editing.conflict) feedback('다른 창에서 이 제안이 수정됐어요. 최신 내용을 확인한 뒤 다시 수정해 주세요. 작성 중인 내용은 그대로 남아 있어요.', 'error', { reload: true, copy: true });
        } else if (restoreEdit && editDrafts.activeId && !pending) {
          const previous = proposals.find((entry) => entry.id === editDrafts.activeId);
          if (previous) beginEdit(previous, { focus: false });
        }
        renderProposals();
        renderControls();
        if (hadNoQuota && quota.remaining > 0 && !editing && ui['form-feedback'].dataset.reason === 'quota') {
          feedback('제출 횟수가 돌아왔어요. 내용을 확인한 뒤 전송 버튼을 눌러주세요.');
        }
        return data;
      } catch (error) {
        if (authEpoch === epoch && mutationVersion === proposalMutationVersion) {
          invalidatePrivate();
          connectionError('제출 기록을 확인하지 못했어요. 입력한 내용은 그대로 두고 연결을 다시 확인해 주세요.');
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
      connectionError(error.message || '서버 연결을 확인하지 못했어요. 작성한 내용은 보관됩니다.');
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
        connectionError(error.message);
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
    feedback(!editing.editable ? '이 제안은 모집이 마감되어 수정할 수 없어요. 작성 중인 내용은 새 제안으로 가져올 수 있습니다.'
      : editing.conflict ? '다른 창에서 이 제안이 수정됐어요. 최신 내용을 확인한 뒤 다시 수정해 주세요.'
        : '수정 내용을 저장해도 새 제안 횟수는 차감되지 않아요.', editing.editable && !editing.conflict ? 'success' : 'error',
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
      feedback('어떤 게임을 만들고 싶은지 한 문장을 남겨주세요.', 'error');
      ui.prompt.focus();
      return false;
    }
    if (encoder.encode(body).length > limits().bytes) {
      feedback('제안은 UTF-8 기준 2,000바이트까지 보낼 수 있어요. 내용을 조금 줄여주세요.', 'error');
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
        : '지금은 제안을 접수할 수 없어요. 작성한 내용을 보관하고 모집 상태를 다시 확인해 주세요.', 'error',
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
      if (!data.proposal) throw new RequestError('접수 결과를 확인하지 못했어요. 작성한 내용은 그대로 남아 있습니다.');
      acceptQuota(data.quota);
      proposals = [data.proposal, ...proposals.filter((entry) => entry.id !== data.proposal.id)]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      if (editingAtSend) {
        endEdit({ removeDraft: true });
        feedback('수정 내용을 저장했어요. 새 제안 횟수는 차감되지 않았어요.');
      } else {
        newDraft = '';
        ui.prompt.value = '';
        writeStorage('localStorage', DRAFT_KEY, null);
        attempt = null;
        writeStorage('sessionStorage', ATTEMPT_KEY, null);
        feedback('제안이 접수됐어요. 모집 마감 전에는 아래에서 수정할 수 있어요.');
      }
      ui['my-proposals'].open = true;
      renderProposals();
    } catch (error) {
      if (epoch !== authEpoch) return;
      if (error.data?.quota) {
        try { acceptQuota(error.data.quota); } catch { quota = null; }
      }
      feedback(error.status === 0 && !editingAtSend
        ? '접수 결과를 확인하지 못했어요. 작성한 내용은 보관됩니다. 다시 전송해도 같은 요청이 중복 접수되지 않아요.'
        : error.message, 'error', { reason: error.status === 429 ? 'quota' : '' });
      if (isServiceRejection(error)) {
        applyServiceRejection(error);
        await refreshStatus().catch(() => {});
      } else if (error.status === 409 && editingAtSend) {
        editing.conflict = true;
        await loadPrivate().catch(() => {});
        feedback(error.message, 'error', { reload: editing?.editable === true, copy: Boolean(editing) });
      } else if (error.status === 401 || error.status === 403) {
        if (error.status === 401) {
          applySession({ user: null, csrfToken, googleNonce });
          feedback('로그인 상태를 다시 확인해 주세요. 작성한 내용은 보관됩니다. 로그인한 뒤 다시 전송해 주세요.', 'error');
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
        : '작성 내용과 접수 상태를 확인한 뒤 전송 버튼을 다시 눌러주세요. 자동 제출하지 않았어요.', 'error',
      { reason: operatingState().proposalsPaused ? 'service' : '' });
      return;
    }
    if (ui.prompt.value !== queued.body) {
      feedback('작성한 내용이 달라져 자동 제출하지 않았어요. 내용을 확인한 뒤 전송해 주세요.');
      return;
    }
    if (!privateReady || !quota) {
      feedback('남은 횟수를 확인하지 못해 자동 제출하지 않았어요. 작성한 내용을 확인한 뒤 다시 전송해 주세요.', 'error');
      return;
    }
    if (quota.remaining <= 0) {
      feedback(`남은 횟수가 없어 자동 제출하지 않았어요.${quota.nextAvailableAt ? ` ${shortTime(quota.nextAvailableAt, true)} KST부터` : ' 횟수가 돌아오면'} 다시 전송해 주세요. 작성한 내용은 그대로 남아 있어요.`, 'error', { reason: 'quota' });
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
        reject(new Error('Google 로그인에 연결하지 못했어요. 네트워크 또는 콘텐츠 차단 설정을 확인하고 다시 시도해 주세요.'));
      }, 15000);
      script.onload = () => {
        clearTimeout(timer);
        if (window.google?.accounts?.id) resolve();
        else { googleLoadPromise = null; reject(new Error('Google 로그인 화면을 준비하지 못했어요. 다시 시도해 주세요.')); }
      };
      script.onerror = () => {
        clearTimeout(timer);
        googleLoadPromise = null;
        script.remove();
        reject(new Error('Google 로그인에 연결하지 못했어요. 네트워크 또는 콘텐츠 차단 설정을 확인해 주세요.'));
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
    if (width <= 0 || (generation === googleButtonGeneration && width === googleButtonWidth)) return;
    googleButtonGeneration = generation;
    googleButtonWidth = width;
    ui['google-signin'].replaceChildren();
    window.google.accounts.id.renderButton(ui['google-signin'], {
      type: 'standard', theme: 'outline', size: 'large', text: 'continue_with',
      shape: 'rectangular', width, locale: 'ko', logo_alignment: 'left',
    });
  }

  async function prepareGoogle() {
    const generation = ++googleGeneration;
    googleButtonGeneration = -1;
    googleButtonWidth = 0;
    ui['retry-google'].hidden = true;
    ui['google-signin'].replaceChildren();
    loginMessage('Google 로그인 연결을 준비하고 있습니다.');
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
          feedback('접수 상태를 확인하지 못해 자동 제출하지 않았어요. 작성한 내용은 보관됩니다. 연결을 확인한 뒤 다시 전송해 주세요.', 'error');
          connectionError(error.message);
        }
        return;
      }
      if (!status?.googleClientId) throw new Error('Google 로그인 설정을 확인하지 못했어요. 입력한 내용은 보관됩니다. 잠시 후 다시 연결해 주세요.');
      await loadGoogle();
      if (generation !== googleGeneration || !ui['login-dialog'].open) return;
      window.google.accounts.id.initialize({
        client_id: status.googleClientId, nonce: googleNonce, auto_select: false,
        callback: (response) => handleGoogleCredential(response, generation),
        ux_mode: 'popup', context: 'signin',
      });
      renderGoogleButton(generation);
      loginMessage(loginPurpose === 'admin' ? '관리자 계정으로 Google 로그인을 완료해 주세요.' : 'Google 버튼을 눌러 로그인해 주세요.');
    } catch (error) {
      if (generation !== googleGeneration) return;
      loginMessage(error.message, true);
      ui['retry-google'].hidden = false;
    }
  }

  async function openLogin(forSubmission = false, { forAdmin = false } = {}) {
    if (authenticating || submitting) return;
    if (!forSubmission || forAdmin) clearPending();
    saveCurrentDraft();
    loginPurpose = forAdmin ? 'admin' : forSubmission ? 'submission' : 'login';
    loginReturnFocus = document.activeElement;
    ui['login-title'].textContent = forAdmin ? '관리자 로그인' : '당신의 아이디어를\n이어갈 차례.';
    ui['login-description'].textContent = forAdmin
      ? '관리자 계정을 다시 확인합니다.\nGoogle 로그인을 완료하면 관리자 화면으로 이동해요.'
      : 'Google 계정으로 로그인하고 제안을 남겨주세요.\n최근 60분 동안 최대 3개의 제안을 보낼 수 있어요.';
    ui['login-draft-note'].textContent = forAdmin
      ? '제안과 수정 초안은 이 브라우저에 보관합니다. 관리자 로그인으로 제안이 전송되지는 않아요.' : forSubmission
      ? '작성한 내용은 보관됩니다. 로그인 후 남은 횟수가 있으면 이 제안을 바로 접수해요.'
      : '작성한 내용은 이 브라우저에 보관됩니다. 로그인만으로 제안이 전송되지는 않아요.';
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
      loginMessage('로그인을 완료하지 못했어요. Google 버튼을 눌러 다시 시도해 주세요.', true);
      return;
    }
    const forAdmin = loginPurpose === 'admin';
    let freshLoginCompleted = false;
    authenticating = true;
    ui['close-login'].disabled = true;
    ui['google-button-area'].inert = true;
    loginMessage(forAdmin ? 'Google 계정과 관리자 권한을 확인하고 있어요.' : 'Google 계정과 남은 제출 횟수를 확인하고 있어요.');
    renderControls();
    try {
      const data = await request('/api/login', { method: 'POST', body: { credential: response.credential } });
      // Login rotates the session. Use the new CSRF token before any automatic submission.
      authEpoch += 1;
      sessionReadSequence += 1;
      applySession(data);
      freshLoginCompleted = true;
      await refreshSession();
      if (!user) throw new Error('로그인 상태를 확인하지 못했어요. 다시 시도해 주세요.');
      if (forAdmin) {
        clearPending();
        authenticating = false;
        closeLogin(true);
        writeStorage('localStorage', AUTH_PULSE_KEY, String(Date.now()));
        if (user.isAdmin === true) navigateToAdmin();
        else {
          feedback('로그인한 계정에는 관리자 권한이 없어요. 제안은 전송하지 않았으며 작성한 내용은 보관됩니다.', 'error');
          await loadPrivate().catch(() => {});
        }
        return;
      }
      // Operations may have been paused while the Google popup was open.
      await refreshStatus();
      await loadPrivate();
      authenticating = false;
      closeLogin(true);
      feedback(operatingState().proposalsPaused ? `로그인했어요. ${pausedSubmissionMessage()}` : '로그인했어요. 아이디어를 남겨주세요.',
        operatingState().proposalsPaused ? 'error' : 'success', { reason: operatingState().proposalsPaused ? 'service' : '' });
      writeStorage('localStorage', AUTH_PULSE_KEY, String(Date.now()));
      await resumeExplicitSend();
    } catch (error) {
      if (!forAdmin && freshLoginCompleted && user) {
        clearPending();
        authenticating = false;
        closeLogin();
        feedback('로그인했지만 제출 준비를 마치지 못했어요. 작성한 내용은 보관됩니다. 연결을 다시 확인한 뒤 전송해 주세요.', 'error');
      } else {
        if (forAdmin) clearPending();
        loginMessage(error.message, true);
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
      feedback('로그아웃했어요. 작성 중이던 새 제안은 이 브라우저에 남아 있어요.');
      writeStorage('localStorage', AUTH_PULSE_KEY, String(Date.now()));
      await refreshSession();
    } catch (error) {
      feedback(user ? '로그아웃을 확인하지 못했어요. 연결을 확인한 뒤 다시 눌러주세요.' : '로그아웃했어요. 다시 로그인하려면 서버 연결을 확인해 주세요.', 'error');
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
      feedback('서버와 로그인 연결을 먼저 확인해 주세요. 작성한 내용은 그대로 남아 있어요.', 'error');
      await synchronize();
      return;
    }
    if (!proposalsOpen()) {
      clearPending();
      feedback(operatingState().proposalsPaused ? pausedSubmissionMessage()
        : '지금은 제안을 접수할 수 없어요. 작성한 내용은 보관되며 자동 전송하지 않습니다.', 'error',
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
      feedback('지금은 제안을 보낼 수 있는 횟수가 없어요. 표시된 시각 이후에 전송 버튼을 다시 눌러주세요.', 'error', { reason: 'quota' });
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
    feedback('새 제안 작성으로 돌아왔어요. 수정 중인 내용은 이 브라우저에 보관됩니다.');
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
    feedback('새 제안으로 준비했어요. 전송하면 제출 횟수 1회를 사용합니다.');
    ui.prompt.focus();
  });
  window.addEventListener('online', () => { synchronize(); });
  window.addEventListener('offline', () => { connectionError('인터넷 연결이 끊겼어요. 작성한 내용은 보관되며, 연결이 돌아와도 자동 전송하지 않습니다.'); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) synchronize(); });
  window.addEventListener('storage', (event) => {
    if (event.key === AUTH_PULSE_KEY && !submitting && !authenticating) synchronize();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastSyncAt > 15000) synchronize();
  });
  window.addEventListener('resize', () => { renderGoogleButton(); });

  renderControls();
  renderTime();
  setInterval(renderTime, 1000);
  synchronize({ resumePending: true });
})();
