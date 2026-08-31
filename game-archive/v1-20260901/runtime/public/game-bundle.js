import { validateGameConfig } from './game-runtime-engine.js';

const ICONS = ['crown', 'leaf', 'spark', 'anvil', 'star', 'book'];
const fail = () => { throw new Error('GAME_BUNDLE_INVALID'); };
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) fail();
}
function localized(value, limit = 240) {
  exact(value, ['en', 'ko']);
  for (const text of Object.values(value)) {
    if (typeof text !== 'string' || !text.trim() || text.length > limit
      || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(text)
      || /(?:https?:|javascript:|data:|www\.)/i.test(text)) fail();
  }
}
function copyRows(rows, refs, fields) {
  if (!Array.isArray(rows) || rows.length !== refs.length) fail();
  const ids = new Set();
  for (const row of rows) {
    exact(row, ['id', ...fields]);
    if (!refs.some(ref => ref.id === row.id) || ids.has(row.id)) fail();
    ids.add(row.id);
    for (const field of fields) localized(row[field]);
  }
}

// Generated content is declarative data only. No source, URLs, HTML, expressions,
// scripts, arbitrary CSS, assets or capabilities are accepted in this format.
export function validateGameBundle(input) {
  if (typeof input !== 'object' || input === null) fail();
  let serialized;
  try { serialized = JSON.stringify(input); } catch { fail(); }
  if (new TextEncoder().encode(serialized).length > 98304) fail();
  const bundle = JSON.parse(serialized);
  exact(bundle, ['schemaVersion', 'config', 'copy', 'art']);
  if (bundle.schemaVersion !== 1) fail();
  validateGameConfig(bundle.config);
  exact(bundle.copy, ['title', 'subtitle', 'story', 'victory', 'defeat', 'disclaimer', 'heroes', 'cards', 'enemies', 'waves']);
  for (const key of ['title', 'subtitle', 'story', 'victory', 'defeat', 'disclaimer']) localized(bundle.copy[key], key === 'title' ? 64 : 500);
  copyRows(bundle.copy.heroes, bundle.config.heroes, ['name', 'role', 'description']);
  copyRows(bundle.copy.cards, bundle.config.cards, ['name', 'description']);
  copyRows(bundle.copy.enemies, bundle.config.enemies, ['name']);
  if (!Array.isArray(bundle.copy.waves) || bundle.copy.waves.length !== bundle.config.waves.length) fail();
  for (const wave of bundle.copy.waves) { exact(wave, ['title', 'description']); localized(wave.title, 80); localized(wave.description); }
  exact(bundle.art, ['background', 'panel', 'accent', 'ink', 'muted', 'heroIcons']);
  for (const key of ['background', 'panel', 'accent', 'ink', 'muted']) if (!/^#[a-fA-F0-9]{6}$/.test(bundle.art[key])) fail();
  if (!Array.isArray(bundle.art.heroIcons) || bundle.art.heroIcons.length !== bundle.config.heroes.length) fail();
  const ids = new Set();
  for (const row of bundle.art.heroIcons) {
    exact(row, ['id', 'icon']);
    if (!bundle.config.heroes.some(hero => hero.id === row.id) || ids.has(row.id) || !ICONS.includes(row.icon)) fail();
    ids.add(row.id);
  }
  return bundle;
}
