import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// These browser fixtures never call a real management API. Server authorization has separate tests.
const html = readFileSync(new URL('../server/admin-page.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/admin.css', import.meta.url), 'utf8');
const NOW = '2026-08-31T05:00:00.000Z';
const ADMIN = { id: 'admin-fixture', name: '관리 테스트', email: 'operator@example.test', isAdmin: true };
const MEMBER = { id: 'member-fixture', name: '참여자 테스트', email: 'participant@example.test',
  status: 'active', isAdmin: false, proposalCount: 1, revision: 1, createdAt: NOW, updatedAt: NOW };
const SELF = { ...ADMIN, status: 'active', proposalCount: 0, revision: 1, createdAt: NOW, updatedAt: NOW };
const PROPOSAL = { id: 'proposal-fixture', user: MEMBER, body: '<img src=x onerror="window.__adminXss=true"> 원문\n줄바꿈을 보존합니다.',
  roundId: 'initial-fixture', createdAt: NOW, revision: 1, moderation: 'pending', moderationRevision: 1, moderationReason: '' };
function safetyFor(proposal, overrides = {}) {
  return { status: 'pending', revision: 1, proposalRevision: proposal.revision,
    bodyHash: createHash('sha256').update(proposal.body).digest('hex'), policyVersion: 'teen-v1',
    reason: '', developmentBrief: '', checklistConfirmed: false, reviewedAt: null, hardBlocked: false, ...overrides };
}
PROPOSAL.safety = safetyFor(PROPOSAL);

