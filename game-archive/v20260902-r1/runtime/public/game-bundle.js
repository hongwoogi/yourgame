import { validateGameConfig } from './game-runtime-engine.js';

const ICONS = ['crown', 'leaf', 'spark', 'anvil', 'star', 'book'];
const ASSET_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ASSET_PATH = /^assets\/[a-z0-9][a-z0-9/-]{0,95}\.png$/;
const HASH = /^[a-f0-9]{64}$/;
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
// scripts, arbitrary CSS or capabilities are accepted. Version 2 may reference
// only immutable, hash-bound local PNG bytes supplied by the trusted host.
export function validateGameBundle(input) {
  if (typeof input !== 'object' || input === null) fail();
  let serialized;
  try { serialized = JSON.stringify(input); } catch { fail(); }
  if (new TextEncoder().encode(serialized).length > 98304) fail();
  const bundle = JSON.parse(serialized);
  if (![1, 2].includes(bundle.schemaVersion)) fail();
  exact(bundle, bundle.schemaVersion === 1 ? ['schemaVersion', 'config', 'copy', 'art']
    : ['schemaVersion', 'config', 'copy', 'art', 'assets']);
  validateGameConfig(bundle.config);
  exact(bundle.copy, ['title', 'subtitle', 'story', 'victory', 'defeat', 'disclaimer', 'heroes', 'cards', 'enemies', 'waves']);
  for (const key of ['title', 'subtitle', 'story', 'victory', 'defeat', 'disclaimer']) localized(bundle.copy[key], key === 'title' ? 64 : 500);
  copyRows(bundle.copy.heroes, bundle.config.heroes, ['name', 'role', 'description']);
  copyRows(bundle.copy.cards, bundle.config.cards, ['name', 'description']);
  copyRows(bundle.copy.enemies, bundle.config.enemies, ['name']);
  if (!Array.isArray(bundle.copy.waves) || bundle.copy.waves.length !== bundle.config.waves.length) fail();
  for (const wave of bundle.copy.waves) { exact(wave, ['title', 'description']); localized(wave.title, 80); localized(wave.description); }
  exact(bundle.art, bundle.schemaVersion === 1
    ? ['background', 'panel', 'accent', 'ink', 'muted', 'heroIcons']
    : ['background', 'panel', 'accent', 'ink', 'muted', 'heroIcons', 'cardImages']);
  for (const key of ['background', 'panel', 'accent', 'ink', 'muted']) if (!/^#[a-fA-F0-9]{6}$/.test(bundle.art[key])) fail();
  if (!Array.isArray(bundle.art.heroIcons) || bundle.art.heroIcons.length !== bundle.config.heroes.length) fail();
  const ids = new Set();
  for (const row of bundle.art.heroIcons) {
    exact(row, ['id', 'icon']);
    if (!bundle.config.heroes.some(hero => hero.id === row.id) || ids.has(row.id) || !ICONS.includes(row.icon)) fail();
    ids.add(row.id);
  }
  if (bundle.schemaVersion === 2) {
    if (!Array.isArray(bundle.assets) || bundle.assets.length !== bundle.config.cards.length || bundle.assets.length > 16) fail();
    const assetIds = new Set(), paths = new Set(); let total = 0;
    for (const asset of bundle.assets) {
      exact(asset, ['id', 'path', 'mediaType', 'bytes', 'sha256', 'width', 'height']);
      const folded = typeof asset.path === 'string' ? asset.path.toLowerCase() : '';
      if (!ASSET_ID.test(asset.id || '') || !ASSET_PATH.test(asset.path || '') || asset.path !== folded
        || asset.mediaType !== 'image/png' || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > 2 * 1024 * 1024
        || !HASH.test(asset.sha256 || '') || !Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height)
        || asset.width < 64 || asset.height < 64 || asset.width > 1024 || asset.height > 1024
        || assetIds.has(asset.id) || paths.has(folded)) fail();
      total += asset.bytes; assetIds.add(asset.id); paths.add(folded);
    }
    if (total > 12 * 1024 * 1024 || !Array.isArray(bundle.art.cardImages)
      || bundle.art.cardImages.length !== bundle.config.cards.length) fail();
    const cardIds = new Set(), usedAssets = new Set();
    for (const row of bundle.art.cardImages) {
      exact(row, ['id', 'assetId']);
      if (!bundle.config.cards.some(card => card.id === row.id) || cardIds.has(row.id)
        || !assetIds.has(row.assetId) || usedAssets.has(row.assetId)) fail();
      cardIds.add(row.id); usedAssets.add(row.assetId);
    }
    if (usedAssets.size !== assetIds.size) fail();
  }
  return bundle;
}
