import { validateGameBundle } from './game-bundle.js';
import { attachGameSavePort } from './game-save-bridge.js';

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const copy = {
  en: { loading: 'Loading the game…', playing: 'Playable here · saves stay on this device · ', failed: 'The game could not load. Your saves are preserved.', previous: 'Keeping the previous working game · ' },
  ko: { loading: '게임을 불러오는 중…', playing: '여기서 플레이 · 진행은 이 기기에 저장 · ', failed: '게임을 불러오지 못했습니다. 저장된 진행은 보존됩니다.', previous: '이전 정상 게임을 유지합니다 · ' },
};
export async function sha256Text(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}
async function boundedText(response) {
  if (!response.ok || !response.body) throw new Error('GAME_UNAVAILABLE');
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 98304) throw new Error('GAME_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function createGameHost({ surface, placeholder, note }) {
  let locale = 'en', active = true, current = null, attempt = null, attemptedKey = null, sequence = 0;
  function label(key, version = '') { note.textContent = copy[locale][key] + version; }
  function release(instance) {
    if (!instance) return;
    clearTimeout(instance.timeout); instance.abort.abort(); instance.bridge?.close(); instance.port?.close(); instance.frame?.remove();
  }
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
      const frame = document.createElement('iframe'); instance.frame = frame;
      frame.id = 'live-game-frame'; frame.title = locale === 'ko' ? '로그라이크 게임' : 'Roguelike game';
      frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'");
      frame.hidden = true; frame.dataset.gameVersion = game.version;
      let loads = 0;
      await new Promise((resolve, reject) => {
        instance.timeout = setTimeout(() => reject(new Error('GAME_START_TIMEOUT')), 15000);
        instance.abort.signal.addEventListener('abort', () => reject(new Error('GAME_CHANGED')), { once: true });
        frame.addEventListener('load', () => {
          if (++loads !== 1) { release(instance); if (current === instance) { current = null; placeholder.hidden = false; label('failed'); } return; }
          const channel = new MessageChannel(); instance.port = channel.port1;
          instance.bridge = attachGameSavePort(channel.port1, game.version);
          channel.port1.addEventListener('message', event => {
            if (event.data?.protocol === 1 && event.data.type === 'runtime:ready' && event.data.gameVersion === game.version) resolve();
          });
          frame.contentWindow.postMessage({ protocol: 1, type: 'runtime:init', bundle, locale }, '*', [channel.port2]);
        });
        frame.src = '/game-frame.html'; surface.append(frame);
      });
      clearTimeout(instance.timeout);
      if (epoch !== sequence) throw new Error('GAME_CHANGED');
      release(current); current = instance; attempt = null;
      placeholder.hidden = true; frame.hidden = false;
      instance.port.postMessage({ protocol: 1, type: 'runtime:availability', active });
      label('playing', game.version);
    } catch {
      release(instance);
      if (epoch === sequence) { attempt = null; label(current ? 'previous' : 'failed', current?.version || ''); }
    }
  }
  return Object.freeze({
    update({ game, locale: nextLocale = 'en', active: nextActive = true }) {
      locale = nextLocale === 'ko' ? 'ko' : 'en'; active = nextActive === true;
      current?.port.postMessage({ protocol: 1, type: 'runtime:locale', locale });
      current?.port.postMessage({ protocol: 1, type: 'runtime:availability', active });
      if (game?.published !== true) {
        if (current || attempt) { ++sequence; release(current); release(attempt); current = null; attempt = null; placeholder.hidden = false; }
        attemptedKey = null; return;
      }
      if (!VERSION.test(game.version || '') || !HASH.test(game.sha256 || '')) {
        if (attempt) { ++sequence; release(attempt); attempt = null; }
        label(current ? 'previous' : 'failed', current?.version || '');
        return;
      }
      const key = game.version + ':' + game.sha256;
      if (current?.key === key) { label('playing', current.version); return; }
      if (attemptedKey === key) { if (current) label('previous', current.version); return; }
      attemptedKey = key; void mount(game, key);
    },
    pause,
  });
}