async function fixture(page, options = {}) {
  const state = {
    session: { user: { ...ADMIN }, csrfToken: 'admin-fixture-csrf', googleNonce: 'unused-fixture-nonce' },
    service: { mode: 'active', proposalsEnabled: true, developmentEnabled: true, message: '', revision: 1, updatedAt: NOW },
    users: [{ ...SELF }, { ...MEMBER }], proposals: [structuredClone(PROPOSAL)], versions: [], audit: [],
    reads: [], writes: [], receipts: new Map(), forbidden: false, recentAuthRequired: false,
    conflictOnce: false, loseNextReceipt: false, readFailure: false, safetyConflictOnce: false, ...options,
  };
  const reply = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });
  await page.route('http://localhost:3000/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/admin' || url.pathname === '/admin/') return route.fulfill({ contentType: 'text/html', headers: { 'Cache-Control': 'no-store' }, body: html });
    if (url.pathname === '/admin.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/admin.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (url.pathname === '/api/session') return reply(route, state.session);
    if (url.pathname === '/api/logout') {
      state.session = { user: null, csrfToken: 'anonymous-fixture', googleNonce: 'anonymous-fixture' };
      return reply(route, state.session);
    }
    if (url.pathname !== '/api/admin') return reply(route, { error: { code: 'FIXTURE_NOT_FOUND', message: 'No real API is available in this browser fixture.' } }, 404);
    if (state.forbidden) return reply(route, { error: { code: 'ADMIN_REQUIRED', message: '관리자 접근이 거부되었습니다.' } }, 403);
    if (!state.session.user?.isAdmin) return reply(route, { error: { code: 'ADMIN_REQUIRED', message: '관리자 권한이 필요합니다.' } }, 403);
    if (request.method() === 'GET') {
      const section = url.searchParams.get('section');
      state.reads.push(Object.fromEntries(url.searchParams));
      if (state.readFailure) return reply(route, { error: { code: 'READ_UNAVAILABLE', message: '관리 데이터 조회가 일시적으로 중단되었습니다.' } }, 503);
      if (section === 'overview') return reply(route, {
        admin: { id: ADMIN.id, name: ADMIN.name, email: ADMIN.email, recentAuthUntil: '2026-08-31T05:15:00.000Z' },
        service: state.service, counts: { users: state.users.length, suspendedUsers: state.users.filter((u) => u.status === 'suspended').length,
          proposals: state.proposals.length, excludedProposals: state.proposals.filter((p) => p.moderation === 'excluded').length,
          versions: state.versions.length, pendingVersions: state.versions.filter((v) => v.status === 'queued').length }, recentAudit: state.audit.slice(0, 5),
      });
      let items = state[section] || [];
      const q = (url.searchParams.get('q') || '').toLowerCase();
      if (q) items = items.filter((item) => JSON.stringify(item).toLowerCase().includes(q));
      const status = url.searchParams.get('status');
      if (status) items = items.filter((item) => (section === 'proposals' ? item.moderation : item.status) === status);
      const safetyStatus = url.searchParams.get('safetyStatus');
      if (safetyStatus) items = items.filter((item) => item.safety?.status === safetyStatus);
      const round = url.searchParams.get('round');
      if (round) items = items.filter((item) => item.roundId === round);
      const userId = url.searchParams.get('userId');
      if (userId) items = items.filter((item) => item.user?.id === userId);
      const offset = Number((url.searchParams.get('cursor') || 'offset-0').replace('offset-', ''));
      const limit = Math.min(50, Number(url.searchParams.get('limit') || 25));
      return reply(route, { items: items.slice(offset, offset + limit), nextCursor: items.length > offset + limit ? `offset-${offset + limit}` : null });
    }
    const payload = request.postDataJSON();
    state.writes.push(structuredClone(payload));
    expect(request.headers()['x-csrf-token']).toBe(state.session.csrfToken);
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.reason.trim()).not.toBe('');
    const receipt = state.receipts.get(payload.requestId);
    if (receipt) {
      expect(payload).toEqual(receipt.payload);
      return reply(route, receipt.result);
    }
    if (state.recentAuthRequired && payload.action === 'set_service') return reply(route, { error: { code: 'ADMIN_REAUTH_REQUIRED', message: '최근 Google 로그인이 필요합니다.' } }, 403);
    if (state.safetyConflictOnce && payload.action === 'review_proposal_safety') {
      state.safetyConflictOnce = false;
      const proposal = state.proposals.find((item) => item.id === payload.proposalId);
      proposal.revision += 1;
      proposal.body = '다른 창에서 바뀐 최신 제안 원문';
      proposal.safety = safetyFor(proposal);
      return reply(route, { error: { code: 'SAFETY_REVIEW_CONFLICT', message: '심사하던 제안 본문이 바뀌었습니다.' } }, 409);
    }
    if (state.conflictOnce) {
      state.conflictOnce = false;
      if (payload.action === 'set_service') state.service.revision += 1;
      else if (payload.action === 'set_user_status') state.users.find((user) => user.id === payload.userId).revision += 1;
      return reply(route, { error: { code: 'REVISION_CONFLICT', message: '다른 변경이 먼저 반영되었습니다.' } }, 409);
    }
    let targetId = 'service';
    if (payload.action === 'set_service') {
      expect(payload.revision).toBe(state.service.revision);
      if (payload.mode === 'ended' && state.service.mode !== 'ended') expect(payload.confirmation).toBe('서비스 종료');
      if (payload.mode !== 'ended' && state.service.mode === 'ended') expect(payload.confirmation).toBe('서비스 재개');
      state.service = { mode: payload.mode, proposalsEnabled: payload.mode === 'ended' ? false : payload.proposalsEnabled,
        developmentEnabled: payload.mode === 'ended' ? false : payload.developmentEnabled, message: payload.message,
        revision: state.service.revision + 1, updatedAt: NOW };
    } else if (payload.action === 'set_user_status') {
      const member = state.users.find((user) => user.id === payload.userId);
      expect(member.id).not.toBe(ADMIN.id);
      expect(payload.revision).toBe(member.revision);
      Object.assign(member, { status: payload.status, revision: member.revision + 1 });
      targetId = member.id;
    } else if (payload.action === 'moderate_proposal') {
      const proposal = state.proposals.find((item) => item.id === payload.proposalId);
      expect(payload.revision).toBe(proposal.moderationRevision);
      Object.assign(proposal, { moderation: payload.moderation, moderationReason: payload.reason, moderationRevision: proposal.moderationRevision + 1 });
      targetId = proposal.id;
    } else if (payload.action === 'review_proposal_safety') {
      const proposal = state.proposals.find((item) => item.id === payload.proposalId);
      expect(payload.proposalRevision).toBe(proposal.revision);
      expect(payload.bodyHash).toBe(proposal.safety.bodyHash);
      expect(payload.policyVersion).toBe(proposal.safety.policyVersion);
      expect(payload.revision).toBe(proposal.safety.revision);
      if (payload.status === 'approved') {
        expect(proposal.safety.hardBlocked).toBe(false);
        expect(payload.checklistConfirmed).toBe(true);
        expect(payload.developmentBrief.trim()).not.toBe('');
        expect(Buffer.byteLength(payload.developmentBrief, 'utf8')).toBeLessThanOrEqual(2000);
      }
      Object.assign(proposal.safety, { status: payload.status, revision: proposal.safety.revision + 1,
        reason: payload.reason, developmentBrief: payload.developmentBrief, checklistConfirmed: payload.checklistConfirmed, reviewedAt: NOW });
      targetId = proposal.id;
    } else if (payload.action === 'create_version') {
      targetId = `version-${state.versions.length + 1}`;
      state.versions.push({ id: targetId, label: payload.label, summary: payload.summary, status: 'queued',
        revision: 1, createdAt: NOW, updatedAt: NOW, parentId: null, cancelRequested: false, commitSha: null });
    } else if (payload.action === 'cancel_version') {
      const version = state.versions.find((item) => item.id === payload.versionId);
      Object.assign(version, { status: version.status === 'queued' ? 'cancelled' : version.status, cancelRequested: version.status === 'running', revision: version.revision + 1 });
      targetId = version.id;
    } else if (payload.action === 'retry_version') {
      const version = state.versions.find((item) => item.id === payload.versionId);
      targetId = `version-${state.versions.length + 1}`;
      state.versions.push({ ...version, id: targetId, parentId: version.id, status: 'queued', revision: 1, cancelRequested: false });
    }
    state.audit.unshift({ id: `audit-${state.audit.length + 1}`, createdAt: NOW, action: payload.action, targetId, reason: payload.reason, actorName: ADMIN.name });
    const result = { ok: true, targetId };
    state.receipts.set(payload.requestId, { payload: structuredClone(payload), result });
    if (state.loseNextReceipt) {
      state.loseNextReceipt = false;
      return reply(route, { error: { code: 'RESPONSE_UNAVAILABLE', message: 'Receipt lost after committing the fixture operation.' } }, 503);
    }
    return reply(route, result);
  });
  await page.goto('/admin');
  if (state.session.user?.isAdmin) await expect(page.locator('#admin-shell')).toBeVisible();
  else await expect(page.locator('#admin-gate')).toBeVisible();
  return state;
}

