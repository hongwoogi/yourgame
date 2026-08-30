import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { createGoogleVerifier } from '../server/google.mjs';
import { boundedFetch, withNetworkDeadline } from '../server/network.mjs';
import { errorCode, TEST_CLIENT_ID } from './backend-helpers.mjs';

// Only Google's certificate retrieval is replaced. The production Google Auth
// Library really verifies RSA signatures and JWT claims in these tests.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const nonce = 'test-browser-nonce-with-enough-entropy';
const timestamp = Date.now();

function token(overrides = {}, headerOverrides = {}) {
  const header = { alg: 'RS256', kid: 'test-key', typ: 'JWT', ...headerOverrides };
  const claims = {
    iss: 'https://accounts.google.com', aud: TEST_CLIENT_ID, sub: '12345678901234567890',
    iat: Math.floor(timestamp / 1000) - 60, exp: Math.floor(timestamp / 1000) + 3600,
    nonce, name: '테스트 참여자', ...overrides,
  };
  const content = [header, claims].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return `${content}.${sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url')}`;
}

function verifier() {
  const client = new OAuth2Client();
  client.getFederatedSignonCertsAsync = async () => ({ certs: { 'test-key': publicPem }, format: 'PEM' });
  return createGoogleVerifier({ clientId: TEST_CLIENT_ID, client, now: () => timestamp });
}

test('valid RSA-signed Google claims map only stable subject and display name', async () => {
  const identity = await verifier()(token(), nonce);
  assert.deepEqual(identity, { googleSub: '12345678901234567890', name: '테스트 참여자' });
});

test('invalid RSA signature and modified signed content are rejected', async () => {
  const valid = token();
  const [header, payload, signature] = valid.split('.');
  const bytes = Buffer.from(signature, 'base64url');
  bytes[0] ^= 1;
  await assert.rejects(verifier()(`${header}.${payload}.${bytes.toString('base64url')}`, nonce), errorCode('INVALID_GOOGLE_CREDENTIAL'));
  const modified = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'attacker' })).toString('base64url');
  await assert.rejects(verifier()(`${header}.${modified}.${signature}`, nonce), errorCode('INVALID_GOOGLE_CREDENTIAL'));
});

for (const [label, overrides] of [
  ['wrong audience', { aud: 'other-client.apps.googleusercontent.com' }],
  ['wrong issuer', { iss: 'https://evil.example' }],
  ['expired inside library clock-skew grace', { exp: Math.floor(timestamp / 1000) - 1 }],
  ['future issue time', { iat: Math.floor(timestamp / 1000) + 120 }],
  ['missing subject', { sub: undefined }],
  ['wrong nonce', { nonce: 'other-browser-nonce' }],
  ['wrong authorized party', { azp: 'other-client.apps.googleusercontent.com' }],
]) {
  test(`signed token with ${label} is rejected`, async () => {
    await assert.rejects(verifier()(token(overrides), nonce), errorCode('INVALID_GOOGLE_CREDENTIAL'));
  });
}

test('unknown signing key, malformed JWT and absent challenge are rejected', async () => {
  await assert.rejects(verifier()(token({}, { kid: 'unknown-key' }), nonce), errorCode('INVALID_GOOGLE_CREDENTIAL'));
  await assert.rejects(verifier()('this-is-a-malformed-credential', nonce), errorCode('INVALID_GOOGLE_CREDENTIAL'));
  await assert.rejects(verifier()(token(), undefined), errorCode('INVALID_GOOGLE_CREDENTIAL'));
  await assert.rejects(verifier()('x'.repeat(12289), nonce), errorCode('INVALID_GOOGLE_CREDENTIAL'));
});

test('unconfigured auth and upstream certificate failures are unavailable, not successful login', async () => {
  await assert.rejects(createGoogleVerifier({ clientId: null })(token(), nonce), errorCode('LOGIN_UNAVAILABLE'));
  const client = {
    async verifyIdToken() { throw Object.assign(new Error('private request URL or token'), { code: 'ETIMEDOUT' }); },
  };
  const check = createGoogleVerifier({ clientId: TEST_CLIENT_ID, client });
  await assert.rejects(check(token(), nonce), error => {
    assert.equal(error.code, 'LOGIN_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /private|token/);
    return true;
  });
});

test('bounded fetch preserves caller cancellation and never starts uncancellable upstream work', async t => {
  let observed;
  t.mock.method(globalThis, 'fetch', async (_input, options) => {
    observed = options.signal;
    options.signal.throwIfAborted();
    return { ok: true };
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(withNetworkDeadline(() => boundedFetch('https://example.invalid', { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(observed.aborted, true);
});
