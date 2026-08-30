import { apiErrorMessage } from './error-messages.js';

const LOCALES = Object.freeze(['en', 'ko']);
const STORAGE_KEY = 'yourgame.language.v1';
const COOKIE_NAME = 'yourgame_language';
const validLocale = value => LOCALES.includes(value);
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;
const ATTRIBUTES = ['placeholder', 'aria-label', 'aria-description', 'title', 'content', 'alt'];

// The factory keeps browser preferences and country lookup separate from all
// authentication, proposal and safety state. Importing catalogs on Node is safe.
export function createI18n({
  window: browser = globalThis.window,
  document: document = browser?.document,
  fetch: fetcher = browser?.fetch?.bind(browser),
  timeoutMs = 2000,
} = {}) {
  const catalogs = new Map();
  const listeners = new Set();
  const controls = new WeakSet();
  let locale = 'en';
  let source = 'default';
  let manual = false;
  let choiceRevision = 0;
  let initialization;

  function storedLocale() {
    try {
      const value = browser?.localStorage.getItem(STORAGE_KEY);
      return validLocale(value) ? value : null;
    } catch { return null; }
  }

  function cookieLocale() {
    try {
      const values = (document?.cookie || '').split(';').map(part => part.trim())
        .filter(part => part.startsWith(COOKIE_NAME + '='));
      if (values.length !== 1) return null;
      const value = values[0].slice(COOKIE_NAME.length + 1);
      return validLocale(value) ? value : null;
    } catch { return null; }
  }

  function queryLocale() {
    try {
      const values = new URL(browser.location.href).searchParams.getAll('lang');
      return values.length === 1 && validLocale(values[0]) ? values[0] : null;
    } catch { return null; }
  }

  function writeCookie(value) {
    if (!document) return;
    try {
      document.cookie = COOKIE_NAME + '=' + value + '; Path=/; Max-Age=31536000; SameSite=Lax'
        + (browser?.location.protocol === 'https:' ? '; Secure' : '');
    } catch { /* Language selection still works when cookie storage is blocked. */ }
  }

  function persist(value) {
    try { browser?.localStorage.setItem(STORAGE_KEY, value); } catch { /* Keep the in-memory choice. */ }
    writeCookie(value);
  }

  function updateExplicitUrl(value) {
    try {
      const url = new URL(browser.location.href);
      if (!url.searchParams.has('lang')) return;
      url.searchParams.set('lang', value);
      browser.history.replaceState(browser.history.state, '', url.pathname + url.search + url.hash);
    } catch { /* A restricted history API must not prevent changing languages. */ }
  }

  const explicit = queryLocale();
  const initial = explicit || storedLocale() || cookieLocale();
  if (initial) {
    locale = initial;
    source = 'preference';
    manual = true;
    if (explicit) persist(initial);
    else writeCookie(initial);
  }

  function t(key, parameters = {}) {
    if (typeof key !== 'string') return '';
    const separator = key.indexOf('.');
    const namespace = separator < 0 ? '' : key.slice(0, separator);
    const name = separator < 0 ? key : key.slice(separator + 1);
    const catalog = catalogs.get(namespace);
    const messages = catalog?.[locale];
    const fallback = catalog?.en;
    const template = messages && Object.hasOwn(messages, name) ? messages[name]
      : fallback && Object.hasOwn(fallback, name) ? fallback[name] : '[' + key + ']';
    return template.replace(PLACEHOLDER, (match, variable) =>
      parameters && Object.hasOwn(parameters, variable) ? String(parameters[variable]) : match);
  }

  function apply(root = document) {
    if (!root?.querySelectorAll) return;
    if (document?.documentElement) {
      document.documentElement.lang = locale;
      document.documentElement.dir = 'ltr';
      document.documentElement.dataset.languageSource = source;
    }
    const selector = '[data-i18n],' + ATTRIBUTES.map(name => '[data-i18n-' + name + ']').join(',');
    const nodes = [...root.querySelectorAll(selector)];
    if (root.matches?.(selector)) nodes.unshift(root);
    for (const node of nodes) {
      const key = node.getAttribute('data-i18n');
      if (key) node.textContent = t(key);
      for (const name of ATTRIBUTES) {
        const attributeKey = node.getAttribute('data-i18n-' + name);
        if (attributeKey) node.setAttribute(name, t(attributeKey));
      }
    }
    for (const select of root.querySelectorAll('select[data-language-select]')) select.value = locale;
  }

  function publish(next, nextSource) {
    const changed = locale !== next || source !== nextSource;
    locale = next;
    source = nextSource;
    apply();
    if (changed) for (const listener of [...listeners]) listener(locale);
  }

  function setLocale(value, { persist: shouldPersist = true } = {}) {
    if (!validLocale(value)) return false;
    // Even selecting the currently displayed English value is an explicit
    // choice and must win against an older, pending Korean country response.
    manual = true;
    choiceRevision += 1;
    if (shouldPersist) persist(value);
    updateExplicitUrl(value);
    publish(value, 'preference');
    return true;
  }

  function bindLanguageControls(root = document) {
    if (!root?.querySelectorAll) return;
    for (const select of root.querySelectorAll('select[data-language-select]')) {
      select.value = locale;
      if (controls.has(select)) continue;
      controls.add(select);
      select.addEventListener('change', () => {
        if (!setLocale(select.value)) select.value = locale;
      });
    }
  }

  async function countryLocale() {
    if (typeof fetcher !== 'function') return null;
    const controller = new AbortController();
    let timer;
    try {
      const lookup = (async () => {
        // Do not send the fallback locale as a preference; it would suppress
        // country detection. This endpoint never creates a login session.
        const response = await fetcher('/api/locale', {
          method: 'GET', headers: { Accept: 'application/json' },
          credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (!validLocale(data?.locale) || !['preference', 'country', 'default'].includes(data?.source)
            || (data.source === 'default' && data.locale !== 'en')) return null;
        return { locale: data.locale, source: data.source };
      })().catch(() => null);
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs);
      });
      return await Promise.race([lookup, timeout]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  function init() {
    if (initialization) return initialization;
    bindLanguageControls();
    apply();
    if (manual) return initialization = Promise.resolve(locale);
    const revision = choiceRevision;
    initialization = countryLocale().then(result => {
      if (result && !manual && choiceRevision === revision) {
        // A preference can be written by another tab while the request is in
        // flight even if its storage event has not arrived yet.
        const latest = storedLocale() || cookieLocale();
        if (latest) {
          manual = true;
          choiceRevision += 1;
          publish(latest, 'preference');
        } else {
          publish(result.locale, result.source);
        }
      }
      return locale;
    });
    return initialization;
  }

  function register(namespace, messages) {
    if (!/^[a-z][a-z0-9-]*$/.test(namespace)) throw new TypeError('Invalid translation namespace.');
    const enKeys = Object.keys(messages?.en || {}).sort();
    const koKeys = Object.keys(messages?.ko || {}).sort();
    if (!enKeys.length || enKeys.join('\n') !== koKeys.join('\n')) {
      throw new TypeError('English and Korean translation keys must match: ' + namespace);
    }
    const result = {};
    for (const language of LOCALES) {
      const entries = Object.create(null);
      for (const key of enKeys) {
        const value = messages[language][key];
        if (typeof value !== 'string') throw new TypeError('Translation values must be strings.');
        entries[key] = value;
      }
      result[language] = Object.freeze(entries);
    }
    const variables = value => [...new Set([...value.matchAll(PLACEHOLDER)].map(match => match[1]))].sort().join(',');
    for (const key of enKeys) {
      if (variables(result.en[key]) !== variables(result.ko[key])) {
        throw new TypeError('Translation parameters must match: ' + namespace + '.' + key);
      }
    }
    catalogs.set(namespace, Object.freeze(result));
    apply();
  }

  browser?.addEventListener?.('storage', event => {
    if (event.key !== STORAGE_KEY || !validLocale(event.newValue)) return;
    // Storage events can be queued behind a newer choice in this or another
    // tab. Only apply the value that is still current in shared storage.
    if (storedLocale() !== event.newValue) return;
    manual = true;
    choiceRevision += 1;
    writeCookie(event.newValue);
    updateExplicitUrl(event.newValue);
    publish(event.newValue, 'preference');
  });

  return Object.freeze({
    get locale() { return locale; },
    get intlLocale() { return locale === 'ko' ? 'ko-KR' : 'en-US'; },
    get source() { return source; },
    supportedLocales: LOCALES,
    register, t, apply, init, setLocale, bindLanguageControls,
    apiError(code, fallback = '') { return apiErrorMessage(code, locale, fallback); },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('A language listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export const i18n = createI18n();
