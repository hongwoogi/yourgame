import { i18n } from './i18n.js';
import './admin-messages.js';

(() => {
  'use strict';

  const COPY = Symbol('admin-interface-copy');
  const copyBindings = new Map();
  let pruneQueued = false;
  function liveCopy(render) { return { [COPY]: true, toString: render }; }
  function copy(key, parameters = {}) {
    return liveCopy(() => i18n.t('admin.' + key, typeof parameters === 'function' ? parameters() : parameters));
  }
  function setCopy(node, value) {
    if (!node) return;
    if (value?.[COPY]) copyBindings.set(node, value); else copyBindings.delete(node);
    node.textContent = value?.[COPY] ? String(value) : text(value, '');
    if (!pruneQueued) {
      pruneQueued = true;
      queueMicrotask(() => {
        pruneQueued = false;
        for (const node of copyBindings.keys()) if (!node.isConnected) copyBindings.delete(node);
      });
    }
  }
  function refreshInterfaceCopy() {
    // Text-only updates: never reset forms, checklists, focus, dialog state or
    // pending mutation identities when a language preference changes.
    for (const [node, message] of copyBindings) {
      if (node.isConnected) node.textContent = String(message);
      else copyBindings.delete(node);
    }
  }
  function errorPresentation(error) {
    return error?.presentation || liveCopy(() => i18n.apiError(error?.code, i18n.t('admin.requestFailed')));
  }


  const REAUTH_DRAFT_KEY = 'yourgame.admin.reauth-draft.v1';
  const AUTH_PULSE_KEY = 'yourgame.auth-pulse.v1';
  const SECTIONS = {
    overview: [copy('sectionOverviewEyebrow'), copy('sectionOverviewTitle'), copy('sectionOverviewDescription')],
    users: [copy('sectionUsersEyebrow'), copy('sectionUsersTitle'), copy('sectionUsersDescription')],
    proposals: [copy('sectionProposalsEyebrow'), copy('sectionProposalsTitle'), copy('sectionProposalsDescription')],
    versions: [copy('sectionVersionsEyebrow'), copy('sectionVersionsTitle'), copy('sectionVersionsDescription')],
    service: [copy('sectionServiceEyebrow'), copy('sectionServiceTitle'), copy('sectionServiceDescription')],
    audit: [copy('sectionAuditEyebrow'), copy('sectionAuditTitle'), copy('sectionAuditDescription')],
  };
  const LIST_SECTIONS = ['users', 'proposals', 'versions', 'audit'];
  const MODE_LABELS = { active: copy('modeActive'), maintenance: copy('modeMaintenance'), ended: copy('modeEnded') };
  const USER_LABELS = { active: copy('modeActive'), suspended: copy('userSuspended') };
  const MODERATION_LABELS = { pending: copy('moderationPending'), reviewed: copy('moderationReviewed'), excluded: copy('countExcluded') };
  const SAFETY_LABELS = { pending: copy('safetyPending'), approved: copy('safetyApproved'), held: copy('safetyHeld'), blocked: copy('safetyBlocked') };
  const SAFETY_CHECK_IDS = ['safety-check-content', 'safety-check-instructions', 'safety-check-brief'];
  const encoder = new TextEncoder();
  const VERSION_LABELS = { queued: copy('versionQueued'), running: copy('versionRunning'), failed: copy('versionFailed'), completed: copy('versionCompleted'), cancelled: copy('versionCancelled') };
  const ACTION_LABELS = {
    set_user_status: copy('actionUserStatus'), moderate_proposal: copy('actionModeration'),
    create_version: copy('actionCreateRequest'), retry_version: copy('actionRetryRequest'),
    cancel_version: copy('actionCancelRequest'), set_service: copy('actionService'), review_proposal_safety: copy('actionSafety'),
  };
  const state = {
    authorized: false, sessionReady: false, epoch: 0, sessionSequence: 0, csrfToken: null, user: null, admin: null,
    section: 'overview', overview: null, service: null, serviceReady: false, serviceDirty: false,
    busy: false, attempt: null, dialogAction: null, dialogConflict: false, returnFocus: null,
    reasons: new Map(), safetyDrafts: new Map(), heartbeat: null, overviewSequence: 0,
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
    'safety-review-fields', 'safety-review-body', 'safety-review-binding', 'safety-hard-block',
    'safety-decision', 'safety-approval-fields', 'safety-development-brief', 'safety-brief-bytes', ...SAFETY_CHECK_IDS,
  ].map((id) => [id, $(id)]));

  class LocalizedError extends Error {
    constructor(message) { super(String(message)); this.presentation = message; }
  }
  class ApiError extends LocalizedError {
    constructor(message, status = 0, code = '') { super(message); this.status = status; this.code = code; }
  }
  class StaleResponse extends Error {}
  const text = (value, fallback = '—') => value === null || value === undefined || value === '' ? fallback : String(value);
  const revisionValid = (value) => Number.isInteger(value) && value > 0;
  const codePoints = (value) => [...value].length;
  const element = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) setCopy(node, value);
    return node;
  };

  function notice(message, kind = 'success', { retry = false, reauth = false } = {}) {
    if (!state.authorized) return;
    ui['admin-notice'].hidden = !message;
    ui['admin-notice'].dataset.kind = kind;
    setCopy(ui['admin-notice-message'], message);
    ui['retry-mutation'].hidden = !(retry || state.attempt?.unknown === true);
    ui['reauth-link'].hidden = !reauth;
    ui['action-reauth-link'].hidden = !reauth || !ui['action-dialog'].open;
  }

  function fieldFeedback(id, message) {
    const node = ui[id];
    if (!node?.isConnected) return;
    setCopy(node, message);
    node.hidden = !message;
  }

  function clearReauthDraft() { try { sessionStorage.removeItem(REAUTH_DRAFT_KEY); } catch { /* No credentials are stored. */ } }

  function denyAccess(message = copy('accessDenied'), title = copy('checkAccessTitle')) {
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
    state.safetyDrafts.clear();
    setCopy(ui['safety-review-body'], '');
    setCopy(ui['safety-review-binding'], '');
    for (const list of Object.values(state.lists)) { list.items = []; list.ready = false; list.sequence += 1; }
    clearInterval(state.heartbeat);
    clearReauthDraft();
    if (ui['action-dialog'].open) ui['action-dialog'].close();
    for (const input of ui['admin-shell'].querySelectorAll('input, textarea')) input.value = '';
    ui['admin-shell'].replaceChildren();
    ui['admin-shell'].hidden = true;
    ui['admin-gate'].hidden = false;
    setCopy(ui['gate-title'], title);
    setCopy(ui['gate-message'], message);
    ui['gate-login'].hidden = false;
    ui['gate-retry'].hidden = false;
  }

  async function api(path, { method = 'GET', payload } = {}) {
    const epoch = state.epoch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 18000);
    try {
      const headers = { Accept: 'application/json', 'X-Yourgame-Language': i18n.locale };
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
        if (response.status === 401 || response.status === 403) denyAccess(copy('accessDeniedClear'));
        throw new ApiError(copy('invalidResponse'), response.status >= 400 ? response.status : 0);
      }
      if (epoch !== state.epoch) throw new StaleResponse();
      if (!response.ok) {
        const code = typeof data?.error?.code === 'string' ? data.error.code : '';
        const message = liveCopy(() => i18n.apiError(code,
          i18n.t(response.status >= 500 ? 'admin.serverFailurePreserved' : 'admin.requestFailed')));
        if ((response.status === 401 || response.status === 403) && code !== 'ADMIN_REAUTH_REQUIRED') {
          denyAccess(response.status === 401
            ? copy('sessionExpiredClear')
            : copy('adminDeniedClear'));
        }
        throw new ApiError(message, response.status, code);
      }
      return data;
    } catch (error) {
      if (epoch !== state.epoch || error instanceof StaleResponse) throw new StaleResponse();
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.name === 'AbortError'
        ? copy('timeoutUnknown') : copy('connectionCheck'));
    } finally { clearTimeout(timer); }
  }

  async function verifySession() {
    const sequence = ++state.sessionSequence;
    const data = await api('/api/session');
    if (sequence !== state.sessionSequence) return false;
    if (!data?.user || data.user.isAdmin !== true || !data.csrfToken) {
      denyAccess(data?.user ? copy('ordinaryAccount') : copy('adminLoginRequired'));
      return false;
    }
    if (state.user && state.user.id !== data.user.id) {
      denyAccess(copy('accountChanged'));
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
    return new Intl.DateTimeFormat(i18n.intlLocale, {
      timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23',
    }).format(date);
  }

  function timeCell(value) {
    const cell = element('td');
    const time = element('time', '', liveCopy(() => formatDate(value)));
    if (value) time.dateTime = String(value);
    cell.append(time);
    return cell;
  }

  function badge(value, labels, tone = '') {
    const node = element('span', 'badge', labels[value] || copy('unknownStatus'));
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
    const modeLabel = MODE_LABELS[service.mode] || copy('unknownStatus');
    setCopy(ui['current-service-badge'], modeLabel);
    ui['current-service-badge'].dataset.tone = modeTone(service.mode);
    setCopy(ui['overview-mode'], modeLabel);
    setCopy(ui['overview-permissions'], copy('servicePermissions', { proposals: copy(service.proposalsEnabled ? 'permissionAllowed' : 'permissionPaused'), development: copy(service.developmentEnabled ? 'permissionAllowed' : 'permissionPaused'), note: service.mode === 'active' ? '' : copy('serviceInactiveNote') }));
    setCopy(ui['service-current-mode'], modeLabel);
    setCopy(ui['service-revision'], copy('serviceRevision', () => ({ revision: service.revision, date: formatDate(service.updatedAt) })));
    if (replaceDraft || !state.serviceDirty) setServiceDraft(service);
    const ended = service.mode === 'ended';
    setCopy(ui['danger-title'], ended ? copy('resumeEndedService') : copy('endService'));
    setCopy(ui['danger-description'], ended
      ? copy('resumeServiceDescription')
      : copy('endServiceDescription'));
    setCopy(ui['danger-service-button'], ended ? copy('resumeServiceButton') : copy('endServiceButton'));
    setCopy(ui['service-submit'], ended ? copy('reviewResumeSettings') : copy('saveService'));
    const until = state.admin?.recentAuthUntil;
    setCopy(ui['recent-auth-note'], until
      ? copy('recentAuthUntil', () => ({ date: formatDate(until) }))
      : copy('sensitiveAuthNote'));
  }

  async function loadOverview({ replaceDraft = false, initial = false } = {}) {
    const sequence = ++state.overviewSequence;
    try {
      const data = await api('/api/admin?section=overview');
      if (sequence !== state.overviewSequence) return;
      if (!data?.admin?.id || data.admin.id !== state.user?.id) {
        denyAccess(copy('adminMismatch'));
        return;
      }
      if (!data.service || !MODE_LABELS[data.service.mode] || !revisionValid(data.service.revision)) {
        throw new ApiError(copy('serviceStateUnavailable'));
      }
      if (initial) state.authorized = true;
      if (!state.authorized) return;
      state.admin = data.admin;
      state.overview = data;
      state.service = data.service;
      state.serviceReady = true;
      setCopy(ui['admin-name'], text(data.admin.name, copy('administrator')));
      setCopy(ui['admin-email'], text(data.admin.email, ''));
      const counts = data.counts || {};
      for (const [key, id] of Object.entries({ users: 'count-users', suspendedUsers: 'count-suspended-users',
        proposals: 'count-proposals', excludedProposals: 'count-excluded-proposals', versions: 'count-versions', pendingVersions: 'count-pending-versions' })) {
        setCopy($(id), liveCopy(() => Number.isSafeInteger(counts[key]) && counts[key] >= 0 ? counts[key].toLocaleString(i18n.intlLocale) : '—'));
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
      if (!initial && state.authorized) notice(errorPresentation(error), 'error');
      throw error;
    }
  }

  function markUpdated() {
    const at = Date.now();
    setCopy(ui['last-refreshed'], copy('lastRefreshed', () => ({ date: formatDate(at, true) })));
  }

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
    cell.append(element('p', 'cell-name', text(user.name, copy('unnamed'))),
      element('small', 'cell-secondary', user.email), element('small', 'cell-id', user.id));
    return cell;
  }

  function renderUsers(items) {
    if (!items.length) { emptyRows('users-rows', copy('noMembers'), copy('noMembersHelp')); return; }
    const fragment = document.createDocumentFragment();
    for (const user of items) {
      const row = element('tr');
      const status = element('td');
      status.append(badge(user.status, USER_LABELS, user.status === 'suspended' ? 'warning' : ''));
      if (user.isAdmin || user.id === state.admin.id) status.append(element('small', '', copy('adminCannotSuspend')));
      const count = element('td', '', liveCopy(() => Number.isSafeInteger(user.proposalCount) ? user.proposalCount.toLocaleString(i18n.intlLocale) : '—'));
      const actions = element('td');
      const group = element('div', 'cell-actions');
      const view = element('button', 'text-button', copy('viewProposals'));
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
        group.append(recordButton(nextStatus === 'suspended' ? copy('suspendMemberButton') : copy('unsuspendMemberButton'),
          () => openRecordAction('set_user_status', user, { status: nextStatus }),
          { section: 'users', danger: nextStatus === 'suspended', disabled: !revisionValid(user.revision) }));
      }
      actions.append(group);
      row.append(userCell(user), status, count, timeCell(user.createdAt), actions);
      fragment.append(row);
    }
    $('users-rows').replaceChildren(fragment);
  }

  function safetyBindingValid(proposal) {
    const safety = proposal?.safety;
    return Boolean(safety && Object.hasOwn(SAFETY_LABELS, safety.status) && revisionValid(safety.revision)
      && revisionValid(proposal.revision) && safety.proposalRevision === proposal.revision
      && typeof safety.bodyHash === 'string' && /^[a-f0-9]{64}$/.test(safety.bodyHash)
      && typeof safety.policyVersion === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(safety.policyVersion)
      && typeof safety.hardBlocked === 'boolean');
  }

  function safetySourceKey(value) { return `${value.proposalRevision}:${value.bodyHash}:${value.policyVersion}`; }

  function saveSafetyDraft() {
    const config = state.dialogAction;
    if (config?.action !== 'review_proposal_safety') return;
    state.safetyDrafts.set(config.proposalId, { brief: ui['safety-development-brief'].value, source: safetySourceKey(config) });
  }

  function resetSafetyChecks() { for (const id of SAFETY_CHECK_IDS) ui[id].checked = false; }

  function renderProposals(items) {
    if (!items.length) { emptyRows('proposals-rows', copy('noProposals'), copy('noProposalsHelp')); return; }
    const fragment = document.createDocumentFragment();
    for (const proposal of items) {
      const row = element('tr');
      const bodyCell = element('td');
      const details = element('details', 'proposal-original');
      const summary = element('summary');
      const body = typeof proposal.body === 'string' ? proposal.body : '';
      const preview = [...body].slice(0, 110).join('');
      summary.append(document.createTextNode(preview + (codePoints(body) > 110 ? '…' : '')), element('small', '', copy('viewOriginal')));
      details.append(summary, element('pre', '', body));
      bodyCell.append(details, element('small', 'cell-id', proposal.id));
      const author = userCell(proposal.user || {});
      author.append(element('small', '', copy('roundValue', { round: text(proposal.roundId) })));
      const moderation = element('td');
      moderation.append(badge(proposal.moderation, MODERATION_LABELS, proposal.moderation === 'excluded' ? 'warning' : ''));
      if (proposal.moderationReason) moderation.append(element('p', 'proposal-reason', proposal.moderationReason));
      const safetyCell = element('div', 'safety-cell');
      safetyCell.append(element('span', 'field-caption', copy('independentSafety')));
      const safety = proposal.safety;
      if (safety && Object.hasOwn(SAFETY_LABELS, safety.status)) {
        safetyCell.append(badge(safety.status, SAFETY_LABELS, safety.status === 'approved' ? 'positive' : ['held', 'blocked'].includes(safety.status) ? 'warning' : ''),
          element('small', '', copy('safetyRevisions', { bodyRevision: text(safety.proposalRevision), reviewRevision: text(safety.revision), policy: text(safety.policyVersion) })));
        if (safety.reason) safetyCell.append(element('p', 'proposal-reason', safety.reason));
        if (safety.reviewedAt) safetyCell.append(element('small', '', copy('lastSafetyReview', () => ({ date: formatDate(safety.reviewedAt) }))));
        if (safety.hardBlocked) safetyCell.append(element('p', 'proposal-reason', copy('hardBlocked')));
      } else safetyCell.append(element('small', '', copy('safetyUnavailable')));
      moderation.append(safetyCell);
      const actions = element('td');
      const group = element('div', 'cell-actions');
      const allowed = revisionValid(proposal.moderationRevision);
      group.append(recordButton(copy('reviewSafety'), () => openRecordAction('review_proposal_safety', proposal),
        { section: 'proposals', disabled: !safetyBindingValid(proposal) }));
      if (proposal.moderation === 'excluded') {
        group.append(recordButton(copy('restoreDevelopment'), () => openRecordAction('moderate_proposal', proposal, { moderation: 'pending' }), { section: 'proposals', disabled: !allowed }));
      } else if (MODERATION_LABELS[proposal.moderation]) {
        const next = proposal.moderation === 'reviewed' ? 'pending' : 'reviewed';
        group.append(recordButton(next === 'reviewed' ? copy('moderationReviewed') : copy('returnPending'),
          () => openRecordAction('moderate_proposal', proposal, { moderation: next }), { section: 'proposals', disabled: !allowed }),
        recordButton(copy('excludeDevelopmentButton'), () => openRecordAction('moderate_proposal', proposal, { moderation: 'excluded' }), { section: 'proposals', danger: true, disabled: !allowed }));
      }
      actions.append(group);
      row.append(bodyCell, author, moderation, timeCell(proposal.createdAt), actions);
      fragment.append(row);
    }
    $('proposals-rows').replaceChildren(fragment);
  }

  function renderVersions(items) {
    if (!items.length) { emptyRows('versions-rows', copy('noRequests'), copy('noRequestsHelp')); return; }
    const fragment = document.createDocumentFragment();
    for (const version of items) {
      const row = element('tr');
      const label = element('td');
      label.append(element('p', 'cell-name', version.label), element('p', 'version-summary', version.summary), element('small', 'cell-id', version.id));
      const status = element('td');
      status.append(badge(version.status, VERSION_LABELS, version.status === 'failed' ? 'warning' : ''));
      if (version.cancelRequested) status.append(element('small', '', copy('stopAtCheckpoint')));
      if (version.status === 'completed') status.append(element('small', '', copy('separateFromPublication')));
      const references = element('td');
      references.append(element('small', 'cell-id', copy('parentRequest', { id: text(version.parentId) })),
        element('small', 'cell-id', version.commitSha ? copy('commitValue', { commit: String(version.commitSha).slice(0, 12) }) : copy('noCommit')));
      const actions = element('td');
      const group = element('div', 'cell-actions');
      if (version.status === 'queued' || version.status === 'running') {
        group.append(recordButton(version.status === 'queued' ? copy('cancelRequest') : copy('stopRequest'),
          () => openRecordAction('cancel_version', version),
          { section: 'versions', danger: true, disabled: !revisionValid(version.revision) || version.cancelRequested === true }));
      } else if (version.status === 'failed' || version.status === 'cancelled') {
        group.append(recordButton(copy('retryRequest'), () => openRecordAction('retry_version', version), { section: 'versions', disabled: !revisionValid(version.revision) }));
      }
      actions.append(group);
      row.append(label, status, timeCell(version.updatedAt || version.createdAt), references, actions);
      fragment.append(row);
    }
    $('versions-rows').replaceChildren(fragment);
  }

  function renderAudit(bodyId, items) {
    if (!items.length) { emptyRows(bodyId, copy('noAudit'), copy('noAuditHelp')); return; }
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
    setCopy($(`${section}-page-info`), copy('pagination', () => ({ page: list.page.toLocaleString(i18n.intlLocale), count: list.items.length.toLocaleString(i18n.intlLocale) })));
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
      if (!Array.isArray(data?.items)) throw new ApiError(copy('invalidListResponse'));
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
      notice(errorPresentation(error), 'error');
      throw error;
    } finally {
      if (state.authorized && sequence === list.sequence) { list.loading = false; renderPagination(section); updateControls(); }
    }
  }

  async function openSection(section, { fetch = true } = {}) {
    if (!state.authorized || !SECTIONS[section]) return;
    state.section = section;
    const [eyebrow, title, description] = SECTIONS[section];
    setCopy(ui['section-eyebrow'], eyebrow);
    setCopy(ui['section-title'], title);
    setCopy(ui['section-description'], description);
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
        title: change.status === 'suspended' ? copy('suspendTitle') : copy('unsuspendTitle'),
        target: liveCopy(() => `${text(record.name, copy('memberLabel'))} · ${text(record.email)}`),
        description: change.status === 'suspended'
          ? copy('suspendDescription')
          : copy('unsuspendDescription'),
      };
    } else if (action === 'review_proposal_safety') {
      if (!safetyBindingValid(record)) return;
      config = {
        action, proposalId: record.id, proposalRevision: record.safety.proposalRevision,
        bodyHash: record.safety.bodyHash, policyVersion: record.safety.policyVersion, revision: record.safety.revision,
        body: typeof record.body === 'string' ? record.body : '', hardBlocked: record.safety.hardBlocked === true,
        developmentBrief: typeof record.safety.developmentBrief === 'string' ? record.safety.developmentBrief : '',
        section: 'proposals', title: copy('actionSafety'), target: copy('proposalTarget', { id: record.id }),
        description: copy('reviewSafetyDescription'),
      };
    } else if (action === 'moderate_proposal') {
      if (!revisionValid(record.moderationRevision)) return;
      config = {
        action, proposalId: record.id, moderation: change.moderation, revision: record.moderationRevision, section: 'proposals',
        title: change.moderation === 'excluded' ? copy('excludeTitle') : change.moderation === 'reviewed' ? copy('markReviewedTitle') : record.moderation === 'excluded' ? copy('restoreDevelopmentTitle') : copy('markPendingTitle'),
        target: copy('proposalTarget', { id: record.id }),
        description: copy('moderationDescription'),
      };
    } else {
      if (!revisionValid(record.revision)) return;
      config = {
        action, versionId: record.id, revision: record.revision, section: 'versions', target: text(record.label),
        title: action === 'retry_version' ? copy('retryDevelopmentTitle') : record.status === 'running' ? copy('stopDevelopmentTitle') : copy('cancelDevelopmentTitle'),
        description: action === 'retry_version'
          ? copy('retryDevelopmentDescription')
          : record.status === 'running' ? copy('stopDevelopmentDescription')
            : copy('cancelDevelopmentDescription'),
      };
    }
    showDialog(config);
  }

  function showDialog(config, reason = '') {
    if (!state.authorized || state.busy || state.attempt?.unknown) return;
    state.dialogAction = config;
    state.dialogConflict = false;
    state.returnFocus = document.activeElement;
    setCopy(ui['action-title'], config.title);
    setCopy(ui['action-target'], config.target || '');
    setCopy(ui['action-description'], config.description);
    ui['action-reason'].value = reason || state.reasons.get(dialogKey(config)) || '';
    ui['action-confirmation'].value = '';
    ui['action-reauth-link'].hidden = true;
    ui['confirmation-field'].hidden = !config.confirmation;
    setCopy(ui['confirmation-phrase'], config.confirmation || '');
    ui['action-submit'].classList.toggle('danger', Boolean(config.confirmation));
    ui['action-submit'].classList.toggle('primary', !config.confirmation);
    fieldFeedback('action-feedback', '');
    const isSafety = config.action === 'review_proposal_safety';
    ui['safety-review-fields'].hidden = !isSafety;
    setCopy(ui['safety-review-body'], isSafety ? config.body : '');
    setCopy(ui['safety-review-binding'], isSafety
      ? copy('safetyBinding', { bodyRevision: config.proposalRevision, bodyHash: config.bodyHash, policy: config.policyVersion, reviewRevision: config.revision }) : '');
    ui['safety-decision'].value = '';
    ui['safety-decision'].querySelector('[value="approved"]').disabled = isSafety && config.hardBlocked;
    ui['safety-hard-block'].hidden = !isSafety || !config.hardBlocked;
    resetSafetyChecks();
    const savedSafety = isSafety ? state.safetyDrafts.get(config.proposalId) : null;
    ui['safety-development-brief'].value = savedSafety?.brief ?? (isSafety ? config.developmentBrief : '');
    if (savedSafety && savedSafety.source !== safetySourceKey(config)) {
      fieldFeedback('action-feedback', copy('oldBriefPreserved'));
    }
    if (!ui['action-dialog'].open) ui['action-dialog'].showModal();
    updateControls();
    if (isSafety) {
      ui['safety-decision'].focus({ preventScroll: true });
      ui['action-dialog'].scrollTop = 0;
    } else ui['action-reason'].focus();
  }

  function closeDialog() {
    if (state.busy || !ui['action-dialog'].isConnected) return;
    if (state.dialogAction) state.reasons.set(dialogKey(state.dialogAction), ui['action-reason'].value);
    saveSafetyDraft();
    ui['action-dialog'].close();
  }

  function validateText(value, label, limit, required = true) {
    const trimmed = String(value).trim();
    if (required && !trimmed) throw new LocalizedError(copy('requiredField', { label }));
    if (codePoints(trimmed) > limit) throw new LocalizedError(copy('fieldLimit', () => ({ label, limit: limit.toLocaleString(i18n.intlLocale) })));
    return trimmed;
  }

  function servicePayload({ ending = false } = {}) {
    if (!state.serviceReady || !revisionValid(state.service?.revision)) throw new LocalizedError(copy('refreshServiceFirst'));
    const draft = serviceDraft();
    return {
      action: 'set_service', mode: ending ? 'ended' : draft.mode,
      proposalsEnabled: ending ? false : draft.proposalsEnabled,
      developmentEnabled: ending ? false : draft.developmentEnabled,
      message: validateText(draft.message, copy('serviceNotice'), 1000, false), revision: state.service.revision,
    };
  }

  function openServiceConfirmation(ending = false) {
    try {
      if (!ending && ui['service-mode-input'].value === 'ended') {
        ui['service-mode-input'].value = 'active';
        state.serviceDirty = true;
      }
      const payload = servicePayload({ ending });
      const confirmation = ending ? 'END SERVICE' : 'RESUME SERVICE';
      showDialog({
        ...payload, confirmation, section: 'service', title: ending ? copy('endService') : copy('resumeService'),
        target: copy('serviceTransition', { from: MODE_LABELS[state.service.mode], to: MODE_LABELS[payload.mode], revision: payload.revision }),
        description: ending
          ? copy('endConfirmationDescription')
          : copy('resumeConfirmationDescription', { mode: MODE_LABELS[payload.mode], proposals: copy(payload.proposalsEnabled ? 'permissionAllowed' : 'permissionPaused'), development: copy(payload.developmentEnabled ? 'permissionAllowed' : 'permissionPaused') }),
      }, ui['service-reason'].value);
    } catch (error) { fieldFeedback('service-feedback', errorPresentation(error)); }
  }

  function payloadForDialog() {
    const config = state.dialogAction;
    if (!config || state.dialogConflict) throw new LocalizedError(copy('reopenLatestAction'));
    const reason = validateText(ui['action-reason'].value, copy('changeReason'), 500);
    const payload = { action: config.action, reason };
    for (const key of ['userId', 'status', 'proposalId', 'moderation', 'versionId', 'revision', 'mode', 'proposalsEnabled', 'developmentEnabled', 'message', 'proposalRevision', 'bodyHash', 'policyVersion']) {
      if (Object.hasOwn(config, key)) payload[key] = config[key];
    }
    if (config.action === 'review_proposal_safety') {
      const status = ui['safety-decision'].value;
      if (!Object.hasOwn(SAFETY_LABELS, status)) throw new LocalizedError(copy('selectSafetyDecision'));
      const approved = status === 'approved';
      if (approved && config.hardBlocked) throw new LocalizedError(copy('hardBlocked'));
      const brief = approved ? ui['safety-development-brief'].value.trim() : '';
      const confirmed = approved && SAFETY_CHECK_IDS.every((id) => ui[id].checked);
      if (approved && (!brief || encoder.encode(brief).length > 2000 || !confirmed)) {
        throw new LocalizedError(copy('approvalRequirements'));
      }
      Object.assign(payload, { status, checklistConfirmed: confirmed, developmentBrief: brief });
      saveSafetyDraft();
    }
    if (config.confirmation) {
      if (ui['action-confirmation'].value !== config.confirmation) throw new LocalizedError(copy('exactConfirmation', { phrase: config.confirmation }));
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
    const isSafety = config?.action === 'review_proposal_safety';
    const safetyDecision = ui['safety-decision'].value;
    const approving = isSafety && safetyDecision === 'approved';
    const briefBytes = encoder.encode(ui['safety-development-brief'].value.trim()).length;
    ui['safety-approval-fields'].hidden = !approving;
    setCopy(ui['safety-brief-bytes'], copy('briefBytes', () => ({ count: briefBytes.toLocaleString(i18n.intlLocale) })));
    ui['safety-brief-bytes'].dataset.invalid = String(briefBytes > 2000);
    const validSafety = !isSafety || (Object.hasOwn(SAFETY_LABELS, safetyDecision)
      && (!approving || (!config.hardBlocked && briefBytes > 0 && briefBytes <= 2000 && SAFETY_CHECK_IDS.every((id) => ui[id].checked))));
    const dialogRetry = state.attempt?.unknown === true && state.attempt.channel === 'dialog';
    ui['action-submit'].hidden = dialogRetry;
    ui['action-retry'].hidden = !dialogRetry;
    ui['action-retry'].disabled = state.busy || !state.sessionReady;
    ui['action-submit'].disabled = state.busy || !state.sessionReady || state.dialogConflict || !config || !validReason || !validConfirmation || !validSafety || state.attempt?.unknown === true;
    setCopy(ui['action-submit'], state.busy && state.attempt?.channel === 'dialog' ? copy('processing') : isSafety ? copy('saveSafetyReview') : copy('confirmAction'));
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
    if (action === 'moderate_proposal' || action === 'review_proposal_safety') return 'proposals';
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
      if (payload.action === 'review_proposal_safety') {
        saveSafetyDraft();
        resetSafetyChecks();
        state.dialogConflict = true;
        fieldFeedback('action-feedback', copy('safetyConflictPreserved'));
        updateControls();
        return results.every((result) => result.status === 'fulfilled');
      }
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
        fieldFeedback('action-feedback', copy('latestStateRecheck'));
      } else {
        state.dialogConflict = true;
        fieldFeedback('action-feedback', copy('latestTargetUnavailable'));
      }
    }
    updateControls();
    return results.every((result) => result.status === 'fulfilled');
  }

  async function performMutation(channel, payload, { retry = false } = {}) {
    if (!state.authorized || !state.sessionReady || state.busy) return;
    if (state.attempt?.unknown && !retry) {
      notice(copy('unresolvedRequest'), 'error', { retry: true });
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
      if (result?.ok !== true) throw new ApiError(copy('mutationReceiptUnavailable'));
      state.attempt = null;
      if (attempt.channel === 'dialog') {
        if (state.dialogAction) state.reasons.delete(dialogKey(state.dialogAction));
        if (attempt.payload.action === 'review_proposal_safety') state.safetyDrafts.delete(attempt.payload.proposalId);
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
      const successMessage = attempt.payload.action === 'review_proposal_safety'
        ? copy('safetySaved')
        : attempt.payload.action === 'create_version' || attempt.payload.action === 'retry_version'
        ? copy('requestSaved')
        : attempt.payload.action === 'cancel_version' ? copy('stopSaved')
          : copy('changeSaved');
      notice(successMessage);
      const refreshed = await refreshAfterMutation(attempt.payload);
      if (state.authorized && !refreshed) notice(copy('savedRefreshFailed', { message: successMessage }), 'error');
    } catch (error) {
      if (error instanceof StaleResponse || !state.authorized) return;
      if (error.code === 'ADMIN_REAUTH_REQUIRED') {
        state.attempt = null;
        ui['action-confirmation'].value = '';
        resetSafetyChecks();
        fieldFeedback(feedbackId, copy('reauthRequiredPreserved'));
        notice(copy('reauthNotice'), 'error', { reauth: true });
        saveReauthDraft();
      } else if (error.status === 409) {
        state.attempt = null;
        state.dialogConflict = attempt.channel === 'dialog';
        fieldFeedback(feedbackId, copy('conflictPreserved'));
        notice(copy('conflictNotice'), 'error');
        await refreshAfterMutation(attempt.payload, { conflict: true });
      } else if (error.status === 0 || error.status >= 500) {
        attempt.unknown = true;
        state.attempt = attempt;
        const message = copy('unknownMutation');
        fieldFeedback(feedbackId, message);
        notice(message, 'error', { retry: true });
      } else {
        state.attempt = null;
        fieldFeedback(feedbackId, errorPresentation(error));
        notice(errorPresentation(error), 'error');
      }
    } finally {
      state.busy = false;
      updateControls();
    }
  }

  function saveReauthDraft() {
    if (!state.authorized || !state.admin) return;
    if (state.dialogAction) state.reasons.set(dialogKey(state.dialogAction), ui['action-reason'].value);
    saveSafetyDraft();
    try {
      sessionStorage.setItem(REAUTH_DRAFT_KEY, JSON.stringify({
        actorId: state.admin.id, createdAt: Date.now(), section: state.section,
        service: serviceDraft(), serviceDirty: state.serviceDirty,
        version: { label: ui['version-label'].value, summary: ui['version-summary'].value, reason: ui['version-reason'].value },
        reasons: [...state.reasons.entries()],
        safetyDrafts: [...state.safetyDrafts.entries()],
      }));
    } catch {
      notice(copy('reauthStorageUnavailable'), 'error', { reauth: true });
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
    if (Array.isArray(draft.safetyDrafts)) {
      for (const entry of draft.safetyDrafts.slice(0, 100)) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1]?.brief === 'string' && typeof entry[1]?.source === 'string') {
          state.safetyDrafts.set(entry[0], { brief: entry[1].brief, source: entry[1].source });
        }
      }
    }
    if (SECTIONS[draft.section]) state.section = draft.section;
    notice(copy('reauthDraftRestored'));
  }

  async function refreshCurrent() {
    if (!state.authorized || state.busy) return;
    ui['refresh-view'].disabled = true;
    try {
      if (!await verifySession()) return;
      if (state.lists[state.section]) await loadList(state.section);
      else await loadOverview();
      if (!state.attempt?.unknown && ui['reauth-link'].hidden) notice(copy('refreshedPreserved'));
    } catch (error) { if (!(error instanceof StaleResponse) && state.authorized) notice(errorPresentation(error), 'error'); }
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
        notice(copy('accessCheckUnavailable'), 'error');
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
      if (payload.mode === 'ended') throw new LocalizedError(copy('useSensitiveSection'));
      payload.reason = validateText(ui['service-reason'].value, copy('changeReason'), 500);
      performMutation('service', payload);
    } catch (error) { fieldFeedback('service-feedback', errorPresentation(error)); }
  });
  ui['danger-service-button'].addEventListener('click', () => {
    if (!state.busy && !state.attempt?.unknown && state.serviceReady) openServiceConfirmation(state.service.mode !== 'ended');
  });
  ui['version-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy || state.attempt?.unknown) return;
    try {
      const payload = {
        action: 'create_version', label: validateText(ui['version-label'].value, copy('requestName'), 80),
        summary: validateText(ui['version-summary'].value, copy('developmentSummary'), 2000),
        reason: validateText(ui['version-reason'].value, copy('registrationReason'), 500),
      };
      performMutation('version', payload);
    } catch (error) { fieldFeedback('version-feedback', errorPresentation(error)); }
  });
  ui['action-form'].addEventListener('submit', (event) => {
    event.preventDefault();
    if (state.busy || state.attempt?.unknown) return;
    try { performMutation('dialog', payloadForDialog()); }
    catch (error) { fieldFeedback('action-feedback', errorPresentation(error)); }
  });
  ui['action-reason'].addEventListener('input', () => {
    if (state.dialogAction) state.reasons.set(dialogKey(state.dialogAction), ui['action-reason'].value);
    updateControls();
  });
  ui['action-confirmation'].addEventListener('input', updateControls);
  ui['safety-decision'].addEventListener('change', () => { resetSafetyChecks(); updateControls(); });
  ui['safety-development-brief'].addEventListener('input', () => { resetSafetyChecks(); saveSafetyDraft(); updateControls(); });
  for (const id of SAFETY_CHECK_IDS) ui[id].addEventListener('change', updateControls);
  ui['action-close'].addEventListener('click', closeDialog);
  ui['action-cancel'].addEventListener('click', closeDialog);
  ui['action-dialog'].addEventListener('cancel', (event) => {
    if (state.busy) event.preventDefault();
    else if (state.dialogAction) {
      state.reasons.set(dialogKey(state.dialogAction), ui['action-reason'].value);
      saveSafetyDraft();
    }
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
      denyAccess(copy('signedOutClear'), copy('signedOut'));
    } catch (error) {
      if (!(error instanceof StaleResponse)) denyAccess(copy('logoutUnknownClear'));
    } finally { state.busy = false; }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkCurrentAccess(); });
  window.addEventListener('storage', (event) => { if (event.key === AUTH_PULSE_KEY) checkCurrentAccess(); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) checkCurrentAccess(); });

  async function boot() {
    try {
      await i18n.init();
      i18n.apply(document);
      refreshInterfaceCopy();
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
      setCopy(ui['gate-title'], copy('loadAdminFailed'));
      setCopy(ui['gate-message'], errorPresentation(error));
      ui['gate-retry'].hidden = false;
      ui['gate-login'].hidden = false;
    }
  }
  i18n.bindLanguageControls();
  i18n.subscribe(refreshInterfaceCopy);
  boot();
})();
