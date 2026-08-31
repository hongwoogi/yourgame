import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/prepare-community-voting-rounds.mjs', import.meta.url));
function run(args) {
  // Do not inherit production credentials, Node preload options or .env files.
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']
    .filter(key => typeof process.env[key] === 'string').map(key => [key, process.env[key]]));
  env.NODE_ENV = 'production';
  return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 10000 });
}

test('voting round operator command requires one exact service revision before opening a DB', () => {
  for (const args of [[], ['--expected-service-revision', '0'], ['--expected-service-revision', '1.5'],
    ['--expected-service-revision', '1', '--expected-service-revision', '2'],
    ['--expected-service-revision', '1', '--unknown', 'value'], ['--help', '--expected-service-revision', '1']]) {
    const result = run(args);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage: node /);
    assert.doesNotMatch(result.stderr, /DATABASE_|https?:|libsql:/);
  }
});

test('voting round operator help is read only and valid input never falls back to a local DB', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--expected-service-revision NUMBER/);
  assert.equal(help.stderr, '');
  const missing = run(['--expected-service-revision', '1']);
  assert.equal(missing.error, undefined);
  assert.equal(missing.signal, null);
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  const result = JSON.parse(missing.stderr);
  assert.equal(result.prepared, null);
  assert.equal(result.code, 'DATABASE_UNCONFIGURED');
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'prepared']);
});
