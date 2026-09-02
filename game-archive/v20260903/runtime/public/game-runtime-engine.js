// Trusted, dependency-free rules interpreter. Configuration is data, never code.
// This module contains no production scenario, UI, storage, networking, or account access.
export const GAME_RUNTIME_LIMITS = Object.freeze({ tiles: 7, heroes: 6, cards: 8, enemies: 8, waves: 8, stat: 999 });
const STATS = ['health', 'food', 'gold', 'morale'];
const RESOURCES = ['food', 'gold', 'morale'];
const ID = /^[a-z][a-z0-9-]{0,47}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export class GameRuntimeError extends Error {
  constructor(code) { super(code); this.name = 'GameRuntimeError'; this.code = code; }
}
function ensure(condition, code = 'GAME_CONFIG_INVALID') {
  if (!condition) throw new GameRuntimeError(code);
}
function integer(value, min, max, code) {
  ensure(Number.isSafeInteger(value) && value >= min && value <= max, code);
  return value;
}
function fields(value, keys, code) {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), code);
  ensure([Object.prototype, null].includes(Object.getPrototypeOf(value)), code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  ensure(Reflect.ownKeys(descriptors).length === keys.length, code);
  const result = {};
  for (const key of keys) {
    ensure(descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'), code);
    result[key] = descriptors[key].value;
  }
  return result;
}
function list(value, min, max, read, code) {
  ensure(Array.isArray(value), code);
  integer(value.length, min, max, code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  ensure(Reflect.ownKeys(descriptors).length === value.length + 1, code);
  return Array.from({ length: value.length }, (_, index) => {
    const item = descriptors[index];
    ensure(item?.enumerable && Object.hasOwn(item, 'value'), code);
    return read(item.value);
  });
}
function identifier(value, code) { ensure(typeof value === 'string' && ID.test(value), code); return value; }
function amounts(value, names, code) {
  const result = fields(value, names, code);
  for (const name of names) integer(result[name], 0, GAME_RUNTIME_LIMITS.stat, code);
  return result;
}
function uniqueIds(items) { ensure(new Set(items.map(item => item.id)).size === items.length); return items; }

// Unknown fields, accessors, executable values, invalid references and nonfinite
// numbers are rejected. Returned key order is canonical for exact save binding.
export function validateGameConfig(value) {
  const source = fields(value, ['schemaVersion', 'gameVersion', 'handSize', 'heroes', 'cards', 'enemies', 'waves']);
  ensure(source.schemaVersion === 1);
  ensure(typeof source.gameVersion === 'string' && VERSION.test(source.gameVersion));
  const handSize = integer(source.handSize, 1, 8);
  const cards = uniqueIds(list(source.cards, 1, GAME_RUNTIME_LIMITS.cards, item => {
    const card = fields(item, ['id', 'cost', 'effect']);
    return { id: identifier(card.id), cost: amounts(card.cost, RESOURCES), effect: amounts(card.effect, [...STATS, 'defense']) };
  }));
  const cardIds = new Set(cards.map(card => card.id));
  const heroes = uniqueIds(list(source.heroes, 1, GAME_RUNTIME_LIMITS.heroes, item => {
    const hero = fields(item, ['id', 'stats', 'deck']);
    const stats = amounts(hero.stats, STATS);
    ensure(stats.health > 0 && stats.morale > 0);
    const deck = list(hero.deck, 1, 40, id => { ensure(cardIds.has(id)); return id; });
    return { id: identifier(hero.id), stats, deck };
  }));
  const enemies = uniqueIds(list(source.enemies, 1, GAME_RUNTIME_LIMITS.enemies, item => {
    const enemy = fields(item, ['id', 'strength']);
    return { id: identifier(enemy.id), strength: integer(enemy.strength, 1, GAME_RUNTIME_LIMITS.stat) };
  }));
  const enemyIds = new Set(enemies.map(enemy => enemy.id));
  const waves = list(source.waves, 1, GAME_RUNTIME_LIMITS.waves, item => {
    const wave = fields(item, ['enemies', 'foodCost', 'reward']);
    return {
      enemies: list(wave.enemies, 1, 16, id => { ensure(enemyIds.has(id)); return id; }),
      foodCost: integer(wave.foodCost, 0, GAME_RUNTIME_LIMITS.stat),
      reward: amounts(wave.reward, RESOURCES),
    };
  });
  return { schemaVersion: 1, gameVersion: source.gameVersion, handSize, heroes, cards, enemies, waves };
}

// Mulberry32 uses only specified 32-bit operations and accepts seed zero.
// PRNG state lives in the save; no Math.random(), time, or ambient entropy.
function random(state) {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let mixed = state.rng;
  mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
  mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
  return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
}
function shuffle(state, cards) {
  const result = [...cards];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random(state) * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}
function drawWave(config, state) {
  state.phase = 'playing';
  while (state.hand.length < config.handSize) {
    if (state.drawPile.length === 0) {
      if (state.discard.length === 0) break;
      state.drawPile = shuffle(state, state.discard);
      state.discard = [];
    }
    state.hand.push(state.drawPile.pop());
  }
  state.incoming = config.waves[state.wave].enemies.map(enemyId => ({
    enemyId, tileId: Math.floor(random(state) * GAME_RUNTIME_LIMITS.tiles),
  }));
}
function clearHand(state) { state.discard.push(...state.hand); state.hand = []; }
function finish(state, phase) { clearHand(state); state.incoming = []; state.rewardChoices = []; state.phase = phase; }
function heroFor(config, heroId) { return config.heroes.find(hero => hero.id === heroId); }

export function init(value, seed, heroId) {
  const config = validateGameConfig(value);
  integer(seed, 0, 0xffffffff, 'GAME_SEED_INVALID');
  const hero = heroFor(config, heroId);
  ensure(hero, 'GAME_HERO_INVALID');
  const state = {
    schemaVersion: 1, gameVersion: config.gameVersion, configKey: JSON.stringify(config),
    heroId, seed, rng: seed, wave: 0, phase: 'playing', stats: { ...hero.stats },
    tiles: Array(GAME_RUNTIME_LIMITS.tiles).fill(0), drawPile: [], hand: [], discard: [],
    acquired: [], incoming: [], rewardChoices: [],
  };
  state.drawPile = shuffle(state, hero.deck);
  drawWave(config, state);
  return state;
}

function restoreState(config, value) {
  const code = 'GAME_STATE_INVALID';
  const state = fields(value, ['schemaVersion', 'gameVersion', 'configKey', 'heroId', 'seed', 'rng', 'wave', 'phase',
    'stats', 'tiles', 'drawPile', 'hand', 'discard', 'acquired', 'incoming', 'rewardChoices'], code);
  ensure(state.schemaVersion === 1, code);
  ensure(state.gameVersion === config.gameVersion && state.configKey === JSON.stringify(config), 'GAME_VERSION_MISMATCH');
  const hero = heroFor(config, state.heroId);
  ensure(hero, code);
  integer(state.seed, 0, 0xffffffff, code);
  integer(state.rng, 0, 0xffffffff, code);
  integer(state.wave, 0, config.waves.length, code);
  ensure(['playing', 'reward', 'victory', 'defeat'].includes(state.phase), code);
  state.stats = amounts(state.stats, STATS, code);
  ensure(state.stats.health <= hero.stats.health, code);
  state.tiles = list(state.tiles, GAME_RUNTIME_LIMITS.tiles, GAME_RUNTIME_LIMITS.tiles,
    amount => integer(amount, 0, GAME_RUNTIME_LIMITS.stat, code), code);
  const cardIds = new Set(config.cards.map(card => card.id));
  const readCard = id => { ensure(cardIds.has(id), code); return id; };
  state.drawPile = list(state.drawPile, 0, 47, readCard, code);
  state.hand = list(state.hand, 0, config.handSize, readCard, code);
  state.discard = list(state.discard, 0, 47, readCard, code);
  state.acquired = list(state.acquired, 0, config.waves.length - 1, readCard, code);
  state.rewardChoices = list(state.rewardChoices, 0, 3, readCard, code);
  ensure(new Set(state.rewardChoices).size === state.rewardChoices.length, code);
  // Card multiset conservation catches missing, fabricated, and duplicate cards.
  const actual = [...state.drawPile, ...state.hand, ...state.discard].sort();
  const expected = [...hero.deck, ...state.acquired].sort();
  ensure(JSON.stringify(actual) === JSON.stringify(expected), code);
  const terminal = state.phase === 'victory' || state.phase === 'defeat';
  ensure(state.phase === 'victory' ? state.wave === config.waves.length : state.wave < config.waves.length, code);
  ensure(state.phase === 'defeat' ? state.stats.health === 0 || state.stats.morale === 0
    : state.stats.health > 0 && state.stats.morale > 0, code);
  if (state.phase === 'reward') {
    ensure(state.wave > 0 && state.rewardChoices.length === Math.min(3, config.cards.length), code);
    ensure(state.acquired.length === state.wave - 1, code);
  } else {
    ensure(state.rewardChoices.length === 0, code);
    ensure(state.acquired.length === (state.phase === 'victory' ? state.wave - 1 : state.wave), code);
  }
  if (state.phase !== 'playing') ensure(state.hand.length === 0, code);
  const incomingIds = state.phase === 'playing' ? config.waves[state.wave].enemies : [];
  state.incoming = list(state.incoming, incomingIds.length, incomingIds.length, item => {
    const attack = fields(item, ['enemyId', 'tileId'], code);
    integer(attack.tileId, 0, GAME_RUNTIME_LIMITS.tiles - 1, code);
    return attack;
  }, code);
  state.incoming.forEach((attack, index) => ensure(attack.enemyId === incomingIds[index], code));
  if (terminal) ensure(state.incoming.length === 0, code);
  return state;
}

// Validates compatibility/invariants, not authenticity or competitive anti-cheat.
// Finished states are restored as finished; nothing silently retries or resets.
export function restore(value, savedState) { return restoreState(validateGameConfig(value), savedState); }

export function act(value, previous, action) {
  const config = validateGameConfig(value);
  const state = restoreState(config, previous);
  const actionCode = 'GAME_ACTION_INVALID';
  // Read the discriminant through its descriptor without invoking getters.
  ensure(action !== null && typeof action === 'object', actionCode);
  const type = Object.getOwnPropertyDescriptor(action, 'type')?.value;
  ensure(['play', 'endTurn', 'reward'].includes(type), actionCode);
  ensure(state.phase === 'playing' || state.phase === 'reward', 'GAME_PHASE_INVALID');
  if (type === 'reward') {
    const choice = fields(action, ['type', 'cardId'], actionCode);
    ensure(state.phase === 'reward', 'GAME_PHASE_INVALID');
    ensure(state.rewardChoices.includes(choice.cardId), 'GAME_CARD_UNAVAILABLE');
    state.acquired.push(choice.cardId);
    state.discard.push(choice.cardId);
    state.rewardChoices = [];
    drawWave(config, state);
    return state;
  }
  ensure(state.phase === 'playing', 'GAME_PHASE_INVALID');
  if (type === 'play') {
    const hasTile = Object.hasOwn(action, 'tileId');
    const play = fields(action, hasTile ? ['type', 'cardId', 'tileId'] : ['type', 'cardId'], actionCode);
    const index = state.hand.indexOf(play.cardId);
    ensure(index >= 0, 'GAME_CARD_UNAVAILABLE');
    const card = config.cards.find(item => item.id === play.cardId);
    if (card.effect.defense > 0 || hasTile) integer(play.tileId, 0, GAME_RUNTIME_LIMITS.tiles - 1, actionCode);
    for (const resource of RESOURCES) ensure(state.stats[resource] >= card.cost[resource], 'GAME_COST_UNAVAILABLE');
    for (const resource of RESOURCES) state.stats[resource] -= card.cost[resource];
    for (const stat of STATS) state.stats[stat] = Math.min(stat === 'health' ? heroFor(config, state.heroId).stats.health
      : GAME_RUNTIME_LIMITS.stat, state.stats[stat] + card.effect[stat]);
    if (card.effect.defense > 0) state.tiles[play.tileId] = Math.min(GAME_RUNTIME_LIMITS.stat, state.tiles[play.tileId] + card.effect.defense);
    state.hand.splice(index, 1);
    state.discard.push(card.id);
    if (state.stats.morale === 0) finish(state, 'defeat');
    return state;
  }
  fields(action, ['type'], actionCode);
  const wave = config.waves[state.wave];
  const shortage = Math.max(0, wave.foodCost - state.stats.food);
  state.stats.food = Math.max(0, state.stats.food - wave.foodCost);
  state.stats.health = Math.max(0, state.stats.health - shortage);
  for (const attack of state.incoming) {
    const strength = config.enemies.find(enemy => enemy.id === attack.enemyId).strength;
    const overflow = Math.max(0, strength - state.tiles[attack.tileId]);
    state.tiles[attack.tileId] = Math.max(0, state.tiles[attack.tileId] - strength);
    state.stats.health = Math.max(0, state.stats.health - overflow);
  }
  if (state.stats.health === 0 || state.stats.morale === 0) {
    finish(state, 'defeat');
    return state;
  }
  for (const resource of RESOURCES) state.stats[resource] = Math.min(GAME_RUNTIME_LIMITS.stat, state.stats[resource] + wave.reward[resource]);
  clearHand(state);
  state.incoming = [];
  state.wave += 1;
  if (state.wave === config.waves.length) finish(state, 'victory');
  else {
    state.phase = 'reward';
    state.rewardChoices = shuffle(state, config.cards.map(card => card.id)).slice(0, 3);
  }
  return state;
}

export function retry(value, previous, newSeed) {
  const config = validateGameConfig(value);
  const state = restoreState(config, previous);
  ensure(['victory', 'defeat'].includes(state.phase), 'GAME_PHASE_INVALID');
  integer(newSeed, 0, 0xffffffff, 'GAME_SEED_INVALID');
  ensure(newSeed !== state.seed, 'GAME_SEED_INVALID');
  return init(config, newSeed, state.heroId);
}
