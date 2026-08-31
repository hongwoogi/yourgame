import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_RUNTIME_LIMITS, GameRuntimeError, validateGameConfig, init, restore, act, retry,
} from '../public/game-runtime-engine.js';

// Synthetic rules fixtures only. These are not generated or approved game content.
const zeroCost = () => ({ food: 0, gold: 0, morale: 0 });
const effect = (values = {}) => ({ health: 0, food: 0, gold: 0, morale: 0, defense: 0, ...values });
function fixture() {
  return {
    schemaVersion: 1, gameVersion: 'engine-fixture-v1', handSize: 4,
    heroes: [
      { id: 'hero-a', stats: { health: 20, food: 5, gold: 5, morale: 5 }, deck: ['guard', 'forage', 'heal', 'tax'] },
      { id: 'hero-b', stats: { health: 12, food: 7, gold: 2, morale: 6 }, deck: ['guard', 'guard', 'forage'] },
    ],
    cards: [
      { id: 'guard', cost: { ...zeroCost(), gold: 1 }, effect: effect({ defense: 4 }) },
      { id: 'forage', cost: zeroCost(), effect: effect({ food: 2, morale: 1 }) },
      { id: 'heal', cost: { ...zeroCost(), food: 1 }, effect: effect({ health: 3 }) },
      { id: 'tax', cost: { ...zeroCost(), morale: 1 }, effect: effect({ gold: 3 }) },
    ],
    enemies: [{ id: 'attack-a', strength: 3 }],
    waves: [
      { enemies: ['attack-a'], foodCost: 1, reward: { food: 0, gold: 1, morale: 0 } },
      { enemies: ['attack-a', 'attack-a'], foodCost: 1, reward: { food: 0, gold: 1, morale: 0 } },
      { enemies: ['attack-a'], foodCost: 1, reward: { food: 0, gold: 1, morale: 1 } },
    ],
  };
}
const code = expected => error => error instanceof GameRuntimeError && error.code === expected && error.message === expected;
function freeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return value;
}
function finishRun(config, seed = 42, heroId = 'hero-a') {
  let state = init(config, seed, heroId);
  for (let count = 0; count < 20 && ['playing', 'reward'].includes(state.phase); count += 1) {
    state = act(config, state, state.phase === 'reward'
      ? { type: 'reward', cardId: state.rewardChoices[0] } : { type: 'endTurn' });
  }
  return state;
}

test('configuration is canonical data with strict entity and size limits', () => {
  const original = fixture();
  const canonical = validateGameConfig(original);
  assert.deepEqual(canonical, original);
  canonical.heroes[0].stats.health = 2;
  assert.equal(original.heroes[0].stats.health, 20);
  assert.equal(GAME_RUNTIME_LIMITS.tiles, 7);
  assert.equal(GAME_RUNTIME_LIMITS.heroes, 6);
  assert.equal(GAME_RUNTIME_LIMITS.cards, 8);
  assert.equal(GAME_RUNTIME_LIMITS.waves, 8);
});

test('unknown fields, invalid references, duplicate ids, and out-of-range values fail closed', () => {
  const invalid = [
    c => { c.execute = 'do not execute'; },
    c => { c.gameVersion = '../fixture'; },
    c => { c.schemaVersion = 2; },
    c => { c.handSize = 9; },
    c => { c.heroes[0].stats.health = 0; },
    c => { c.heroes[0].stats.morale = 0; },
    c => { c.heroes[0].stats.gold = -1; },
    c => { c.heroes[0].deck = ['missing']; },
    c => { c.heroes[1].id = c.heroes[0].id; },
    c => { c.cards[0].id = 'javascript:run'; },
    c => { c.cards[1].id = c.cards[0].id; },
    c => { c.cards[0].effect.defense = Infinity; },
    c => { c.cards[0].cost.gold = 0.5; },
    c => { c.enemies[0].strength = 1000; },
    c => { c.waves[0].enemies = ['missing']; },
    c => { c.waves[0].foodCost = '1'; },
    c => { c.waves = []; },
    c => { c.waves = Array(9).fill(c.waves[0]); },
    c => { c.waves[0].enemies = Array(17).fill('attack-a'); },
    c => { c.cards = Array(9).fill(c.cards[0]); },
    c => { c.heroes[0].deck = Array(41).fill('guard'); },
  ];
  for (const mutate of invalid) {
    const config = fixture();
    mutate(config);
    assert.throws(() => validateGameConfig(config), code('GAME_CONFIG_INVALID'));
  }
});

