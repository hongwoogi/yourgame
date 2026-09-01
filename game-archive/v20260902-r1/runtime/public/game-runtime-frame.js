import { init, act, restore, retry } from './game-runtime-engine.js';
import { validateGameBundle } from './game-bundle.js';

const root = document.getElementById('game');
const words = {
  en: { start: 'Begin expedition', continue: 'Continue expedition', health: 'Kingdom', food: 'Food', gold: 'Gold', morale: 'Morale',
    turn: 'Wave', defend: 'Face the wave', hand: 'Your hand', choose: 'Choose a card, then a hex to fortify.',
    reward: 'Your kingdom grows', rewardHint: 'Add one card to your deck. Your choice shapes the next wave.',
    saved: 'Saved on this device · ', saving: 'Saving…', failed: 'Save unavailable. Existing progress has not been replaced.',
    reload: 'Reload saved progress', unsaved: 'Play without saving', unsavedNote: 'This run is not being saved.',
    pause: 'Pause', paused: 'Expedition paused', resume: 'Resume', pauseNote: 'Your kingdom will wait while you write.',
    retry: 'New expedition', cost: 'Not enough resources for that card.', tile: 'Hex', defense: 'Defense', incoming: 'Incoming',
    win: 'A kingdom stands', lose: 'The expedition ends', keyboard: '1–8: cards · arrows: hex · Enter: play · Space: wave · Esc: pause',
    chooseHero: 'Choose your founder', seed: 'Seed', reloadConflict: 'Another tab saved first. Reload its progress to continue.',
    help: 'How to play', fullscreen: 'Full screen', back: 'Back', next: 'Next', close: 'Return to game',
    growth: 'Deck growth', cardsGained: 'Cards gained', growthReady: 'A new card joined your deck.', page: 'Page',
  },
  ko: { start: '원정 시작', continue: '원정 이어하기', health: '왕국', food: '식량', gold: '금화', morale: '민심',
    turn: '공세', defend: '공세 맞서기', hand: '보유 카드', choose: '카드를 고른 뒤 강화할 육각 타일을 누르세요.',
    reward: '왕국이 성장합니다', rewardHint: '덱에 카드를 한 장 추가하세요. 선택이 다음 공세를 바꿉니다.',
    saved: '이 기기에 저장됨 · ', saving: '저장 중…', failed: '저장할 수 없습니다. 기존 진행은 덮어쓰지 않았습니다.',
    reload: '저장된 진행 다시 읽기', unsaved: '저장 없이 플레이', unsavedNote: '현재 원정은 저장되지 않습니다.',
    pause: '일시정지', paused: '원정 일시정지', resume: '계속하기', pauseNote: '의견을 쓰는 동안 왕국은 기다립니다.',
    retry: '새 원정', cost: '이 카드를 사용할 자원이 부족합니다.', tile: '타일', defense: '방어', incoming: '예정 공격',
    win: '하나의 왕국이 서다', lose: '원정이 끝났습니다', keyboard: '1–8: 카드 · 방향키: 타일 · Enter: 사용 · Space: 공세 · Esc: 정지',
    chooseHero: '창립자 선택', seed: '시드', reloadConflict: '다른 탭이 먼저 저장했습니다. 저장된 진행을 다시 읽으세요.',
    help: '게임 방법', fullscreen: '전체 화면', back: '이전', next: '다음', close: '게임으로',
    growth: '덱 성장', cardsGained: '획득 카드', growthReady: '새 카드가 덱에 합류했습니다.', page: '페이지',
  },
};
const helpPages = {
  en: [
    ['Resources and cards', 'Health keeps the kingdom standing. Food is paid after each wave. Gold and morale power cards. Choose a card, then a hex when the card adds defense.'],
    ['Board and incoming attacks', 'The seven hexes store defense. Red-marked hexes will be attacked. The number beside the arrow is incoming strength; defense absorbs it before health is lost.'],
    ['Waves, growth, and endings', 'Face six waves. After each of the first five, choose one reward card. It stays in this run and expands your deck. Survive wave six to win; health reaching zero ends the run.'],
  ],
  ko: [
    ['자원과 카드', '왕국 수명이 0이 되지 않게 지키세요. 매 공세 뒤 식량을 지불합니다. 금화와 민심은 카드 비용입니다. 방어 카드는 먼저 카드, 다음에 육각 타일을 선택합니다.'],
    ['게임판과 예정 공격', '일곱 육각 타일에 방어가 쌓입니다. 붉게 표시된 타일은 공격받을 예정입니다. 화살표 옆 숫자가 공격력이며, 방어가 먼저 막고 남은 피해가 왕국 수명을 줄입니다.'],
    ['공세·성장·승패', '여섯 공세를 버티세요. 첫 다섯 공세 뒤 보상 카드 한 장을 골라 현재 원정의 덱을 확장합니다. 여섯 번째를 넘기면 승리하고, 왕국 수명이 0이면 패배합니다.'],
  ],
};
const symbols = { crown: '♔', leaf: '❧', spark: '✦', anvil: '⬡', star: '✧', book: '▤' };
const statSymbols = { health: '♥', food: '◆', gold: '●', morale: '✦', defense: '⬡' };
let bundle, port, locale = 'en', state = null, revision = 0, heroId, selectedCard = null, selectedTile = 0;
let paused = false, locked = false, menu = true, saving = false, saveError = '', notice = '', volatile = false, ready = false;
let view = 'main', helpPage = 0, heroPage = 0, growthCard = null;
const assetUrls = new Map();
let requestNumber = 0;
const pending = new Map();
const t = key => words[locale][key];
const localized = value => value[locale];
const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
function button(text, action, className = 'primary') {
  const node = element('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node;
}
async function loadAssets(records) {
  if (bundle.schemaVersion === 1) return;
  if (!Array.isArray(records) || records.length !== bundle.assets.length) throw new Error('GAME_ASSET_INVALID');
  const supplied = new Map(records.map(record => [record?.id, record]));
  if (supplied.size !== records.length) throw new Error('GAME_ASSET_INVALID');
  for (const asset of bundle.assets) {
    const record = supplied.get(asset.id);
    if (!record || record.mediaType !== asset.mediaType || record.width !== asset.width || record.height !== asset.height
      || !(record.bytes instanceof ArrayBuffer) || record.bytes.byteLength !== asset.bytes) throw new Error('GAME_ASSET_INVALID');
    const url = URL.createObjectURL(new Blob([record.bytes], { type: record.mediaType }));
    try {
      const image = new Image(); image.src = url; await image.decode();
      if (image.naturalWidth !== asset.width || image.naturalHeight !== asset.height) throw new Error('GAME_ASSET_INVALID');
      assetUrls.set(asset.id, url);
    } catch (error) { URL.revokeObjectURL(url); throw error; }
  }
}
function toggleFullscreen() {
  const action = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  action?.catch(() => {});
}
function request(type, data = {}) {
  const requestId = 'frame-' + ++requestNumber;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('SAVE_UNAVAILABLE')); }, 8000);
    pending.set(requestId, { resolve, reject, timeout });
    port.postMessage({ protocol: 1, type, requestId, ...data });
  });
}
async function load() {
  saving = true; saveError = ''; render();
  try {
    const record = await request('save:load');
    state = record ? restore(bundle.config, record.data.state) : null;
    revision = record?.revision ?? 0;
    heroId = state?.heroId || heroId;
    volatile = false;
  } catch (error) { saveError = error.message === 'SAVE_CONFLICT' ? 'reloadConflict' : 'failed'; }
  saving = false; ready = true; render();
  port.postMessage({ protocol: 1, type: 'runtime:ready', gameVersion: bundle.config.gameVersion });
}
async function commit(next) {
  if (saving || saveError || locked) return;
  saving = true; notice = ''; render();
  try {
    if (!volatile) {
      const record = await request('save:write', { expectedRevision: revision, data: { state: next } });
      revision = record.revision;
    }
    state = next; menu = false; selectedCard = null;
    view = growthCard && state.phase === 'playing' ? 'growth' : 'main';
  } catch (error) { saveError = error.message === 'SAVE_CONFLICT' ? 'reloadConflict' : 'failed'; }
  saving = false; render();
}
function take(action) {
  if (!ready || menu || paused || locked || saving || saveError) return;
  try { void commit(act(bundle.config, state, action)); }
  catch (error) { notice = error.code === 'GAME_COST_UNAVAILABLE' ? 'cost' : 'choose'; render(); }
}
function newSeed() {
  const values = new Uint32Array(1); crypto.getRandomValues(values);
  return values[0] === state?.seed ? (values[0] + 1) >>> 0 : values[0];
}
function playCard(id) {
  const card = bundle.config.cards.find(row => row.id === id);
  if (card.effect.defense) { selectedCard = id; notice = 'choose'; render(); }
  else take({ type: 'play', cardId: id });
}
function chooseReward(id) {
  if (!ready || menu || paused || locked || saving || saveError || state.phase !== 'reward') return;
  try { growthCard = id; void commit(act(bundle.config, state, { type: 'reward', cardId: id })); }
  catch { growthCard = null; notice = 'choose'; render(); }
}
function pause() { if (!menu) { paused = true; render(); } }
window.addEventListener('blur', pause);
function appendSaveStatus() {
  if (saveError) {
    root.append(element('p', 'notice', t(saveError)));
    const controls = element('div', 'controls');
    controls.append(button(t('reload'), () => { void load(); }, 'secondary'));
    controls.append(button(t('unsaved'), () => { volatile = true; saveError = ''; render(); }, 'secondary'));
    root.append(controls);
  }
  root.append(element('p', 'save-status', saving ? t('saving') : volatile ? t('unsavedNote') : t('saved') + bundle.config.gameVersion));
}
function cardButton(id, reward = false, index = 0) {
  const card = bundle.config.cards.find(row => row.id === id);
  const copy = bundle.copy.cards.find(row => row.id === id);
  const node = button('', () => reward ? chooseReward(id) : playCard(id), reward ? 'reward' : 'card');
  node.dataset.card = id;
  node.setAttribute('aria-pressed', String(selectedCard === id));
  node.setAttribute('aria-label', `${localized(copy.name)}. ${localized(copy.description)}`);
  const imageBinding = bundle.art.cardImages?.find(row => row.id === id);
  if (imageBinding && assetUrls.has(imageBinding.assetId)) {
    const image = element('img', 'card-art'); image.src = assetUrls.get(imageBinding.assetId);
    image.alt = ''; image.width = 512; image.height = 512; node.append(image);
  }
  node.append(element('strong', '', (!reward ? `${index + 1}. ` : '') + localized(copy.name)));
  node.append(element('span', 'description', localized(copy.description)));
  const chips = element('span', 'effect-chips');
  for (const [key, amount] of Object.entries(card.effect).filter(([, n]) => n > 0)) chips.append(element('span', 'effect gain', `${statSymbols[key]} +${amount}`));
  for (const [key, amount] of Object.entries(card.cost).filter(([, n]) => n > 0)) chips.append(element('span', 'effect cost', `${statSymbols[key]} −${amount}`));
  if (!chips.children.length) chips.append(element('span', 'effect gain', '◆ 0'));
  node.append(chips);
  node.disabled = saving || Boolean(saveError) || (!reward && Object.entries(card.cost).some(([key, n]) => n > state.stats[key]));
  return node;
}
function render() {
  if (!bundle) return;
  root.replaceChildren(); document.documentElement.lang = locale;
  root.dataset.phase = view === 'help' ? 'help' : view === 'growth' ? 'growth' : paused ? 'paused' : menu ? 'menu' : state?.phase || 'menu';
  const top = element('div', 'topbar'); top.append(element('p', 'eyebrow', 'YOURGA.ME / ROGUELIKE 01'));
  const topControls = element('div', 'top-controls');
  topControls.append(button(t('fullscreen'), toggleFullscreen, 'icon-button'));
  if (view !== 'help') topControls.append(button(t('help'), () => { view = 'help'; helpPage = 0; render(); }, 'icon-button'));
  if (!menu && !paused && view === 'main') topControls.append(button(t('pause'), pause, 'icon-button'));
  top.append(topControls);
  root.append(top);
  if (view === 'help') {
    const pages = helpPages[locale], page = pages[helpPage];
    const area = element('section', 'help-page');
    area.append(element('p', 'section-label', `${t('page')} ${helpPage + 1} / ${pages.length}`),
      element('h1', '', page[0]), element('p', 'help-copy', page[1]));
    if (helpPage === pages.length - 1) area.append(element('p', 'disclaimer', localized(bundle.copy.disclaimer)));
    const controls = element('div', 'page-controls');
    const previous = button(t('back'), () => { helpPage--; render(); }, 'secondary'); previous.disabled = helpPage === 0;
    controls.append(previous);
    if (helpPage < pages.length - 1) controls.append(button(t('next'), () => { helpPage++; render(); }));
    else controls.append(button(t('close'), () => { view = 'main'; render(); }));
    area.append(controls); root.append(area); return;
  }
  if (paused) {
    const area = element('section', 'paused');
    const resume = button(t('resume'), () => { if (!locked) { paused = false; render(); } }); resume.disabled = locked;
    area.append(element('div', 'result-symbol', 'Ⅱ'), element('h2', '', t('paused')), element('p', 'description', t('pauseNote')), resume);
    root.append(area); appendSaveStatus(); return;
  }
  if (menu) {
    root.append(element('h1', '', localized(bundle.copy.title)), element('p', 'subtitle', localized(bundle.copy.subtitle)),
      element('p', 'section-label', t('chooseHero')));
    const heroes = element('div', 'heroes');
    const heroPages = Math.ceil(bundle.copy.heroes.length / 4);
    for (const hero of bundle.copy.heroes.slice(heroPage * 4, heroPage * 4 + 4)) {
      const node = button('', () => { heroId = hero.id; render(); }, 'hero');
      node.dataset.hero = hero.id; node.setAttribute('aria-pressed', String(heroId === hero.id));
      node.disabled = Boolean(state && state.phase !== 'victory' && state.phase !== 'defeat');
      const icon = bundle.art.heroIcons.find(row => row.id === hero.id).icon;
      node.append(element('span', 'hero-icon', symbols[icon]), element('span', 'hero-name', localized(hero.name)), element('span', 'hero-role', localized(hero.role)));
      heroes.append(node);
    }
    root.append(heroes);
    if (heroPages > 1) {
      const controls = element('div', 'page-controls');
      const previous = button(t('back'), () => { heroPage--; render(); }, 'secondary'); previous.disabled = heroPage === 0;
      const next = button(t('next'), () => { heroPage++; render(); }, 'secondary'); next.disabled = heroPage === heroPages - 1;
      controls.append(previous, element('span', 'page-count', `${heroPage + 1} / ${heroPages}`), next); root.append(controls);
    }
    if (state) root.append(button(t('continue'), () => { menu = false; render(); }));
    if (!state || ['victory', 'defeat'].includes(state.phase)) {
      const start = button(t('start'), () => { void commit(init(bundle.config, newSeed(), heroId)); });
      start.disabled = saving || Boolean(saveError); root.append(start);
    }
    appendSaveStatus(); return;
  }
  const stats = element('div', 'stats');
  for (const key of ['health', 'food', 'gold', 'morale']) {
    const stat = element('div', 'stat'); stat.dataset.stat = key;
    stat.append(element('strong', '', String(state.stats[key])), element('span', '', t(key))); stats.append(stat);
  }
  root.append(stats);
  if (view === 'growth') {
    const card = bundle.copy.cards.find(row => row.id === growthCard);
    const area = element('section', 'growth-page');
    area.append(element('div', 'result-symbol', '✦'), element('h1', '', t('growth')),
      element('p', 'description', t('growthReady')),
      element('strong', 'growth-card-name', card ? localized(card.name) : ''),
      element('p', 'growth-total', `${t('cardsGained')} ${state.acquired.length}`),
      button(t('close'), () => { growthCard = null; view = 'main'; render(); }));
    root.append(area); appendSaveStatus(); return;
  }
  if (state.phase === 'victory' || state.phase === 'defeat') {
    const win = state.phase === 'victory';
    root.append(element('div', 'result-symbol', win ? '♔' : '✧'), element('h1', '', t(win ? 'win' : 'lose')),
      element('p', 'story', localized(bundle.copy[win ? 'victory' : 'defeat'])),
      element('p', 'description', `${t('turn')} ${Math.min(state.wave + 1, bundle.config.waves.length)} / ${bundle.config.waves.length} · ${t('seed')} ${state.seed}`),
      button(t('retry'), () => { void commit(retry(bundle.config, state, newSeed())); }));
  } else if (state.phase === 'reward') {
    root.append(element('h2', '', t('reward')), element('p', 'description', t('rewardHint')));
    const rewards = element('div', 'reward-list');
    state.rewardChoices.forEach(id => rewards.append(cardButton(id, true))); root.append(rewards);
  } else {
    root.append(element('p', 'section-label', `${t('turn')} ${state.wave + 1} / ${bundle.config.waves.length}`),
      element('h2', 'wave-title', localized(bundle.copy.waves[state.wave].title)),
      element('p', 'growth-strip', `${t('cardsGained')} ${state.acquired.length} · ${state.acquired.map(id => localized(bundle.copy.cards.find(card => card.id === id).name)).join(' · ') || '—'}`));
    const board = element('div', 'board');
    for (let tileId = 0; tileId < 7; tileId++) {
      const strength = state.incoming.filter(attack => attack.tileId === tileId)
        .reduce((sum, attack) => sum + bundle.config.enemies.find(enemy => enemy.id === attack.enemyId).strength, 0);
      const hex = button('', () => {
        selectedTile = tileId;
        if (selectedCard) take({ type: 'play', cardId: selectedCard, tileId }); else render();
      }, 'hex' + (tileId === selectedTile ? ' selected' : '') + (strength ? ' threat' : ''));
      hex.dataset.tile = String(tileId); hex.disabled = saving || Boolean(saveError);
      hex.setAttribute('aria-label', `${t('tile')} ${tileId + 1}, ${t('defense')} ${state.tiles[tileId]}, ${t('incoming')} ${strength}`);
      hex.append(element('small', '', `${tileId === 0 ? '♔' : '⬡'} ${tileId + 1}`), element('strong', '', String(state.tiles[tileId])),
        element('small', '', strength ? `↓ ${strength}` : '·')); board.append(hex);
    }
    root.append(board, element('p', 'threat-label', `${t('incoming')}: ${state.incoming.map(attack => {
      const enemy = bundle.config.enemies.find(row => row.id === attack.enemyId);
      return `⚔ ${enemy.strength}→${attack.tileId + 1}`;
    }).join(' · ')} / ${statSymbols.food} −${bundle.config.waves[state.wave].foodCost}`),
      element('p', 'section-label', t('hand')));
    const hand = element('div', 'hand'); state.hand.forEach((id, index) => hand.append(cardButton(id, false, index))); root.append(hand);
    root.append(element('p', 'notice', t(notice || 'choose')));
    const end = button(t('defend'), () => take({ type: 'endTurn' })); end.dataset.action = 'endTurn'; end.disabled = saving || Boolean(saveError); root.append(end);
  }
  appendSaveStatus();
}
document.addEventListener('keydown', event => {
  if (!ready || saving || saveError) return;
  if (view === 'help' && event.key === 'Escape') { view = 'main'; render(); return; }
  if (view === 'growth' && event.key === 'Escape') { growthCard = null; view = 'main'; render(); return; }
  if (menu || view !== 'main') return;
  if (event.key === 'Escape') { if (!locked) paused = !paused; render(); return; }
  if (paused || state.phase !== 'playing') return;
  if (/^[1-8]$/.test(event.key)) { const id = state.hand[Number(event.key) - 1]; if (id) { event.preventDefault(); playCard(id); } }
  else if (event.key.startsWith('Arrow')) { event.preventDefault(); selectedTile = (selectedTile + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? 6 : 1)) % 7; render(); }
  else if (event.key === 'Enter' && selectedCard) { event.preventDefault(); take({ type: 'play', cardId: selectedCard, tileId: selectedTile }); }
  else if (event.key === ' ' && event.target === document.body) { event.preventDefault(); take({ type: 'endTurn' }); }
});
window.addEventListener('pagehide', () => { for (const url of assetUrls.values()) URL.revokeObjectURL(url); assetUrls.clear(); });
window.addEventListener('message', async event => {
  if (port || event.source !== parent || event.data?.type !== 'runtime:init' || event.data.protocol !== 1 || event.ports.length !== 1) return;
  try { bundle = validateGameBundle(event.data.bundle); await loadAssets(event.data.assets || []); } catch { return; }
  locale = event.data.locale === 'ko' ? 'ko' : 'en'; heroId = bundle.config.heroes[0].id;
  // Palette values are fixed hex strings. They are never inserted into markup.
  for (const key of ['background', 'panel', 'accent', 'ink', 'muted']) document.documentElement.style.setProperty('--' + key, bundle.art[key]);
  port = event.ports[0];
  port.addEventListener('message', ({ data }) => {
    if (data?.protocol !== 1) return;
    if (data.type === 'runtime:pause') pause();
    else if (data.type === 'runtime:availability') { locked = data.active !== true; if (locked) paused = true; render(); }
    else if (data.type === 'runtime:locale' && ['en', 'ko'].includes(data.locale)) { locale = data.locale; render(); }
    else if (data.type === 'save:result' && data.gameVersion === bundle.config.gameVersion && pending.has(data.requestId)) {
      const waiter = pending.get(data.requestId); clearTimeout(waiter.timeout); pending.delete(data.requestId);
      if (data.ok) waiter.resolve(data.record); else waiter.reject(new Error(data.error));
    }
  });
  port.start(); void load();
}, { once: false });