async function section(page, name) { await page.locator(`.admin-nav [data-section="${name}"]`).click(); }

async function openSafetyReview(page) {
  await section(page, 'proposals');
  await page.locator('#proposals-rows').getByRole('button', { name: '안전 심사', exact: true }).first().click();
  await expect(page.locator('#safety-review-fields')).toBeVisible();
}

async function confirmSafetyChecks(page) {
  for (const id of ['safety-check-content', 'safety-check-instructions', 'safety-check-brief']) await page.locator(`#${id}`).check();
}

test('admin client refuses ordinary accounts without fetching management data', async ({ page }) => {
  const state = await fixture(page, { session: { user: { ...MEMBER, isAdmin: false }, csrfToken: 'ordinary-fixture', googleNonce: 'ordinary-fixture' } });
  await expect(page.locator('#admin-shell')).toBeHidden();
  await expect(page.locator('#gate-message')).toContainText('관리자 권한이 없습니다');
  expect(state.reads).toHaveLength(0);
  expect(state.writes).toHaveLength(0);
});

test('runtime API denial immediately removes all private admin DOM', async ({ page }) => {
  const state = await fixture(page);
  await section(page, 'users');
  await expect(page.locator('#users-rows')).toContainText(MEMBER.email);
  state.forbidden = true;
  await page.locator('#refresh-view').click();
  await expect(page.locator('#admin-gate')).toBeVisible();
  await expect(page.locator('#admin-shell')).toBeEmpty();
  await expect(page.locator('body')).not.toContainText(MEMBER.email);
  await expect(page.locator('body')).not.toContainText(ADMIN.email);
});

test('member management prevents self suspension and audits a member change', async ({ page }, testInfo) => {
  const state = await fixture(page);
  await section(page, 'users');
  const selfRow = page.locator('#users-rows tr').filter({ hasText: ADMIN.email });
  await expect(selfRow).toContainText('정지 불가');
  await expect(selfRow.getByRole('button', { name: /이용 정지/ })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('admin-members-desktop.png'), fullPage: true });
  const row = page.locator('#users-rows tr').filter({ hasText: MEMBER.email });
  await row.getByRole('button', { name: '이용 정지', exact: true }).click();
  await page.locator('#action-reason').fill('반복된 운영 규칙 위반 확인');
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-dialog')).toBeHidden();
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ action: 'set_user_status', userId: MEMBER.id, status: 'suspended', revision: 1 });
  expect(state.audit[0].reason).toBe('반복된 운영 규칙 위반 확인');
});