test('configuration getters, functions, sparse arrays, and custom objects are never interpreted', () => {
  let calls = 0;
  const getter = fixture();
  Object.defineProperty(getter.cards[0].effect, 'health', { enumerable: true, get() { calls += 1; return 3; } });
  assert.throws(() => validateGameConfig(getter), code('GAME_CONFIG_INVALID'));
  const method = fixture();
  method.cards[0].effect.health = () => { calls += 1; return 3; };
  assert.throws(() => validateGameConfig(method), code('GAME_CONFIG_INVALID'));
  const sparse = fixture();
  delete sparse.heroes[0].deck[1];
  assert.throws(() => validateGameConfig(sparse), code('GAME_CONFIG_INVALID'));
  const custom = fixture();
  custom.heroes[0].stats = new Date();
  assert.throws(() => validateGameConfig(custom), code('GAME_CONFIG_INVALID'));
  assert.equal(calls, 0);
});

test('same configuration, seed and hero reproduce initialization and the entire run', () => {
  const config = freeze(fixture());
  assert.deepEqual(init(config, 42, 'hero-a'), init(config, 42, 'hero-a'));
  assert.deepEqual(finishRun(config), finishRun(config));
  const signatures = new Set(Array.from({ length: 16 }, (_, seed) => {
    const state = init(config, seed, 'hero-a');
    return JSON.stringify([state.hand, state.incoming]);
  }));
  assert.ok(signatures.size > 1);
  assert.deepEqual(init(config, 0, 'hero-a'), init(config, 0, 'hero-a'));
});

test('seed and hero selection are explicit and validated', () => {
  const config = fixture();
  for (const seed of [undefined, -1, 2 ** 32, 1.5, '42', NaN]) {
    assert.throws(() => init(config, seed, 'hero-a'), code('GAME_SEED_INVALID'));
  }
  assert.throws(() => init(config, 1, 'unknown'), code('GAME_HERO_INVALID'));
  const heroB = init(config, 0xffffffff, 'hero-b');
  assert.deepEqual(heroB.stats, config.heroes[1].stats);
  assert.equal(heroB.hand.length, 3);
});

test('play consumes an owned hand card and cost, applies one chosen defense tile, and does not mutate inputs', () => {
  const config = freeze(fixture());
  const previous = freeze(init(config, 42, 'hero-a'));
  const before = JSON.stringify(previous);
  const action = freeze({ type: 'play', cardId: 'guard', tileId: 2 });
  const next = act(config, previous, action);
  assert.equal(JSON.stringify(previous), before);
  assert.equal(next.stats.gold, previous.stats.gold - 1);
  assert.deepEqual(next.tiles, [0, 0, 4, 0, 0, 0, 0]);
  assert.equal(next.hand.includes('guard'), false);
  assert.deepEqual(next.discard, ['guard']);
  assert.throws(() => act(config, next, action), code('GAME_CARD_UNAVAILABLE'));
  assert.notEqual(next.stats, previous.stats);
});

test('unaffordable or malformed actions leave the previous save unchanged', () => {
  const config = fixture();
  config.heroes[0].stats.gold = 0;
  const state = freeze(init(config, 9, 'hero-a'));
  const before = JSON.stringify(state);
  assert.throws(() => act(config, state, { type: 'play', cardId: 'guard', tileId: 0 }), code('GAME_COST_UNAVAILABLE'));
  for (const action of [{ type: 'run', command: 'never' }, { type: 'endTurn', extra: 1 },
    { type: 'play', cardId: 'guard' }, { type: 'play', cardId: 'guard', tileId: 7 },
    { type: 'play', cardId: 'guard', tileId: -1 }, { type: 'play', cardId: 'guard', tileId: 1.2 }]) {
    assert.throws(() => act(config, state, action), code('GAME_ACTION_INVALID'));
  }
  assert.equal(JSON.stringify(state), before);
});

test('defense absorbs attacks and only overflow reaches kingdom health', () => {
  const config = fixture();
  let state = init(config, 42, 'hero-a');
  const target = state.incoming[0].tileId;
  state = act(config, state, { type: 'play', cardId: 'guard', tileId: target });
  state = act(config, state, { type: 'endTurn' });
  assert.equal(state.stats.health, 20);
  assert.equal(state.tiles[target], 1);
  assert.equal(state.stats.food, 4);
  assert.equal(state.stats.gold, 5);
  assert.equal(state.phase, 'reward');
  const undefended = act(config, init(config, 42, 'hero-a'), { type: 'endTurn' });
  assert.equal(undefended.stats.health, 17);
});

