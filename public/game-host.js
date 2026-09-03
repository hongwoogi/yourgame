import { validateGameBundle } from './game-bundle.js';
import { attachGameSavePort } from './game-save-bridge.js';

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const GAME_START_TIMEOUT_MS = 45000;
const FIRST_LOAD_RETRY_DELAY_MS = 1500;
const ASSET_FETCH_CONCURRENCY = 2;
const copy = {
  en: { loading: 'Loading the game…', playing: 'Playable here · saves stay on this device · ', failed: 'The game could not load. Your saves are preserved.', previous: 'Keeping the previous working game · ' },
  ko: { loading: '게임을 불러오는 중…', playing: '여기서 플레이 · 진행은 이 기기에 저장 · ', failed: '게임을 불러오지 못했습니다. 저장된 진행은 보존됩니다.', previous: '이전 정상 게임을 유지합니다 · ' },
};
export async function sha256Text(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
async function boundedBytes(response, limit, unavailableCode, tooLargeCode) {
  if (!response.ok) throw new Error(unavailableCode);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error(tooLargeCode);
  if (!response.body || typeof response.body.getReader !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(tooLargeCode);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error(tooLargeCode);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function boundedText(response) {
  const bytes = await boundedBytes(response, 98304, 'GAME_UNAVAILABLE', 'GAME_TOO_LARGE');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
async function boundedAsset(response, asset) {
  const bytes = await boundedBytes(response, asset.bytes, 'GAME_ASSET_UNAVAILABLE', 'GAME_ASSET_TOO_LARGE');
  if (bytes.byteLength !== asset.bytes) throw new Error('GAME_ASSET_BYTES_CHANGED');
  if (bytes.length < 8 || ![137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value)
    || await sha256Bytes(bytes) !== asset.sha256) throw new Error('GAME_ASSET_BYTES_CHANGED');
  return { id: asset.id, mediaType: asset.mediaType, width: asset.width, height: asset.height, bytes: bytes.buffer };
}
async function mapBounded(rows, concurrency, work) {
  const result = new Array(rows.length); let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (next < rows.length) {
      const index = next++;
      result[index] = await work(rows[index]);
    }
  });
  await Promise.all(workers);
  return result;
}

export function createGameHost({ surface, placeholder, note }) {
  let locale = 'en', active = true, current = null, attempt = null, attemptedKey = null, retryTimer = null, sequence = 0;
  const attempts = new Map();
  function label(key, version = '') { note.textContent = copy[locale][key] + version; }
  function release(instance) {
    if (!instance) return;
    clearTimeout(instance.timeout); instance.abort.abort(); instance.bridge?.close(); instance.port?.close(); instance.frame?.remove();
  }
  function cancelRetry() { if (retryTimer) clearTimeout(retryTimer); retryTimer = null; }
  function pause() { current?.port.postMessage({ protocol: 1, type: 'runtime:pause' }); }
  function focusOutside(event) { if (!surface.contains(event.target)) pause(); }
  document.addEventListener('focusin', focusOutside);
  document.addEventListener('pointerdown', focusOutside);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  // Focusing the child frame blurs the parent window too. Do not re-pause a
  // just-clicked Resume button; the child handles its own real window blur.
  window.addEventListener('blur', () => setTimeout(() => {
    if (document.hidden || document.activeElement !== current?.frame) pause();
  }, 0));

  async function mount(game, key) {
    const epoch = ++sequence;
    release(attempt);
    const instance = { abort: new AbortController(), frame: null, port: null, bridge: null, timeout: null, version: game.version, key };
    attempt = instance; label('loading');
    try {
      const response = await fetch(`/games/${game.version}/game.json`, { credentials: 'omit', cache: 'no-cache', signal: instance.abort.signal });
      const text = await boundedText(response);
      if (await sha256Text(text) !== game.sha256) throw new Error('GAME_BYTES_CHANGED');
      const bundle = validateGameBundle(JSON.parse(text));
      if (bundle.config.gameVersion !== game.version || epoch !== sequence) throw new Error('GAME_CHANGED');
      const assets = await mapBounded(bundle.assets || [], ASSET_FETCH_CONCURRENCY, async asset => boundedAsset(await fetch(
        `/games/${game.version}/${asset.path}`, { credentials: 'omit', cache: 'no-cache', signal: instance.abort.signal }), asset));
      if (epoch !== sequence) throw new Error('GAME_CHANGED');
      const frame = document.createElement('iframe'); instance.frame = frame;
      frame.id = 'live-game-frame'; frame.title = locale === 'ko' ? '로그라이크 게임' : 'Roguelike game';
      frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.allowFullscreen = true;
      frame.setAttribute('allow', "fullscreen; camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'");
      frame.hidden = true; frame.dataset.gameVersion = game.version;
      let loads = 0;
      await new Promise((resolve, reject) => {
        instance.timeout = setTimeout(() => reject(new Error('GAME_START_TIMEOUT')), GAME_START_TIMEOUT_MS);
        instance.abort.signal.addEventListener('abort', () => reject(new Error('GAME_CHANGED')), { once: true });
        frame.addEventListener('load', () => {
          if (++loads !== 1) { release(instance); if (current === instance) { current = null; placeholder.hidden = false; label('failed'); } return; }
          const channel = new MessageChannel(); instance.port = channel.port1;
          instance.bridge = attachGameSavePort(channel.port1, game.version);
          channel.port1.addEventListener('message', event => {
            if (event.data?.protocol === 1 && event.data.type === 'runtime:ready' && event.data.gameVersion === game.version) resolve();
            else if (event.data?.protocol === 1 && event.data.type === 'runtime:error' && event.data.gameVersion === game.version) {
              reject(new Error('GAME_RUNTIME_FAILED'));
            }
          });
          frame.contentWindow.postMessage({ protocol: 1, type: 'runtime:init', bundle, locale, assets }, '*',
            [channel.port2, ...assets.map(asset => asset.bytes)]);
        });
        frame.src = '/game-frame.html'; surface.append(frame);
      });
      clearTimeout(instance.timeout);
      if (epoch !== sequence) throw new Error('GAME_CHANGED');
      release(current); current = instance; attempt = null;
      attempts.delete(key); cancelRetry();
      placeholder.hidden = true; frame.hidden = false;
      instance.port.postMessage({ protocol: 1, type: 'runtime:availability', active });
      label('playing', game.version);
    } catch {
      release(instance);
      if (epoch === sequence) {
        attempt = null;
        const count = attempts.get(key) || 1;
        if (!current && count < 2) {
          attempts.set(key, count + 1); label('loading');
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (attemptedKey === key && !current && !attempt) void mount(game, key);
          }, FIRST_LOAD_RETRY_DELAY_MS);
        } else label(current ? 'previous' : 'failed', current?.version || '');
      }
    }
  }
  return Object.freeze({
    update({ game, locale: nextLocale = 'en', active: nextActive = true }) {
      locale = nextLocale === 'ko' ? 'ko' : 'en'; active = nextActive === true;
      current?.port.postMessage({ protocol: 1, type: 'runtime:locale', locale });
      current?.port.postMessage({ protocol: 1, type: 'runtime:availability', active });
      if (game?.published !== true) {
        if (current || attempt || retryTimer) { ++sequence; release(current); release(attempt); cancelRetry(); current = null; attempt = null; placeholder.hidden = false; }
        attemptedKey = null; attempts.clear(); return;
      }
      if (!VERSION.test(game.version || '') || !HASH.test(game.sha256 || '')) {
        if (attempt || retryTimer) { ++sequence; release(attempt); cancelRetry(); attempt = null; }
        attemptedKey = null; attempts.clear();
        label(current ? 'previous' : 'failed', current?.version || '');
        return;
      }
      const key = game.version + ':' + game.sha256;
      if (current?.key === key) { label('playing', current.version); return; }
      if (attemptedKey === key) { if (current) label('previous', current.version); return; }
      cancelRetry(); attemptedKey = key; attempts.clear(); attempts.set(key, 1); void mount(game, key);
    },
    pause,
  });
}