test('raw proposals stay text and moderation preserves their content', async ({ page }) => {
  const state = await fixture(page);
  await section(page, 'proposals');
  await page.locator('.proposal-original summary').click();
  await expect(page.locator('.proposal-original pre')).toHaveText(PROPOSAL.body);
  await expect(page.locator('#proposals-rows img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__adminXss)).toBeUndefined();
  await page.getByRole('button', { name: '개발 대상 제외', exact: true }).click();
  await page.locator('#action-reason').fill('이번 회차의 개발 범위에서 제외');
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-dialog')).toBeHidden();
  expect(state.proposals[0].body).toBe(PROPOSAL.body);
  expect(state.proposals[0].revision).toBe(PROPOSAL.revision);
  expect(state.proposals[0].moderation).toBe('excluded');
  expect(state.writes[0]).not.toHaveProperty('body');
});

test('safety approval needs a byte-limited game brief and every fresh check, bound to the displayed body', async ({ page }, testInfo) => {
  const state = await fixture(page);
  const original = structuredClone(state.proposals[0]);
  await openSafetyReview(page);
  await expect(page.locator('#safety-review-body')).toHaveText(original.body);
  await expect(page.locator('#safety-review-body img')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('admin-safety-review-desktop.png') });
  await expect(page.locator('#safety-review-binding')).toContainText(original.safety.bodyHash);
  await page.locator('#action-reason').fill('정상 게임 요구로 한정한 안전 검토');
  await expect(page.locator('#action-submit')).toBeDisabled();
  await page.locator('#safety-decision').selectOption('approved');
  await page.locator('#safety-development-brief').fill('가'.repeat(667));
  await confirmSafetyChecks(page);
  await expect(page.locator('#safety-brief-bytes')).toHaveAttribute('data-invalid', 'true');
  await expect(page.locator('#action-submit')).toBeDisabled();
  await page.locator('#safety-development-brief').fill('판타지 전투의 회피 조작 안내를 쉽게 확인하도록 개선한다.');
  await expect(page.locator('#safety-check-content')).not.toBeChecked();
  await page.locator('#safety-check-content').check();
  await page.locator('#safety-check-instructions').check();
  await expect(page.locator('#action-submit')).toBeDisabled();
  await page.locator('#safety-check-brief').check();
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-dialog')).not.toBeVisible();
  await expect(page.locator('#proposals-rows')).toContainText('안전 승인');
  expect(state.writes).toHaveLength(1);
  expect(state.writes[0]).toMatchObject({ action: 'review_proposal_safety', proposalId: original.id,
    proposalRevision: original.revision, bodyHash: original.safety.bodyHash, policyVersion: 'teen-v1',
    revision: original.safety.revision, status: 'approved', checklistConfirmed: true });
  expect(state.proposals[0].body).toBe(original.body);
  expect(state.proposals[0].moderation).toBe('pending');
  expect(state.proposals[0].safety.revision).toBe(2);
  expect(await page.evaluate(() => window.__adminXss)).toBeUndefined();
});

test('hard-blocked content cannot be approved and a reasoned hold is independently filterable', async ({ page }) => {
  const proposal = structuredClone(PROPOSAL);
  proposal.safety.hardBlocked = true;
  const state = await fixture(page, { proposals: [proposal] });
  await openSafetyReview(page);
  await expect(page.locator('#safety-hard-block')).toBeVisible();
  await expect(page.locator('#safety-decision option[value="approved"]')).toHaveJSProperty('disabled', true);
  await page.locator('#safety-decision').evaluate((select) => {
    select.value = 'approved';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#safety-development-brief').fill('선택 항목을 조작해도 승인할 수 없는 테스트 정리문');
  await page.locator('#action-reason').fill('차단된 본문은 승인할 수 없음');
  await confirmSafetyChecks(page);
  await expect(page.locator('#action-submit')).toBeDisabled();
  await page.locator('#action-form').evaluate((form) => form.requestSubmit());
  await expect(page.locator('#action-feedback')).toContainText('명백한 금지 요청으로 승인할 수 없습니다');
  expect(state.writes).toHaveLength(0);
  await page.locator('#action-reason').fill('');
  await page.locator('#safety-decision').selectOption('held');
  await expect(page.locator('#safety-approval-fields')).toBeHidden();
  await expect(page.locator('#action-submit')).toBeDisabled();
  await page.locator('#action-reason').fill('정상 문맥 확인이 필요하여 보류');
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-dialog')).not.toBeVisible();
  await expect(page.locator('#proposals-rows')).toContainText('안전 보류');
  expect(state.writes[0]).toMatchObject({ status: 'held', checklistConfirmed: false, developmentBrief: '' });
  expect(state.proposals[0].moderation).toBe('pending');
  await page.locator('#proposals-filters [name="safetyStatus"]').selectOption('held');
  await page.locator('#proposals-filters').getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.locator('#proposals-rows')).toContainText('안전 보류');
  expect(state.reads.at(-1).safetyStatus).toBe('held');
  await page.locator('#proposals-rows').getByRole('button', { name: '안전 심사', exact: true }).click();
  await page.locator('#safety-decision').selectOption('blocked');
  await page.locator('#action-reason').fill('검토 후 금지 내용 확인');
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-dialog')).not.toBeVisible();
  expect(state.proposals[0].safety.status).toBe('blocked');
  expect(state.audit.filter((entry) => entry.action === 'review_proposal_safety')).toHaveLength(2);
});

test('a changed safety-review target clears consent and preserves drafts until the new body is reopened', async ({ page }) => {
  const state = await fixture(page, { safetyConflictOnce: true });
  await openSafetyReview(page);
  await page.locator('#safety-decision').selectOption('approved');
  const brief = '검토 중인 게임 조작 개선 요구';
  const reason = '본문 변경 후에도 확인할 심사 사유';
  await page.locator('#safety-development-brief').fill(brief);
  await page.locator('#action-reason').fill(reason);
  await confirmSafetyChecks(page);
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-feedback')).toContainText('최신 원문을 다시 열어');
  await expect(page.locator('#action-submit')).toBeDisabled();
  await expect(page.locator('#safety-check-content')).not.toBeChecked();
  await expect(page.locator('#safety-development-brief')).toHaveValue(brief);
  await expect(page.locator('#action-reason')).toHaveValue(reason);
  expect(state.writes).toHaveLength(1);
  await page.locator('#action-cancel').click();
  await page.locator('#proposals-rows').getByRole('button', { name: '안전 심사', exact: true }).click();
  await expect(page.locator('#safety-review-body')).toHaveText('다른 창에서 바뀐 최신 제안 원문');
  await expect(page.locator('#safety-review-binding')).toContainText(state.proposals[0].safety.bodyHash);
  await expect(page.locator('#action-reason')).toHaveValue(reason);
  await page.locator('#safety-decision').selectOption('approved');
  await expect(page.locator('#safety-development-brief')).toHaveValue(brief);
  await expect(page.locator('#safety-check-content')).not.toBeChecked();
  await expect(page.locator('#action-submit')).toBeDisabled();
  await page.locator('#safety-development-brief').fill('새 원문의 게임 변경 요구를 다시 검토하고 정리했다.');
  await confirmSafetyChecks(page);
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-dialog')).not.toBeVisible();
  expect(state.writes[1].proposalRevision).toBe(2);
  expect(state.writes[1].bodyHash).not.toBe(state.writes[0].bodyHash);
  expect(state.writes[1].requestId).not.toBe(state.writes[0].requestId);
});

test('an uncertain safety approval retries only its exact original bound decision', async ({ page }) => {
  const state = await fixture(page, { loseNextReceipt: true });
  await openSafetyReview(page);
  await page.locator('#safety-decision').selectOption('approved');
  await page.locator('#safety-development-brief').fill('검증할 게임 조작 요구만 포함한 정리문');
  await page.locator('#action-reason').fill('안전 검토 결과 기록');
  await confirmSafetyChecks(page);
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-retry')).toBeVisible();
  await expect(page.locator('#safety-development-brief')).toBeDisabled();
  await expect(page.locator('#safety-decision')).toBeDisabled();
  expect(state.writes).toHaveLength(1);
  await page.locator('#action-retry').click();
  await expect(page.locator('#action-dialog')).not.toBeVisible();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.proposals[0].safety.revision).toBe(2);
  expect(state.audit).toHaveLength(1);
});

test('admin API denial during safety review removes the original body and the private brief immediately', async ({ page }) => {
  const state = await fixture(page);
  await openSafetyReview(page);
  await page.locator('#safety-decision').selectOption('approved');
  await page.locator('#safety-development-brief').fill('PRIVATE_REVIEW_DRAFT');
  await page.locator('#action-reason').fill('검토 권한 확인 테스트');
  await confirmSafetyChecks(page);
  state.forbidden = true;
  await page.locator('#action-submit').click();
  await expect(page.locator('#admin-gate')).toBeVisible();
  await expect(page.locator('#admin-shell')).toBeEmpty();
  await expect(page.locator('#safety-review-body')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('PRIVATE_REVIEW_DRAFT');
  expect(state.writes).toHaveLength(0);
});

test('empty development history does not invent a published game', async ({ page }) => {
  const state = await fixture(page);
  await section(page, 'versions');
  await expect(page.locator('#versions-rows')).toContainText('개발 요청이 아직 없습니다');
  await expect(page.locator('#panel-versions')).toContainText('작업 완료');
  await expect(page.locator('#panel-versions')).toContainText('게임 공개와 다릅니다');
  await expect(page.getByRole('button', { name: /게임 플레이|게임 공개/ })).toHaveCount(0);
  expect(state.writes).toHaveLength(0);
});

test('ending service requires the exact typed phrase and preserves data', async ({ page }) => {
  const state = await fixture(page);
  await section(page, 'service');
  await page.locator('#service-message').fill('운영 종료 안내');
  await page.locator('#danger-service-button').click();
  await expect(page.locator('#action-description')).toContainText('데이터는 삭제하지');
  await expect(page.locator('#action-description')).toContainText('관리자 접근');
  await page.locator('#action-reason').fill('관리자 요청에 따른 종료');
  await page.locator('#action-confirmation').fill('종료');
  await expect(page.locator('#action-submit')).toBeDisabled();
  expect(state.writes).toHaveLength(0);
  await page.locator('#action-confirmation').fill('서비스 종료');
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-dialog')).toBeHidden();
  expect(state.service.mode).toBe('ended');
  expect(state.service.proposalsEnabled).toBe(false);
  expect(state.service.developmentEnabled).toBe(false);
  expect(state.users).toHaveLength(2);
  expect(state.proposals).toHaveLength(1);
  await expect(page.locator('#danger-service-button')).toHaveText('서비스 재개…');
});

test('resuming an ended service leaves unselected capabilities disabled', async ({ page }) => {
  const state = await fixture(page, { service: { mode: 'ended', proposalsEnabled: false, developmentEnabled: false, message: '종료 안내', revision: 8, updatedAt: NOW } });
  await section(page, 'service');
  await expect(page.locator('#service-proposals')).not.toBeChecked();
  await expect(page.locator('#service-development')).not.toBeChecked();
  await page.locator('#service-proposals').check();
  await page.locator('#danger-service-button').click();
  await page.locator('#action-reason').fill('제안 접수만 다시 개시');
  await page.locator('#action-confirmation').fill('서비스 종료');
  await expect(page.locator('#action-submit')).toBeDisabled();
  await page.locator('#action-confirmation').fill('서비스 재개');
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-dialog')).toBeHidden();
  expect(state.service).toMatchObject({ mode: 'active', proposalsEnabled: true, developmentEnabled: false });
});

test('reauth refusal preserves reasons and offers the fixed Google reauth path', async ({ page }) => {
  const state = await fixture(page, { recentAuthRequired: true });
  await section(page, 'service');
  await page.locator('#danger-service-button').click();
  await page.locator('#action-reason').fill('재인증 뒤 확인할 종료 사유');
  await page.locator('#action-confirmation').fill('서비스 종료');
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-reason')).toHaveValue('재인증 뒤 확인할 종료 사유');
  await expect(page.locator('#action-confirmation')).toHaveValue('');
  await expect(page.locator('#action-reauth-link')).toBeVisible();
  await expect(page.locator('#action-reauth-link')).toHaveAttribute('href', '/?admin=1&reauth=1');
  await expect(page.locator('#admin-shell')).toBeVisible();
  expect(state.service.mode).toBe('active');
  expect(state.writes).toHaveLength(1);
  const draft = await page.evaluate(() => JSON.parse(sessionStorage.getItem('yourgame.admin.reauth-draft.v1')));
  expect(draft.reasons.some((entry) => entry[1] === '재인증 뒤 확인할 종료 사유')).toBe(true);
  expect(draft).not.toHaveProperty('confirmation');
});

test('unknown mutation results need manual retry with the identical request id', async ({ page }) => {
  const state = await fixture(page, { loseNextReceipt: true });
  await section(page, 'versions');
  await page.locator('#version-create summary').click();
  await page.locator('#version-label').fill('첫 번째 개발 요청');
  await page.locator('#version-summary').fill('회차 요구를 검토하고 개발 입력을 준비합니다.');
  await page.locator('#version-reason').fill('확인된 회차 요구에 따른 요청');
  await page.locator('#create-version-submit').click();
  await expect(page.locator('#version-feedback')).toContainText('요청 결과를 확인하지 못했습니다');
  await expect(page.locator('#version-label')).toHaveValue('첫 번째 개발 요청');
  expect(state.writes).toHaveLength(1);
  await page.locator('#retry-mutation').click();
  await expect(page.locator('#versions-rows')).toContainText('첫 번째 개발 요청');
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.versions).toHaveLength(1);
});

test('manual mutation recovery survives a failed read and a later successful refresh', async ({ page }) => {
  const state = await fixture(page, { loseNextReceipt: true });
  await section(page, 'versions');
  await page.locator('#version-create summary').click();
  await page.locator('#version-label').fill('조회 복구 후 결과 확인');
  await page.locator('#version-summary').fill('응답이 끊긴 개발 요청의 결과를 같은 식별자로 확인합니다.');
  await page.locator('#version-reason').fill('중복 작업 없이 원래 요청 확인');
  await page.locator('#create-version-submit').click();
  await expect(page.locator('#version-feedback')).toContainText('요청 결과를 확인하지 못했습니다');
  expect(state.writes).toHaveLength(1);

  state.readFailure = true;
  await page.locator('#refresh-view').click();
  await expect(page.locator('#admin-notice-message')).toContainText('서버 연결에 실패했습니다. 입력한 내용은 그대로 보관됩니다.');
  await expect(page.locator('#retry-mutation')).toBeVisible();
  await expect(page.locator('#refresh-view')).toBeEnabled();
  expect(state.writes).toHaveLength(1);

  state.readFailure = false;
  await page.locator('#refresh-view').click();
  await expect(page.locator('#versions-rows')).toContainText('조회 복구 후 결과 확인');
  await expect(page.locator('#retry-mutation')).toBeVisible();
  await expect(page.locator('#retry-mutation')).toBeEnabled();
  await expect(page.locator('#version-label')).toHaveValue('조회 복구 후 결과 확인');
  await expect(page.locator('#version-label')).toBeDisabled();
  expect(state.writes).toHaveLength(1);

  await page.locator('#retry-mutation').click();
  await expect(page.locator('#retry-mutation')).toBeHidden();
  await expect(page.locator('#version-label')).toHaveValue('');
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.versions).toHaveLength(1);
});