test('food shortages reduce health and defeated waves do not pay rewards', () => {
  const config = fixture();
  config.heroes[0].stats.health = 3;
  config.heroes[0].stats.food = 0;
  config.waves[0].foodCost = 4;
  const state = act(config, init(config, 3, 'hero-a'), { type: 'endTurn' });
  assert.equal(state.phase, 'defeat');
  assert.equal(state.stats.health, 0);
  assert.equal(state.stats.food, 0);
  assert.equal(state.stats.gold, 5);
  assert.equal(state.wave, 0);
  assert.deepEqual(state.hand, []);
  assert.deepEqual(state.incoming, []);
});

test('spending the last morale point defeats the kingdom without silently resetting it', () => {
  const config = fixture();
  config.heroes[0].stats.morale = 1;
  const state = act(config, init(config, 42, 'hero-a'), { type: 'play', cardId: 'tax' });
  assert.equal(state.phase, 'defeat');
  assert.equal(state.stats.morale, 0);
  assert.equal(state.stats.gold, 8);
  assert.deepEqual(restore(config, JSON.parse(JSON.stringify(state))), state);
});

test('seeded reward choices require an explicit selection and add exactly one card to the growing deck', () => {
  const config = fixture();
  const previous = act(config, init(config, 42, 'hero-a'), { type: 'endTurn' });
  assert.equal(previous.wave, 1);
  assert.equal(previous.phase, 'reward');
  assert.equal(new Set(previous.rewardChoices).size, 3);
  assert.deepEqual(previous.hand, []);
  assert.deepEqual(previous.incoming, []);
  assert.throws(() => act(config, previous, { type: 'endTurn' }), code('GAME_PHASE_INVALID'));
  const missing = config.cards.find(card => !previous.rewardChoices.includes(card.id)).id;
  assert.throws(() => act(config, previous, { type: 'reward', cardId: missing }), code('GAME_CARD_UNAVAILABLE'));
  const choice = previous.rewardChoices[0];
  const next = act(config, freeze(previous), { type: 'reward', cardId: choice });
  assert.equal(next.phase, 'playing');
  assert.deepEqual(next.acquired, [choice]);
  assert.equal(next.drawPile.length + next.hand.length + next.discard.length, 5);
  assert.equal(next.hand.length, 4);
  assert.deepEqual(next.rewardChoices, []);
  assert.equal(next.incoming.length, 2);
  assert.throws(() => act(config, next, { type: 'reward', cardId: choice }), code('GAME_PHASE_INVALID'));
});

test('one defined card yields one offer without duplicates or invented cards', () => {
  const config = fixture();
  config.cards = [config.cards[0]];
  config.heroes = [{ ...config.heroes[0], deck: ['guard'] }];
  const reward = act(config, init(config, 1, 'hero-a'), { type: 'endTurn' });
  assert.deepEqual(reward.rewardChoices, ['guard']);
  assert.deepEqual(restore(config, reward), reward);
});

test('healing, resources and tile defenses remain within finite limits', () => {
  const config = fixture();
  config.heroes[0].stats.food = 998;
  config.heroes[0].deck = ['guard', 'guard', 'forage', 'heal'];
  config.cards[0].effect.defense = 999;
  config.cards[1].effect.food = 999;
  config.cards[2].effect.health = 999;
  let state = init(config, 11, 'hero-a');
  state = act(config, state, { type: 'play', cardId: 'guard', tileId: 0 });
  state = act(config, state, { type: 'play', cardId: 'guard', tileId: 0 });
  state = act(config, state, { type: 'play', cardId: 'forage' });
  assert.equal(state.tiles[0], 999);
  assert.equal(state.stats.food, 999);
  state = act(config, state, { type: 'play', cardId: 'heal' });
  assert.equal(state.stats.health, 20);
  assert.deepEqual(restore(config, state), state);
});

