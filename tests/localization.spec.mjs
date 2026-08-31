import { test, expect } from '@playwright/test';

// Country and API replies are controlled here. This verifies browser behavior,
// not a real foreign network location or Google account authentication.
test.use({ locale: 'ko-KR' });
const START = Date.parse('2026-08-31T03:00:00.000Z');
const KEY = 'yourgame.language.v1';

async function mockApi(context) {
  const state = { localeReads: 0, requests: [], mutations: [] };
  await context.route('https://accounts.google.com/**', route => route.abort());
  await context.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    state.requests.push({ pathname, method: request.method(), locale: request.headers()['x-yourgame-language'] });
    if (request.method() !== 'GET') state.mutations.push(pathname);
    const reply = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (pathname === '/api/locale') {
      state.localeReads++;
      expect(request.headers()['x-yourgame-language']).toBeUndefined();
      return reply({ locale: 'en', source: 'default', supportedLocales: ['en', 'ko'] });
    }
    if (pathname === '/api/session') return reply({ user: null, csrfToken: 'locale-fixture-csrf', googleNonce: 'locale-fixture-nonce' });
    if (pathname === '/api/status') return reply({
      serverTime: new Date(START).toISOString(),
      firstReleaseAt: '2026-08-31T15:00:00.000Z',
      collection: { id: 'initial', status: 'open', closesAt: '2026-08-31T14:00:00.000Z', initialClosed: false },
      limits: { bytes: 2000, submissions: 3, windowSeconds: 3600 },
      game: { published: false }, googleClientId: 'locale-fixture.apps.googleusercontent.com',
      rating: { target: 'Teen', official: false, policyVersion: 'teen-v1' },
      service: { mode: 'active', proposalsEnabled: true, developmentEnabled: true, message: '' },
    });
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNEXPECTED_FIXTURE_REQUEST' } }) });
  });
  return state;
}

async function openPage(page, url = '/') {
  await page.clock.install({ time: new Date(START) });
  await page.goto(url);
  await expect(page.locator('#login-button')).toBeEnabled();
  await expect(page.locator('#submit-button')).toBeEnabled();
}

test('the original HTML and share preview are English even without JavaScript in a Korean browser', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: 'ko-KR', baseURL: 'http://localhost:3000' });
  try {
    const page = await context.newPage();
    const response = await page.goto('/');
    expect(response.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#hero-title')).toContainText('One evolving roguelike.');
    await expect(page).toHaveTitle('yourga.me — One roguelike, shaped by your prompts');
    await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content', /follow the first game as it takes shape/);
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'en_US');
    await expect(page.locator('.noscript-notice')).toBeVisible();
    await expect(page.locator('.noscript-notice')).toHaveText('Enable JavaScript to submit ideas and log in with Google.');
    await expect(page.locator('.release-date time')).toHaveText('Aug 31, 2026 / 11:00 AM EDT');
    await expect(page.locator('.release-date time')).toHaveAttribute('title', 'Washington, D.C. (Eastern Time)');
    await expect(page.locator('#login-button')).toBeDisabled();
  } finally { await context.close(); }
});

test('English copy includes metadata and accessible names, and toggling never leaves missing translation keys', async ({ page, context }) => {
  const state = await mockApi(context);
  await openPage(page);
  expect(await page.evaluate(() => navigator.language)).toBe('ko-KR');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  const englishText = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const values = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement?.closest('option, script, style')) values.push(walker.currentNode.textContent);
    }
    const attrs = [...document.querySelectorAll('[aria-label], [placeholder], [title], meta[content]')]
      .flatMap(node => ['aria-label', 'placeholder', 'title', 'content'].map(name => node.getAttribute(name) || ''));
    return values.concat(attrs).join('\n');
  });
  expect(englishText).not.toMatch(/\p{Script=Hangul}/u);
  expect(englishText).not.toMatch(/\[(?:public|admin)\./);
  await expect(page.getByRole('combobox', { name: 'Language', exact: true })).toHaveValue('en');
  await page.locator('#language-select').selectOption('ko');
  await expect(page.getByRole('combobox', { name: '언어', exact: true })).toHaveValue('ko');
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'ko_KR');
  await expect(page.locator('#prompt')).toHaveAttribute('placeholder', '어떤 변화가 이 로그라이크를 더 재미있게 만들까요?');
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#prompt')).toHaveAttribute('placeholder', 'What would make this roguelike more fun?');
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute('content', 'en_US');
  await expect(page.locator('body')).not.toContainText('[public.');
  expect(state.mutations).toEqual([]);
});

test('manual language selection and the active draft remain usable when preference storage is blocked', async ({ page, context }) => {
  const state = await mockApi(context);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('Blocked by browser', 'SecurityError'); } });
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get() { throw new DOMException('Blocked by browser', 'SecurityError'); },
      set() { throw new DOMException('Blocked by browser', 'SecurityError'); },
    });
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openPage(page);
  const draft = 'Keep this local draft 그대로. No automatic submission.';
  await page.locator('#prompt').fill(draft);
  const requests = state.requests.length;
  const marker = await page.evaluate(() => window.languagePageMarker = crypto.randomUUID());
  await page.locator('#language-select').selectOption('ko');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.locator('#prompt')).toHaveValue(draft);
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#prompt')).toHaveValue(draft);
  expect(await page.evaluate(() => window.languagePageMarker)).toBe(marker);
  expect(state.requests.length).toBe(requests);
  expect(state.mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('real cross-tab language events preserve each draft and do not trigger authentication or submissions', async ({ page, context }) => {
  const state = await mockApi(context);
  await openPage(page);
  const other = await context.newPage();
  await openPage(other);
  await page.locator('#prompt').fill('Draft A stays in its input.');
  await other.locator('#prompt').fill('Draft B stays in its input.');
  const reads = state.requests.length;
  await page.locator('#language-select').selectOption('ko');
  await expect(other.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(other.locator('#language-select')).toHaveValue('ko');
  await other.locator('#language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#prompt')).toHaveValue('Draft A stays in its input.');
  await expect(other.locator('#prompt')).toHaveValue('Draft B stays in its input.');
  expect(state.requests.length).toBe(reads);
  expect(state.mutations).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe('en');
  const countryReads = state.localeReads;
  await other.reload();
  await expect(other.locator('#login-button')).toBeEnabled();
  await expect(other.locator('html')).toHaveAttribute('lang', 'en');
  expect(state.localeReads).toBe(countryReads);
});

test('the English sharing URL overrides Korean preference and preserves unrelated URL state when changed', async ({ page, context }) => {
  const state = await mockApi(context);
  await context.addCookies([{ name: 'yourgame_language', value: 'ko', url: 'http://localhost:3000' }]);
  await openPage(page, '/?campaign=reddit&lang=en#prompt');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(state.localeReads).toBe(0);
  expect(await page.evaluate(key => localStorage.getItem(key), KEY)).toBe('en');
  await page.locator('#language-select').selectOption('ko');
  const url = new URL(page.url());
  expect(url.searchParams.get('campaign')).toBe('reddit');
  expect(url.searchParams.get('lang')).toBe('ko');
  expect(url.hash).toBe('#prompt');
  await page.reload();
  await expect(page.locator('#login-button')).toBeEnabled();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  expect(state.localeReads).toBe(0);
  expect(state.mutations).toEqual([]);
});