test('revision conflict refreshes service state without replacing the draft or reason', async ({ page }) => {
  const state = await fixture(page, { conflictOnce: true });
  await section(page, 'service');
  await page.locator('#service-message').fill('아직 저장 전인 공지');
  await page.locator('#service-reason').fill('사유는 충돌 후에도 유지');
  await page.locator('#service-submit').click();
  await expect(page.locator('#service-revision')).toContainText('revision 2');
  await expect(page.locator('#service-reason')).toHaveValue('사유는 충돌 후에도 유지');
  await expect(page.locator('#service-message')).toHaveValue('아직 저장 전인 공지');
  expect(state.writes).toHaveLength(1);
  await page.locator('#service-submit').click();
  await expect(page.locator('#service-reason')).toHaveValue('');
  expect(state.writes[1].revision).toBe(2);
  expect(state.writes[1].requestId).not.toBe(state.writes[0].requestId);
});

test('an uncertain sensitive action can be retried inside its modal without a second operation', async ({ page }) => {
  const state = await fixture(page, { loseNextReceipt: true });
  await section(page, 'service');
  await page.locator('#danger-service-button').click();
  await page.locator('#action-reason').fill('접수 종료 결과 확인');
  await page.locator('#action-confirmation').fill('서비스 종료');
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-feedback')).toContainText('요청 결과를 확인하지 못했습니다');
  await expect(page.locator('#action-retry')).toBeEnabled();
  await expect(page.locator('#action-reason')).toHaveValue('접수 종료 결과 확인');
  await page.locator('#action-retry').click();
  await expect(page.locator('#action-dialog')).toBeHidden();
  expect(state.writes).toHaveLength(2);
  expect(state.writes[1]).toEqual(state.writes[0]);
  expect(state.audit).toHaveLength(1);
  expect(state.service.revision).toBe(2);
});