test('victory remains finished across reload and replay needs a different explicit seed', () => {
  const config = fixture();
  const finished = finishRun(config);
  assert.equal(finished.phase, 'victory');
  assert.equal(finished.wave, config.waves.length);
  assert.equal(finished.acquired.length, config.waves.length - 1);
  assert.deepEqual(restore(config, JSON.parse(JSON.stringify(finished))), finished);
  assert.throws(() => act(config, finished, { type: 'endTurn' }), code('GAME_PHASE_INVALID'));
  assert.throws(() => retry(config, finished), code('GAME_SEED_INVALID'));
  assert.throws(() => retry(config, finished, finished.seed), code('GAME_SEED_INVALID'));
  assert.throws(() => retry(config, init(config, 1, 'hero-a'), 2), code('GAME_PHASE_INVALID'));
  const original = JSON.stringify(finished);
  assert.deepEqual(retry(config, freeze(finished), 43), init(config, 43, 'hero-a'));
  assert.equal(JSON.stringify(finished), original);
});

test('a defeated run can explicitly retry without changing its old completed save', () => {
  const config = fixture();
  config.heroes[0].stats.health = 1;
  const dead = freeze(finishRun(config));
  assert.equal(dead.phase, 'defeat');
  assert.equal(retry(config, dead, 7).phase, 'playing');
  assert.equal(dead.stats.health, 0);
});

test('restore rejects changed version or changed rules even when version strings are reused', () => {
  const config = fixture();
  const state = init(config, 42, 'hero-a');
  const newVersion = fixture();
  newVersion.gameVersion = 'engine-fixture-v2';
  assert.throws(() => restore(newVersion, state), code('GAME_VERSION_MISMATCH'));
  const altered = fixture();
  altered.cards[0].effect.defense += 1;
  assert.throws(() => restore(altered, state), code('GAME_VERSION_MISMATCH'));
  const reordered = Object.fromEntries(Object.entries(config).reverse());
  assert.deepEqual(restore(reordered, state), state);
});

test('restore validates bounds, references, card conservation, wave and terminal invariants', () => {
  const config = fixture();
  const original = init(config, 42, 'hero-a');
  const corruptions = [
    s => { s.stats.health = 21; }, s => { s.stats.food = NaN; },
    s => { s.stats.morale = 0; }, s => { s.tiles[0] = -1; },
    s => { s.tiles.pop(); }, s => { s.rng = 2 ** 32; },
    s => { s.hand.push('guard'); }, s => { s.hand.pop(); },
    s => { s.hand[0] = 'missing'; }, s => { s.wave = 8; },
    s => { s.incoming[0].enemyId = 'missing'; }, s => { s.incoming[0].tileId = 7; },
    s => { s.acquired.push('guard'); }, s => { s.phase = 'victory'; },
    s => { s.phase = 'defeat'; }, s => { s.rewardChoices = ['guard']; },
    s => { s.extra = 'ignored data must fail'; }, s => { s.heroId = 'missing'; },
  ];
  for (const change of corruptions) {
    const state = structuredClone(original);
    change(state);
    assert.throws(() => restore(config, state), code('GAME_STATE_INVALID'));
  }
});

test('restoring any intermediate JSON state preserves all subsequent deterministic actions', () => {
  const config = fixture();
  let state = init(config, 42, 'hero-a');
  const actions = [{ type: 'play', cardId: 'guard', tileId: state.incoming[0].tileId }, { type: 'endTurn' }];
  for (const action of actions) {
    const restored = restore(config, JSON.parse(JSON.stringify(state)));
    assert.deepEqual(act(config, restored, action), act(config, state, action));
    state = act(config, state, action);
  }
  const choose = { type: 'reward', cardId: state.rewardChoices[0] };
  assert.deepEqual(act(config, restore(config, JSON.parse(JSON.stringify(state))), choose), act(config, state, choose));
});

test('bounded eight-wave runs preserve deck conservation and serializable states for many seeds', () => {
  const config = fixture();
  config.waves = Array.from({ length: 8 }, () => structuredClone(config.waves[0]));
  config.heroes[0].stats.health = 999;
  config.heroes[0].stats.food = 999;
  for (let seed = 0; seed < 32; seed += 1) {
    let state = init(config, seed, 'hero-a');
    while (state.phase !== 'victory') {
      const previous = freeze(state);
      state = act(config, previous, previous.phase === 'reward'
        ? { type: 'reward', cardId: previous.rewardChoices[0] } : { type: 'endTurn' });
      assert.deepEqual(restore(config, JSON.parse(JSON.stringify(state))), state);
      assert.equal(state.drawPile.length + state.hand.length + state.discard.length,
        config.heroes[0].deck.length + state.acquired.length);
      assert.ok(state.stats.health >= 0 && state.stats.health <= 999);
    }
    assert.equal(state.acquired.length, 7);
  }
});
