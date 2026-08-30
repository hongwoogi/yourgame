(() => {
  'use strict';

  const REAUTH_DRAFT_KEY = 'yourgame.admin.reauth-draft.v1';
  const AUTH_PULSE_KEY = 'yourgame.auth-pulse.v1';
  const SECTIONS = {
    overview: ['SERVICE OVERVIEW', '운영 개요', '서비스 상태와 최근 운영 기록을 확인합니다.'],
    users: ['MEMBERS', '회원', '계정과 기여 이력을 보존하면서 이용 상태를 관리합니다.'],
    proposals: ['COMMUNITY INPUT', '프롬프트', '원문을 보존하며 제안을 검토하고 개발 입력을 정리합니다.'],
    versions: ['DEVELOPMENT REQUESTS', '개발 버전', '개발 요청과 작업 이력을 확인합니다. 실제 게임 공개 이력과는 별도입니다.'],
    service: ['SERVICE OPERATIONS', '서비스 운영', '접수·자동 개발 허용과 점검·종료·재개를 관리합니다.'],
    audit: ['AUDIT TRAIL', '감사 이력', '관리자가 실행한 변경과 그 사유를 확인합니다.'],
  };
  const LIST_SECTIONS = ['users', 'proposals', 'versions', 'audit'];
  const MODE_LABELS = { active: '활성', maintenance: '점검', ended: '종료' };
  const USER_LABELS = { active: '활성', suspended: '이용 정지' };
  const MODERATION_LABELS = { pending: '검토 대기', reviewed: '검토 완료', excluded: '개발 대상 제외' };
  const VERSION_LABELS = { queued: '대기', running: '실행 중', failed: '실패', completed: '작업 완료', cancelled: '취소' };
  const ACTION_LABELS = {
    set_user_status: '회원 상태 변경', moderate_proposal: '프롬프트 검토 변경',
    create_version: '개발 요청 등록', retry_version: '개발 재시도 요청',
    cancel_version: '개발 취소·중단 요청', set_service: '서비스 설정 변경',
  };
  const state = {
    authorized: false, sessionReady: false, epoch: 0, sessionSequence: 0, csrfToken: null, user: null, admin: null,
    section: 'overview', overview: null, service: null, serviceReady: false, serviceDirty: false,
    busy: false, attempt: null, dialogAction: null, dialogConflict: false, returnFocus: null,
    reasons: new Map(), heartbeat: null, overviewSequence: 0,
    lists: Object.fromEntries(LIST_SECTIONS.map((name) => [name, {
      items: [], filters: {}, cursor: null, previous: [], nextCursor: null, page: 1, ready: false, loading: false, sequence: 0,
    }])),
  };
  const $ = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    'admin-gate', 'gate-title', 'gate-message', 'gate-login', 'gate-retry', 'admin-shell',
    'admin-main', 'admin-name', 'admin-email', 'admin-logout', 'section-eyebrow', 'section-title',
    'section-description', 'refresh-view', 'current-service-badge', 'last-refreshed', 'admin-notice',
    'admin-notice-message', 'retry-mutation', 'reauth-link', 'overview-mode', 'overview-permissions',
    'service-form', 'service-mode-input', 'service-proposals', 'service-development', 'service-message',
    'service-reason', 'service-feedback', 'service-submit', 'service-current-mode', 'service-revision',
    'danger-title', 'danger-description', 'danger-service-button', 'recent-auth-note', 'version-form',
    'version-label', 'version-summary', 'version-reason', 'version-feedback', 'version-create',
    'action-dialog', 'action-title', 'action-description', 'action-target', 'action-form', 'action-reason',
    'confirmation-field', 'confirmation-phrase', 'action-confirmation', 'action-feedback', 'action-submit',
    'action-close', 'action-cancel', 'action-retry', 'action-reauth-link',
  ].map((id) => [id, $(id)]));

  class ApiError extends Error {
    constructor(message, status = 0, code = '') { super(message); this.status = status; this.code = code; }
  }
  class StaleResponse extends Error {}
  const text = (value, fallback = '—') => value === null || value === undefined || value === '' ? fallback : String(value);
  const revisionValid = (value) => Number.isInteger(value) && value > 0;
  const codePoints = (value) => [...value].length;
  const element = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = text(value, '');
    return node;
  };

  function notice(message, kind = 'success', { retry = false, reauth = false } = {}) {
    if (!state.authorized) return;
    ui['admin-notice'].hidden = !message;
    ui['admin-notice'].dataset.kind = kind;
    ui['admin-notice-message'].textContent = message;
    ui['retry-mutation'].hidden = !(retry || state.attempt?.unknown === true);
    ui['reauth-link'].hidden = !reauth;
    ui['action-reauth-link'].hidden = !reauth || !ui['action-dialog'].open;
  }

  function fieldFeedback(id, message) {
    const node = ui[id];
    if (!node?.isConnected) return;
    node.textContent = message;
    node.hidden = !message;
  }

  function clearReauthDraft() { try { sessionStorage.removeItem(REAUTH_DRAFT_KEY); } catch { /* No credentials are stored. */ } }

  function denyAccess(message = '관리자 권한이 없는 계정입니다. 관리 데이터는 표시하지 않습니다.', title = '관리자 접근을 확인해 주세요.') {
    state.epoch += 1;
    state.authorized = false;
    state.sessionReady = false;
    state.csrfToken = null;
    state.user = null;
    state.admin = null;
    state.overview = null;
    state.service = null;
    state.serviceReady = false;
    state.dialogAction = null;
    state.attempt = null;
    state.reasons.clear();
    for (const list of Object.values(state.lists)) { list.items = []; list.ready = false; list.sequence += 1; }
    clearInterval(state.heartbeat);
    clearReauthDraft();
    if (ui['action-dialog'].open) ui['action-dialog'].close();
    for (const input of ui['admin-shell'].querySelectorAll('input, textarea')) input.value = '';
    ui['admin-shell'].replaceChildren();
    ui['admin-shell'].hidden = true;
    ui['admin-gate'].hidden = false;
    ui['gate-title'].textContent = title;
    ui['gate-message'].textContent = message;
    ui['gate-login'].hidden = false;
    ui['gate-retry'].hidden = false;
  }

  async function api(path, { method = 'GET', payload } = {}) {
    const epoch = state.epoch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      const headers = { Accept: 'application/json' };
      if (method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
      }
      const response = await fetch(path, {
        method, headers, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      if (epoch !== state.epoch) throw new StaleResponse();
      let data;
      try { data = await response.json(); }
      catch {
        if (response.status === 401 || response.status === 403) denyAccess('관리자 접근이 거부되었습니다. 표시 중인 관리 데이터를 지웠습니다. 다시 로그인해 주세요.');
        throw new ApiError('서버 응답을 확인하지 못했습니다.', response.status >= 400 ? response.status : 0);
      }
      if (epoch !== state.epoch) throw new StaleResponse();
      if (!response.ok) {
        const code = typeof data?.error?.code === 'string' ? data.error.code : '';
        const message = response.status < 500 && typeof data?.error?.message === 'string'
          ? data.error.message.slice(0, 500) : '서버 연결에 실패했습니다. 입력한 내용은 그대로 보관됩니다.';
        if ((response.status === 401 || response.status === 403) && code !== 'ADMIN_REAUTH_REQUIRED') {
          denyAccess(response.status === 401
            ? '로그인 상태가 만료되었거나 변경되었습니다. 표시 중인 관리 데이터를 지웠습니다. 다시 로그인해 주세요.'
            : '관리자 접근이 거부되었습니다. 표시 중인 관리 데이터를 지웠습니다. 관리자 계정으로 다시 확인해 주세요.');
        }
        throw new ApiError(message, response.status, code);
      }
      return data;
    } catch (error) {
      if (epoch !== state.epoch || error instanceof StaleResponse) throw new StaleResponse();
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.name === 'AbortError'
        ? '응답이 늦어 요청 결과를 확인하지 못했습니다.' : '인터넷 또는 서버 연결을 확인해 주세요.');
    } finally { clearTimeout(timer); }
  }

  async function verifySession() {
    const sequence = ++state.sessionSequence;
    const data = await api('/api/session');
    if (sequence !== state.sessionSequence) return false;
    if (!data?.user || data.user.isAdmin !== true || !data.csrfToken) {
      denyAccess(data?.user ? '이 계정에는 관리자 권한이 없습니다. 관리 데이터는 표시하지 않습니다.' : '관리자 계정의 Google 로그인이 필요합니다.');
      return false;
    }
    if (state.user && state.user.id !== data.user.id) {
      denyAccess('로그인 계정이 바뀌었습니다. 관리 데이터를 지웠습니다. 새로 접속해 권한을 확인해 주세요.');
      return false;
    }
    state.user = data.user;
    state.csrfToken = data.csrfToken;
    state.sessionReady = true;
    return true;
  }

  function formatDate(value, seconds = false) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23',
    }).format(date);
  }

  function timeCell(value) {
    const cell = element('td');
    const time = element('time', '', formatDate(value));
    if (value) time.dateTime = String(value);
    cell.append(time);
    return cell;
  }

  function badge(value, labels, tone = '') {
    const node = element('span', 'badge', labels[value] || '상태 확인 불가');
    if (tone) node.dataset.tone = tone;
    return node;
  }

  function modeTone(mode) { return mode === 'active' ? 'positive' : mode === 'ended' ? 'danger' : 'warning'; }

  function setServiceDraft(values) {
    ui['service-mode-input'].value = ['active', 'maintenance', 'ended'].includes(values.mode) ? values.mode : 'maintenance';
    ui['service-proposals'].checked = values.proposalsEnabled === true;
    ui['service-development'].checked = values.developmentEnabled === true;
    ui['service-message'].value = typeof values.message === 'string' ? values.message : '';
    if (typeof values.reason === 'string') ui['service-reason'].value = values.reason;
  }

  function serviceDraft() {
    return {
      mode: ui['service-mode-input'].value,
      proposalsEnabled: ui['service-proposals'].checked,
      developmentEnabled: ui['service-development'].checked,
      message: ui['service-message'].value.trim(), reason: ui['service-reason'].value.trim(),
    };
  }

  function renderService({ replaceDraft = false } = {}) {
    const service = state.service;
    if (!service || !state.authorized) return;
    const modeLabel = MODE_LABELS[service.mode] || '상태 확인 불가';
    ui['current-service-badge'].textContent = modeLabel;
    ui['current-service-badge'].dataset.tone = modeTone(service.mode);
    ui['overview-mode'].textContent = modeLabel;
    ui['overview-permissions'].textContent = `프롬프트 접수 ${service.proposalsEnabled ? '허용' : '중지'} · 자동 개발 ${service.developmentEnabled ? '허용' : '중지'}${service.mode === 'active' ? '' : '\n현재 운영 상태에서는 새 접수·개발·공개를 진행하지 않습니다.'}`;
    ui['service-current-mode'].textContent = modeLabel;
    ui['service-revision'].textContent = `revision ${service.revision} · ${formatDate(service.updatedAt)} KST`;
    if (replaceDraft || !state.serviceDirty) setServiceDraft(service);
    const ended = service.mode === 'ended';
    ui['danger-title'].textContent = ended ? '종료된 서비스 재개' : '서비스 종료';
    ui['danger-description'].textContent = ended
      ? '데이터와 관리자 접근은 유지되어 있습니다. 다시 허용할 접수·개발 기능을 직접 선택한 뒤 재개해 주세요.'
      : '접수·자동 개발·공개를 중단합니다. 데이터는 삭제하지 않으며 관리자 접근과 복구 경로는 유지합니다.';
    ui['danger-service-button'].textContent = ended ? '서비스 재개…' : '서비스 종료…';
    ui['service-submit'].textContent = ended ? '재개 설정 확인' : '운영 설정 저장';
    const until = state.admin?.recentAuthUntil;
    ui['recent-auth-note'].textContent = until
      ? `민감 작업 인증 기준: ${formatDate(until)} KST까지. 종료·재개 시 서버에서 다시 확인합니다.`
      : '종료와 재개에는 최근 Google 로그인과 확인 문구가 필요합니다.';
  }

  async function loadOverview({ replaceDraft = false, initial = false } = {}) {
    const sequence = ++state.overviewSequence;
    try {
      const data = await api('/api/admin?section=overview');
      if (sequence !== state.overviewSequence) return;
      if (!data?.admin?.id || data.admin.id !== state.user?.id) {
        denyAccess('관리자 계정과 조회 결과가 일치하지 않습니다. 다시 접속해 권한을 확인해 주세요.');
        return;
      }
      if (!data.service || !MODE_LABELS[data.service.mode] || !revisionValid(data.service.revision)) {
        throw new ApiError('운영 상태를 확인하지 못했습니다. 설정 변경을 잠시 멈추고 다시 조회해 주세요.');
      }
      if (initial) state.authorized = true;
      if (!state.authorized) return;
      state.admin = data.admin;
      state.overview = data;
      state.service = data.service;
      state.serviceReady = true;
      ui['admin-name'].textContent = text(data.admin.name, '관리자');
      ui['admin-email'].textContent = text(data.admin.email, '');
      const counts = data.counts || {};
      for (const [key, id] of Object.entries({ users: 'count-users', suspendedUsers: 'count-suspended-users',
        proposals: 'count-proposals', excludedProposals: 'count-excluded-proposals', versions: 'count-versions', pendingVersions: 'count-pending-versions' })) {
        $(id).textContent = Number.isSafeInteger(counts[key]) && counts[key] >= 0 ? counts[key].toLocaleString('ko-KR') : '—';
      }
      renderService({ replaceDraft });
      renderAudit('recent-audit-rows', Array.isArray(data.recentAudit) ? data.recentAudit : []);
      markUpdated();
      updateControls();
      return data;
    } catch (error) {
      if (sequence !== state.overviewSequence || error instanceof StaleResponse) return;
      state.serviceReady = false;
      updateControls();
      if (!initial && state.authorized) notice(error.message, 'error');
      throw error;
    }
  }

  function markUpdated() { ui['last-refreshed'].textContent = `${formatDate(Date.now(), true)} KST 조회`; }

  function emptyRows(bodyId, title, description) {
    const body = $(bodyId);
    body.replaceChildren();
    const row = element('tr');
    const cell = element('td', 'table-empty');
    cell.colSpan = 5;
    cell.append(element('strong', '', title), element('small', '', description));
    row.append(cell);
    body.append(row);
  }

  function recordButton(label, handler, { danger = false, section = '', disabled = false } = {}) {
    const button = element('button', `text-button${danger ? ' danger' : ''}`, label);
    button.type = 'button';
    button.dataset.operation = 'record';
    button.dataset.recordSection = section;
    if (disabled) button.dataset.blocked = 'true';
    button.addEventListener('click', handler);
    return button;
  }

  function userCell(user) {
    const cell = element('td');
    cell.append(element('p', 'cell-name', text(user.name, '이름 없음')),
      element('small', 'cell-secondary', user.email), element('small', 'cell-id', user.id));
    return cell;
  }

  function renderUsers(items) {
    if (!items.length) { emptyRows('users-rows', '조회된 회원이 없습니다.', '검색 조건을 바꾸거나 다음 가입을 기다려 주세요.'); return; }
    const fragment = document.createDocumentFragment();
    for (const user of items) {
      const row = element('tr');
      const status = element('td');
      status.append(badge(user.status, USER_LABELS, user.status === 'suspended' ? 'warning' : ''));
      if (user.isAdmin || user.id === state.admin.id) status.append(element('small', '', '관리자 · 정지 불가'));
      const count = element('td', '', Number.isSafeInteger(user.proposalCount) ? user.proposalCount.toLocaleString('ko-KR') : '—');
      const actions = element('td');
      const group = element('div', 'cell-actions');
      const view = element('button', 'text-button', '제안 보기');
      view.type = 'button';
      view.addEventListener('click', () => {
        const form = $('proposals-filters');
        form.reset();
        form.elements.userId.value = user.id;
        resetList('proposals', formFilters('proposals'));
        openSection('proposals');
      });
      group.append(view);
      if (!user.isAdmin && user.id !== state.admin.id && USER_LABELS[user.status]) {
        const nextStatus = user.status === 'suspended' ? 'active' : 'suspended';
        group.append(recordButton(nextStatus === 'suspended' ? '이용 정지' : '이용 정지 해제',
          () => openRecordAction('set_user_status', user, { status: nextStatus }),
          { section: 'users', danger: nextStatus === 'suspended', disabled: !revisionValid(user.revision) }));
      }
      actions.append(group);
      row.append(userCell(user), status, count, timeCell(user.createdAt), actions);
      fragment.append(row);
    }
    $('users-rows').replaceChildren(fragment);
  }

  function renderProposals(items) {
    if (!items.length) { emptyRows('proposals-rows', '조회된 프롬프트가 없습니다.', '회원·회차·검토 상태 필터를 확인해 주세요.'); return; }
    const fragment = document.createDocumentFragment();
    for (const proposal of items) {
      const row = element('tr');
      const bodyCell = element('td');
      const details = element('details', 'proposal-original');
      const summary = element('summary');
      const body = typeof proposal.body === 'string' ? proposal.body : '';
      const preview = [...body].slice(0, 110).join('');
      summary.append(document.createTextNode(preview + (codePoints(body) > 110 ? '…' : '')), element('small', '', '원문 전체 확인 ↗'));
      details.append(summary, element('pre', '', body));
      bodyCell.append(details, element('small', 'cell-id', proposal.id));
      const author = userCell(proposal.user || {});
      author.append(element('small', '', `회차 ${text(proposal.roundId)}`));
      const moderation = element('td');
      moderation.append(badge(proposal.moderation, MODERATION_LABELS, proposal.moderation === 'excluded' ? 'warning' : ''));
      if (proposal.moderationReason) moderation.append(element('p', 'proposal-reason', proposal.moderationReason));
      const actions = element('td');
      const group = element('div', 'cell-actions');
      const allowed = revisionValid(proposal.moderationRevision);
      if (proposal.moderation === 'excluded') {
        group.append(recordButton('개발 대상 복원', () => openRecordAction('moderate_proposal', proposal, { moderation: 'pending' }), { section: 'proposals', disabled: !allowed }));
      } else if (MODERATION_LABELS[proposal.moderation]) {
        const next = proposal.moderation === 'reviewed' ? 'pending' : 'reviewed';
        group.append(recordButton(next === 'reviewed' ? '검토 완료' : '검토 대기로',
          () => openRecordAction('moderate_proposal', proposal, { moderation: next }), { section: 'proposals', disabled: !allowed }),
        recordButton('개발 대상 제외', () => openRecordAction('moderate_proposal', proposal, { moderation: 'excluded' }), { section: 'proposals', danger: true, disabled: !allowed }));
      }
      actions.append(group);
      row.append(bodyCell, author, moderation, timeCell(proposal.createdAt), actions);
      fragment.append(row);
    }
    $('proposals-rows').replaceChildren(fragment);
  }

  function renderVersions(items) {
    if (!items.length) { emptyRows('versions-rows', '개발 요청이 아직 없습니다.', '실제 게임 공개 이력과 별도로, 개발 요청을 등록하면 이곳에 기록됩니다.'); return; }
    const fragment = document.createDocumentFragment();
    for (const version of items) {
      const row = element('tr');
      const label = element('td');
      label.append(element('p', 'cell-name', version.label), element('p', 'version-summary', version.summary), element('small', 'cell-id', version.id));
      const status = element('td');
      status.append(badge(version.status, VERSION_LABELS, version.status === 'failed' ? 'warning' : ''));
      if (version.cancelRequested) status.append(element('small', '', '안전 확인 지점에서 중단 요청됨'));
      if (version.status === 'completed') status.append(element('small', '', '게임 공개 여부와 별도'));
      const references = element('td');
      references.append(element('small', 'cell-id', version.parentId ? `원 요청 ${version.parentId}` : '원 요청 —'),
        element('small', 'cell-id', version.commitSha ? `커밋 ${String(version.commitSha).slice(0, 12)}` : '커밋 기록 없음'));
      const actions = element('td');
      const group = element('div', 'cell-actions');
      if (version.status === 'queued' || version.status === 'running') {
        group.append(recordButton(version.status === 'queued' ? '요청 취소' : '중단 요청',
          () => openRecordAction('cancel_version', version),
          { section: 'versions', danger: true, disabled: !revisionValid(version.revision) || version.cancelRequested === true }));
      } else if (version.status === 'failed' || version.status === 'cancelled') {
        group.append(recordButton('다시 요청', () => openRecordAction('retry_version', version), { section: 'versions', disabled: !revisionValid(version.revision) }));
      }
      actions.append(group);
      row.append(label, status, timeCell(version.updatedAt || version.createdAt), references, actions);
      fragment.append(row);
    }
    $('versions-rows').replaceChildren(fragment);
  }

  function renderAudit(bodyId, items) {
    if (!items.length) { emptyRows(bodyId, '아직 운영 변경 기록이 없습니다.', '관리자가 변경을 실행하면 운영자와 사유가 기록됩니다.'); return; }
    const fragment = document.createDocumentFragment();
    for (const entry of items) {
      const row = element('tr');
      const reason = element('td', 'cell-secondary', entry.reason);
      reason.style.whiteSpace = 'pre-wrap';
      reason.style.overflowWrap = 'anywhere';
      row.append(timeCell(entry.createdAt), element('td', '', ACTION_LABELS[entry.action] || text(entry.action)),
        element('td', 'cell-id', entry.targetId), reason, element('td', 'cell-secondary', entry.actorName));
      fragment.append(row);
    }
    $(bodyId).replaceChildren(fragment);
  }

  function formFilters(section) {
    const params = {};
    for (const [key, value] of new FormData($(`${section}-filters`)).entries()) if (String(value).trim()) params[key] = String(value).trim();
    return params;
  }

  function resetList(section, filters = {}) {
    Object.assign(state.lists[section], { filters, cursor: null, previous: [], nextCursor: null, page: 1, ready: false });
  }

  function renderPagination(section) {
    const list = state.lists[section];
    $(`${section}-page-info`).textContent = `${list.page} 페이지 · ${list.items.length}개 표시 · 페이지당 최대 50개`;
    document.querySelector(`[data-prev="${section}"]`).disabled = list.loading || !list.previous.length;
    document.querySelector(`[data-next="${section}"]`).disabled = list.loading || !list.nextCursor;
  }

  async function loadList(section) {
    if (!state.authorized || !state.lists[section]) return;
    const list = state.lists[section];
    const sequence = ++list.sequence;
    list.loading = true;
    const query = new URLSearchParams({ section, limit: '50', ...list.filters });
    if (list.cursor) query.set('cursor', list.cursor);
    updateControls();
    renderPagination(section);
    try {
      const data = await api(`/api/admin?${query}`);
      if (!state.authorized || sequence !== list.sequence) return;
      if (!Array.isArray(data?.items)) throw new ApiError('목록 응답을 확인하지 못했습니다. 다시 조회해 주세요.');
      list.items = data.items;
      list.nextCursor = typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null;
      list.ready = true;
      if (section === 'users') renderUsers(data.items);
      else if (section === 'proposals') renderProposals(data.items);
      else if (section === 'versions') renderVersions(data.items);
      else renderAudit('audit-rows', data.items);
      markUpdated();
      return data;
    } catch (error) {
      if (error instanceof StaleResponse || !state.authorized || sequence !== list.sequence) return;
      list.ready = false;
      notice(error.message, 'error');
      throw error;
    } finally {
      if (state.authorized && sequence === list.sequence) { list.loading = false; renderPagination(section); updateControls(); }
    }
  }

  async function openSection(section, { fetch = true } = {}) {
    if (!state.authorized || !SECTIONS[section]) return;
    state.section = section;
    const [eyebrow, title, description] = SECTIONS[section];
    ui['section-eyebrow'].textContent = eyebrow;
    ui['section-title'].textContent = title;
    ui['section-description'].textContent = description;
    for (const panel of document.querySelectorAll('.admin-panel')) panel.hidden = panel.id !== `panel-${section}`;
    for (const link of document.querySelectorAll('.admin-nav [data-section]')) {
      if (link.dataset.section === section) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    history.replaceState(null, '', `#${section}`);
    if (fetch) {
      try { if (state.lists[section]) await loadList(section); else await loadOverview(); }
      catch { /* The request handler displays the error without changing form drafts. */ }
    }
  }

  function dialogKey(action) { return `${action.action}:${action.userId || action.proposalId || action.versionId || 'service'}`; }

  function openRecordAction(action, record, change = {}) {
    if (!state.authorized || state.busy || state.attempt?.unknown) return;
    let config;
    if (action === 'set_user_status') {
      if (record.isAdmin || record.id === state.admin.id || !revisionValid(record.revision)) return;
      config = {
        action, userId: record.id, status: change.status, revision: record.revision, section: 'users',
        title: change.status === 'suspended' ? '회원 이용 정지' : '회원 이용 정지 해제',
        target: `${text(record.name, '회원')} · ${text(record.email)}`,
        description: change.status === 'suspended'
          ? '현재 로그인 세션을 회수하고 새 접수·수정을 차단합니다. 계정과 기존 기여 이력은 삭제하지 않습니다.'
          : '회원이 다시 로그인하고 제안할 수 있도록 이용 정지를 해제합니다. 기존 기록은 유지됩니다.',
      };
    } else if (action === 'moderate_proposal') {
      if (!revisionValid(record.moderationRevision)) return;
      config = {
        action, proposalId: record.id, moderation: change.moderation, revision: record.moderationRevision, section: 'proposals',
        title: change.moderation === 'excluded' ? '개발 대상에서 제외' : change.moderation === 'reviewed' ? '검토 완료로 변경' : record.moderation === 'excluded' ? '개발 대상으로 복원' : '검토 대기로 변경',
        target: `프롬프트 ${record.id}`,
        description: '제안 원문·접수 시각·제출 횟수는 그대로 보존합니다. 제외된 프롬프트는 개발 입력으로 사용하지 않으며, 고정된 회차 입력은 별도로 재확인합니다.',
      };
    } else {
      if (!revisionValid(record.revision)) return;
      config = {
        action, versionId: record.id, revision: record.revision, section: 'versions', target: text(record.label),
        title: action === 'retry_version' ? '개발 다시 요청' : record.status === 'running' ? '실행 중 작업 중단 요청' : '대기 개발 요청 취소',
        description: action === 'retry_version'
          ? '기존 실패·취소 기록을 보존하고 새 대기 요청을 만듭니다. 요청 등록만으로 개발·검증·게임 공개가 완료되지는 않습니다.'
          : record.status === 'running' ? '다음 안전 확인 지점에서 중단하도록 요청합니다. 외부에 이미 전송한 배포 요청을 즉시 취소한다는 뜻은 아닙니다.'
            : '아직 시작하지 않은 개발 요청을 취소하고 기록을 보존합니다.',
      };
    }
    showDialog(config);
  }

  function showDialog(config, reason = '') {
    if (!state.authorized || state.busy || state.attempt?.unknown) return;
    state.dialogAction = config;
    state.dialogConflict = false;
    state.returnFocus = document.activeElement;
    ui['action-title'].textContent = config.title;
    ui['action-target'].textContent = config.target || '';
    ui['action-description'].textContent = config.description;
    ui['action-reason'].value = reason || state.reasons.get(dialogKey(config)) || '';
    ui['action-confirmation'].value = '';
    ui['action-reauth-link'].hidden = true;
    ui['confirmation-field'].hidden = !config.confirmation;
    ui['confirmation-phrase'].textContent = config.confirmation || '';
    ui['action-submit'].classList.toggle('danger', Boolean(config.confirmation));
    ui['action-submit'].classList.toggle('primary', !config.confirmation);
    fieldFeedback('action-feedback', '');
    if (!ui['action-dialog'].open) ui['action-dialog'].showModal();
    updateControls();
    ui['action-reason'].focus();
  }

  function closeDialog() {
    if (state.busy || !ui['action-dialog'].isConnected) return;
    if (state.dialogAction) state.reasons.set(dialogKey(state.dialogAction), ui['action-reason'].value);
    ui['action-dialog'].close();
  }

  function validateText(value, label, limit, required = true) {
    const trimmed = String(value).trim();
    if (required && !trimmed) throw new Error(`${label} 항목을 입력해 주세요.`);
    if (codePoints(trimmed) > limit) throw new Error(`${label} 항목은 ${limit.toLocaleString('ko-KR')}자까지 입력할 수 있습니다.`);
    return trimmed;
  }

  function servicePayload({ ending = false } = {}) {
    if (!state.serviceReady || !revisionValid(state.service?.revision)) throw new Error('운영 상태를 먼저 새로 조회해 주세요.');
    const draft = serviceDraft();
    return {
      action: 'set_service', mode: ending ? 'ended' : draft.mode,
      proposalsEnabled: ending ? false : draft.proposalsEnabled,
      developmentEnabled: ending ? false : draft.developmentEnabled,
      message: validateText(draft.message, '서비스 공지', 1000, false), revision: state.service.revision,
    };
  }

  function openServiceConfirmation(ending = false) {
    try {
      if (!ending && ui['service-mode-input'].value === 'ended') {
        ui['service-mode-input'].value = 'active';
        state.serviceDirty = true;
      }
      const payload = servicePayload({ ending });
      const confirmation = ending ? '서비스 종료' : '서비스 재개';
      showDialog({
        ...payload, confirmation, section: 'service', title: confirmation,
        target: `${MODE_LABELS[state.service.mode]} → ${MODE_LABELS[payload.mode]} · revision ${payload.revision}`,
        description: ending
          ? '신규·수정 접수와 자동 개발·공개를 중단하고 두 허용 스위치를 끕니다. 데이터는 삭제하지 않으며 관리자 접근은 유지됩니다. 실행 중 작업은 다음 안전 확인 지점에서 중단합니다.'
          : `종료된 서비스를 ${MODE_LABELS[payload.mode]} 상태로 재개합니다. 프롬프트 접수는 ${payload.proposalsEnabled ? '허용' : '중지'}, 자동 개발은 ${payload.developmentEnabled ? '허용' : '중지'}로 저장합니다. 선택한 기능과 공지를 확인해 주세요.`,
      }, ui['service-reason'].value);
    } catch (error) { fieldFeedback('service-feedback', error.message); }
  }

  function payloadForDialog() {
    const config = state.dialogAction;
    if (!config || state.dialogConflict) throw new Error('최신 상태를 다시 확인하고 작업을 열어 주세요.');
    const reason = validateText(ui['action-reason'].value, '변경 사유', 500);
    const payload = { action: config.action, reason };
    for (const key of ['userId', 'status', 'proposalId', 'moderation', 'versionId', 'revision', 'mode', 'proposalsEnabled', 'developmentEnabled', 'message']) {
      if (Object.hasOwn(config, key)) payload[key] = config[key];
    }
    if (config.confirmation) {
      if (ui['action-confirmation'].value !== config.confirmation) throw new Error(`확인 문구 '${config.confirmation}'를 정확히 입력해 주세요.`);
      payload.confirmation = ui['action-confirmation'].value;
    }
    return payload;
  }

  function updateControls() {
    if (!state.authorized || !ui['admin-shell'].isConnected) return;
    const locked = state.busy || state.attempt?.unknown === true;
    for (const button of document.querySelectorAll('[data-operation]')) {
      let disabled = locked || !state.sessionReady || button.dataset.blocked === 'true';
      if (button.dataset.recordSection) {
        const list = state.lists[button.dataset.recordSection];
        disabled ||= !list.ready || list.loading;
      }
      if (['service', 'danger-service'].includes(button.dataset.operation)) disabled ||= !state.serviceReady;
      button.disabled = disabled;
    }
    for (const form of [ui['service-form'], ui['version-form'], ui['action-form']]) {
      form.setAttribute('aria-busy', state.busy ? 'true' : 'false');
      for (const field of form.querySelectorAll('input, select, textarea')) field.disabled = locked;
    }
    const config = state.dialogAction;
    const validReason = ui['action-reason'].value.trim().length > 0 && codePoints(ui['action-reason'].value.trim()) <= 500;
    const validConfirmation = !config?.confirmation || ui['action-confirmation'].value === config.confirmation;
    const dialogRetry = state.attempt?.unknown === true && state.attempt.channel === 'dialog';
    ui['action-submit'].hidden = dialogRetry;
    ui['action-retry'].hidden = !dialogRetry;
    ui['action-retry'].disabled = state.busy || !state.sessionReady;
    ui['action-submit'].disabled = state.busy || !state.sessionReady || state.dialogConflict || !config || !validReason || !validConfirmation || state.attempt?.unknown === true;
    ui['action-submit'].textContent = state.busy && state.attempt?.channel === 'dialog' ? '처리 중…' : '확인하고 실행';
    ui['action-close'].disabled = state.busy;
    ui['action-cancel'].disabled = state.busy;
    ui['admin-logout'].disabled = state.busy;
    ui['retry-mutation'].disabled = state.busy || !state.sessionReady;
  }

  function attemptFor(channel, payload) {
    const signature = JSON.stringify(payload);
    if (state.attempt?.unknown) return state.attempt;
    if (!state.attempt || state.attempt.channel !== channel || state.attempt.signature !== signature) {
      state.attempt = { channel, signature, payload: { ...payload, requestId: crypto.randomUUID() }, unknown: false };
    }
    return state.attempt;
  }

  function operationSection(action) {
    if (action === 'set_user_status') return 'users';
    if (action === 'moderate_proposal') return 'proposals';
    if (action === 'set_service') return 'service';
    return 'versions';
  }

  async function refreshAfterMutation(payload, { conflict = false } = {}) {
    if (!state.authorized) return;
    const section = operationSection(payload.action);
    const tasks = [loadOverview({ replaceDraft: payload.action === 'set_service' && !conflict })];
    if (state.lists[section]) tasks.push(loadList(section));
    if (state.section === 'audit') tasks.push(loadList('audit'));
    const results = await Promise.allSettled(tasks);
    if (!state.authorized) return;
    if (conflict && state.dialogAction?.action === payload.action) {
      let nextRevision;
      if (payload.action === 'set_service') nextRevision = state.service?.revision;
      else {
        const id = payload.userId || payload.proposalId || payload.versionId;
        const latest = state.lists[section]?.items.find((item) => item.id === id);
        nextRevision = payload.action === 'moderate_proposal' ? latest?.moderationRevision : latest?.revision;
      }
      if (revisionValid(nextRevision) && results.every((result) => result.status === 'fulfilled')) {
        state.dialogAction.revision = nextRevision;
        state.dialogConflict = false;
        ui['action-confirmation'].value = '';
        fieldFeedback('action-feedback', '최신 상태를 다시 조회했습니다. 작성한 사유를 확인하고 작업을 다시 실행해 주세요.');
      } else {
        state.dialogConflict = true;
        fieldFeedback('action-feedback', '최신 대상을 확인하지 못했습니다. 사유는 보관됩니다. 목록에서 대상을 다시 조회한 뒤 작업을 열어 주세요.');
      }
    }
    updateControls();
    return results.every((result) => result.status === 'fulfilled');
  }

  async function performMutation(channel, payload, { retry = false } = {}) {
    if (!state.authorized || !state.sessionReady || state.busy) return;
    if (state.attempt?.unknown && !retry) {
      notice('아직 결과를 확인하지 못한 요청이 있습니다. 새 작업 전에 같은 요청으로 결과를 확인해 주세요.', 'error', { retry: true });
      return;
    }
    const attempt = retry ? state.attempt : attemptFor(channel, payload);
    if (!attempt) return;
    state.busy = true;
    updateControls();
    const feedbackId = attempt.channel === 'dialog' ? 'action-feedback' : attempt.channel === 'service' ? 'service-feedback' : 'version-feedback';
    fieldFeedback(feedbackId, '');
    try {
      const result = await api('/api/admin', { method: 'POST', payload: attempt.payload });
      if (!state.authorized) return;
      if (result?.ok !== true) throw new ApiError('변경 결과를 확인하지 못했습니다.');
      state.attempt = null;
      if (attempt.channel === 'dialog') {
        if (state.dialogAction) state.reasons.delete(dialogKey(state.dialogAction));
        ui['action-dialog'].close();
        state.dialogAction = null;
        ui['action-reason'].value = '';
        ui['action-confirmation'].value = '';
      }
      if (attempt.payload.action === 'create_version') {
        ui['version-form'].reset();
        ui['version-create'].open = false;
      }
      if (attempt.payload.action === 'set_service') {
        state.serviceDirty = false;
        ui['service-reason'].value = '';
      }
      clearReauthDraft();
      const successMessage = attempt.payload.action === 'create_version' || attempt.payload.action === 'retry_version'
        ? '개발 요청을 등록했습니다. 실행·검증·게임 공개는 별도 절차로 진행됩니다.'
        : attempt.payload.action === 'cancel_version' ? '취소·중단 요청을 기록했습니다. 실행 중인 작업은 다음 안전 확인 지점에서 확인합니다.'
          : '변경을 저장하고 감사 기록을 남겼습니다.';
      notice(successMessage);
      const refreshed = await refreshAfterMutation(attempt.payload);
      if (state.authorized && !refreshed) notice(`${successMessage} 최신 화면 조회에는 실패했으므로 새로고침해 주세요. 요청을 다시 보낼 필요는 없습니다.`, 'error');
    } catch (error) {
      if (error instanceof StaleResponse || !state.authorized) return;
      if (error.code === 'ADMIN_REAUTH_REQUIRED') {
        state.attempt = null;
        ui['action-confirmation'].value = '';
        fieldFeedback(feedbackId, '민감 작업에는 최근 Google 로그인이 필요합니다. 사유와 설정은 보존되며, 다시 인증한 뒤 직접 작업을 확인해야 합니다.');
        notice('민감 작업 인증이 만료되었습니다. Google로 다시 인증해 주세요. 작성한 사유와 설정을 보관하며 자동 실행하지 않습니다.', 'error', { reauth: true });
        saveReauthDraft();
      } else if (error.status === 409) {
        state.attempt = null;
        state.dialogConflict = attempt.channel === 'dialog';
        fieldFeedback(feedbackId, '다른 변경과 충돌했습니다. 사유와 입력을 보존하고 최신 상태를 다시 조회합니다.');
        notice('다른 작업이 먼저 반영되었습니다. 최신 상태를 다시 조회한 뒤 입력 내용을 확인해 주세요.', 'error');
        await refreshAfterMutation(attempt.payload, { conflict: true });
      } else if (error.status === 0 || error.status >= 500) {
        attempt.unknown = true;
        state.attempt = attempt;
        const message = '요청 결과를 확인하지 못했습니다. 입력과 요청 식별자를 보관합니다. 아래에서 같은 요청으로 다시 확인할 수 있으며 자동 재전송하지 않습니다.';
        fieldFeedback(feedbackId, message);
        notice(message, 'error', { retry: true });
      } else {
        state.attempt = null;
        fieldFeedback(feedbackId, error.message);
        notice(error.message, 'error');
      }
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  function saveReauthDraft() {
    if (!state.authorized || !state.admin) return;
    if (state.dialogAction) state.reasons.set(dialogKey(state.dialogAction), ui['action-reason'].value);
    try {
      sessionStorage.setItem(REAUTH_DRAFT_KEY, JSON.stringify({
        actorId: state.admin.id, createdAt: Date.now(), section: state.section,
        service: serviceDraft(), serviceDirty: state.serviceDirty,
        version: { label: ui['version-label'].value, summary: ui['version-summary'].value, reason: ui['version-reason'].value },
        reasons: [...state.reasons.entries()],
      }));
    } catch {
      notice('이 브라우저에서 재인증 전 임시 저장을 사용할 수 없습니다. 사유와 설정을 복사한 뒤 다시 인증해 주세요.', 'error', { reauth: true });
    }
  }

  function restoreReauthDraft() {
    let draft;
    try { draft = JSON.parse(sessionStorage.getItem(REAUTH_DRAFT_KEY) || 'null'); } catch { return; }
    if (!draft) return;
    clearReauthDraft();
    if (draft.actorId !== state.admin.id || !Number.isFinite(draft.createdAt) || Date.now() - draft.createdAt > 3600000 || draft.createdAt > Date.now()) return;
    if (draft.service && draft.serviceDirty) { setServiceDraft(draft.service); state.serviceDirty = true; }
    if (draft.version) {
      ui['version-label'].value = typeof draft.version.label === 'string' ? draft.version.label : '';
      ui['version-summary'].value = typeof draft.version.summary === 'string' ? draft.version.summary : '';
      ui['version-reason'].value = typeof draft.version.reason === 'string' ? draft.version.reason : '';
      ui['version-create'].open = Boolean(ui['version-label'].value || ui['version-summary'].value || ui['version-reason'].value);
    }
    if (Array.isArray(draft.reasons)) {
      for (const entry of draft.reasons.slice(0, 100)) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') state.reasons.set(entry[0], entry[1]);
    }
    if (SECTIONS[draft.section]) state.section = draft.section;
    notice('재인증 전 작성한 내용을 복원했습니다. 같은 대상의 작업을 열면 사유를 다시 확인할 수 있습니다. 자동 실행하지 않으며 확인 문구는 새로 입력해야 합니다.');
  }

  async function refreshCurrent() {
    if (!state.authorized || state.busy) return;
    ui['refresh-view'].disabled = true;
    try {
      if (!await verifySession()) return;
      if (state.lists[state.section]) await loadList(state.section);
      else await loadOverview();
      if (!state.attempt?.unknown && ui['reauth-link'].hidden) notice('최신 상태를 조회했습니다. 작성 중인 내용은 유지됩니다.');
    } catch (error) { if (!(error instanceof StaleResponse) && state.authorized) notice(error.message, 'error'); }
    finally { if (state.authorized) ui['refresh-view'].disabled = false; }
  }

  async function checkCurrentAccess() {
    if (!state.authorized || state.busy || document.hidden) return;
    try { await verifySession(); }
    catch (error) {
      if (!(error instanceof StaleResponse) && state.authorized) {
        state.serviceReady = false;
        state.sessionReady = false;
        for (const list of Object.values(state.lists)) list.ready = false;
        updateControls();
        notice('관리자 연결을 다시 확인하지 못했습니다. 작성한 내용은 유지되며 최신 조회 후 변경할 수 있습니다.', 'error');
      }
    }
  }

  for (const link of document.querySelectorAll('[data-section]')) link.addEventListener('click', (event) => {
    event.preventDefault();
    openSection(link.dataset.section);
  });
  for (const section of LIST_SECTIONS) {
    const form = $(`${section}-filters`);
    form.addEventListener('submit', (event) => {
      event.preventDefault(); resetList(section, formFilters(section)); loadList(section).catch(() => {});
    });
    form.addEventListener('reset', () => {
      queueMicrotask(() => { if (state.authorized) { resetList(section); loadList(section).catch(() => {}); } });
    });
    document.querySelector(`[data-next="${section}"]`).addEventListener('click', () => {
      const list = state.lists[section];
      if (!list.nextCursor || list.loading) return;
      list.previous.push(list.cursor); list.cursor = list.nextCursor; list.page += 1;
      loadList(section).catch(() => {});
    });
    document.querySelector(`[data-prev="${section}"]`).addEventListener('click', () => {
      const list = state.lists[section];
      if (!list.previous.length || list.loading) return;
      list.cursor = list.previous.pop(); list.page = Math.max(1, list.page - 1);
      loadList(section).catch(() => {});
    });
  }
  ui['refresh-view'].addEventListener('click', refreshCurrent);
  ui['gate-retry'].addEventListener('click', () => location.reload());
  ui['retry-mutation'].addEventListener('click', () => { if (state.attempt?.unknown) performMutation(state.attempt.channel, null, { retry: true }); });
  ui['action-retry'].addEventListener('click', () => { if (state.attempt?.unknown) performMutation(state.attempt.channel, null, { retry: true }); });
  ui['reauth-link'].addEventListener('click', saveReauthDraft);
  ui['action-reauth-link'].addEventListener('click', saveReauthDraft);
  ui['service-form'].addEventListener('input', () => { state.serviceDirty = true; });
  ui['service-form'].addEventListener('change', () => { state.serviceDirty = true; });
  ui['service-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy || state.attempt?.unknown) return;
    try {
      const payload = servicePayload();
      if (state.service.mode === 'ended' && payload.mode !== 'ended') { openServiceConfirmation(false); return; }
      if (payload.mode === 'ended') throw new Error('서비스 종료·재개는 아래 민감 작업 영역에서 확인해 주세요.');
      payload.reason = validateText(ui['service-reason'].value, '변경 사유', 500);
      performMutation('service', payload);
    } catch (error) { fieldFeedback('service-feedback', error.message); }
  });
  ui['danger-service-button'].addEventListener('click', () => {
    if (!state.busy && !state.attempt?.unknown && state.serviceReady) openServiceConfirmation(state.service.mode !== 'ended');
  });
  ui['version-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy || state.attempt?.unknown) return;
    try {
      const payload = {
        action: 'create_version', label: validateText(ui['version-label'].value, '요청 이름', 80),
        summary: validateText(ui['version-summary'].value, '개발 요구 요약', 2000),
        reason: validateText(ui['version-reason'].value, '등록 사유', 500),
      };
      performMutation('version', payload);
    } catch (error) { fieldFeedback('version-feedback', error.message); }
  });
  ui['action-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy || state.attempt?.unknown) return;
    try { performMutation('dialog', payloadForDialog()); }
    catch (error) { fieldFeedback('action-feedback', error.message); }
  });
  ui['action-reason'].addEventListener('input', () => {
    if (state.dialogAction) state.reasons.set(dialogKey(state.dialogAction), ui['action-reason'].value);
    updateControls();
  });
  ui['action-confirmation'].addEventListener('input', updateControls);
  ui['action-close'].addEventListener('click', closeDialog);
  ui['action-cancel'].addEventListener('click', closeDialog);
  ui['action-dialog'].addEventListener('cancel', (event) => {
    if (state.busy) event.preventDefault();
    else if (state.dialogAction) state.reasons.set(dialogKey(state.dialogAction), ui['action-reason'].value);
  });
  ui['action-dialog'].addEventListener('close', () => {
    if (state.returnFocus?.isConnected) state.returnFocus.focus();
  });
  ui['action-dialog'].addEventListener('click', (event) => {
    if (event.target !== ui['action-dialog']) return;
    const rect = ui['action-dialog'].getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDialog();
  });
  ui['admin-logout'].addEventListener('click', async () => {
    if (!state.authorized || state.busy) return;
    state.busy = true;
    state.epoch += 1;
    updateControls();
    try {
      await api('/api/logout', { method: 'POST', payload: {} });
      try { localStorage.setItem(AUTH_PULSE_KEY, String(Date.now())); } catch { /* Other pages still verify their own sessions. */ }
      denyAccess('로그아웃했습니다. 화면의 관리 데이터를 지웠습니다.', '로그아웃했습니다.');
    } catch (error) {
      if (!(error instanceof StaleResponse)) denyAccess('로그아웃 결과를 확인하지 못했습니다. 관리 데이터는 화면에서 지웠습니다. 다시 접속해 로그인 상태를 확인해 주세요.');
    } finally { state.busy = false; }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkCurrentAccess(); });
  window.addEventListener('storage', (event) => { if (event.key === AUTH_PULSE_KEY) checkCurrentAccess(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) checkCurrentAccess(); });

  async function boot() {
    try {
      if (!await verifySession()) return;
      await loadOverview({ initial: true, replaceDraft: true });
      if (!state.authorized) return;
      const section = location.hash.slice(1);
      if (SECTIONS[section]) state.section = section;
      restoreReauthDraft();
      ui['admin-gate'].hidden = true;
      ui['admin-shell'].hidden = false;
      await openSection(state.section, { fetch: state.section !== 'overview' && state.section !== 'service' });
      state.heartbeat = setInterval(checkCurrentAccess, 60000);
      updateControls();
    } catch (error) {
      if (error instanceof StaleResponse) return;
      ui['gate-title'].textContent = '관리 화면을 불러오지 못했습니다.';
      ui['gate-message'].textContent = error.message;
      ui['gate-retry'].hidden = false;
      ui['gate-login'].hidden = false;
    }
  }
  boot();
})();