test('returning after reauth restores only drafts and never replays the confirmed mutation', async ({ page }) => {
  const state = await fixture(page, { recentAuthRequired: true });
  await section(page, 'service');
  await page.locator('#service-message').fill('재인증 중에도 보관할 공지');
  await page.locator('#danger-service-button').click();
  await page.locator('#action-reason').fill('재인증 후 다시 검토할 이유');
  await page.locator('#action-confirmation').fill('서비스 종료');
  await page.locator('#action-submit').click();
  await expect(page.locator('#action-reauth-link')).toBeVisible();
  state.recentAuthRequired = false;
  await page.reload();
  await expect(page.locator('#admin-shell')).toBeVisible();
  await expect(page.locator('#service-message')).toHaveValue('재인증 중에도 보관할 공지');
  expect(state.writes).toHaveLength(1);
  await page.locator('#danger-service-button').click();
  await expect(page.locator('#action-reason')).toHaveValue('재인증 후 다시 검토할 이유');
  await expect(page.locator('#action-confirmation')).toHaveValue('');
  await expect(page.locator('#action-submit')).toBeDisabled();
  expect(state.service.mode).toBe('active');
});

test('member pagination sends a fifty-row limit and a cursor, then search resets it', async ({ page }) => {
  const members = Array.from({ length: 61 }, (_, index) => ({ ...MEMBER, id: `member-${index}`, name: `검색회원 ${index}`, email: `member-${index}@example.test` }));
  const state = await fixture(page, { users: members });
  await section(page, 'users');
  await expect(page.locator('#users-rows tr')).toHaveCount(50);
  await page.locator('[data-next="users"]').click();
  await expect(page.locator('#users-rows tr')).toHaveCount(11);
  expect(state.reads.some((read) => read.section === 'users' && read.limit === '50' && read.cursor === 'offset-50')).toBe(true);
  await page.locator('#users-filters input[name=q]').fill('member-60@example.test');
  await page.locator('#users-filters').getByRole('button', { name: '조회', exact: true }).click();
  await expect(page.locator('#users-rows tr')).toHaveCount(1);
  await expect(page.locator('#users-page-info')).toContainText('1 페이지');
  expect(state.reads.at(-1)).not.toHaveProperty('cursor');
});

test.describe('mobile touch', () => {
  test.use({ hasTouch: true });

  test('admin forms remain usable at 360px while tables scroll inside their region', async ({ page }, testInfo) => {
    const checkTouchTargets = async () => {
      const undersized = await page.locator('button, a, summary').evaluateAll((nodes) => nodes
        .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
        .map((node) => ({ name: node.id || node.textContent.trim(), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))
        .filter((target) => target.width < 44 || target.height < 44));
      expect(undersized).toEqual([]);
    };
    await page.setViewportSize({ width: 360, height: 800 });
    await fixture(page);
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.locator('.admin-nav [data-section="service"]').tap();
    await expect(page.locator('#service-message')).toBeVisible();
    await page.locator('#service-message').fill('모바일에서도 작성할 수 있는 공지');
    await checkTouchTargets();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('admin-service-mobile.png'), fullPage: true });
    await page.locator('#danger-service-button').tap();
    await expect(page.locator('#action-reason')).toBeVisible();
    await expect(page.locator('#action-confirmation')).toBeVisible();
    await checkTouchTargets();
    await page.screenshot({ path: testInfo.outputPath('admin-confirmation-mobile.png') });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Connecting a mouse must not shrink the controls on the same narrow screen.
    await page.locator('#action-cancel').click();
    await section(page, 'proposals');
    await expect(page.locator('#proposals-rows tr')).toHaveCount(1);
    const filterFonts = await page.locator('#proposals-filters input, #proposals-filters select')
      .evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)));
    expect(filterFonts.every((size) => size >= 16)).toBe(true);
    await checkTouchTargets();
    const overflow = await page.locator('#panel-proposals .table-scroll').evaluate((node) => node.scrollWidth > node.clientWidth);
    expect(overflow).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('#proposals-rows').getByRole('button', { name: '안전 심사', exact: true }).tap();
    await expect(page.locator('#safety-review-body')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('admin-safety-source-mobile.png') });
    await page.locator('#safety-decision').selectOption('approved');
    await page.locator('#safety-development-brief').fill('모바일에서 작성한 안전한 게임 요구 정리문');
    await page.locator('#action-reason').fill('모바일 안전 심사 화면 확인');
    await confirmSafetyChecks(page);
    await expect(page.locator('#action-submit')).toBeEnabled();
    await checkTouchTargets();
    expect(await page.locator('#safety-development-brief').evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('admin-safety-review-mobile.png') });
    await page.locator('#action-cancel').click();
  });
});
