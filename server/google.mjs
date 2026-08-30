import { OAuth2Client } from 'google-auth-library';
import { timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.mjs';
import { networkSignal, UPSTREAM_TIMEOUT_MS } from './network.mjs';

function invalidCredential() {
  return new ApiError(401, 'INVALID_GOOGLE_CREDENTIAL', 'Google 로그인을 다시 진행해 주세요.');
}

export function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function boundedGoogleClient() {
  const client = new OAuth2Client();
  const request = client.transporter.request.bind(client.transporter);
  client.transporter.request = async options => {
    try {
      return await request({
        ...options,
        retry: false,
        timeout: UPSTREAM_TIMEOUT_MS,
        signal: networkSignal(options.signal),
      });
    } catch {
      // Preserve a safe classification even when an HTTP library represents
      // cancellation with an unusual error name/code.
      throw Object.assign(new Error('Google verification keys unavailable'), { code: 'GOOGLE_KEYS_UNAVAILABLE' });
    }
  };
  return client;
}

export function createGoogleVerifier({ clientId, client = boundedGoogleClient(), now = Date.now }) {
  return async function verifyGoogleCredential(credential, expectedNonce) {
    if (!clientId) throw new ApiError(503, 'LOGIN_UNAVAILABLE', 'Google 로그인 설정을 확인해야 합니다.');
    if (typeof credential !== 'string' || credential.length < 20 || credential.length > 12288) {
      throw invalidCredential();
    }
    let payload;
    try {
      // Google Auth Library verifies the signature against Google's rotating
      // keys as well as issuer, audience and token lifetime.
      const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload();
    } catch (error) {
      const networkCode = /^(ECONN|ENET|EAI_|ENOTFOUND|ETIMEDOUT|ERR_NETWORK)/.test(String(error.code || ''));
      if (networkCode || error.code === 'GOOGLE_KEYS_UNAVAILABLE' || error.response?.status || ['AbortError', 'TimeoutError'].includes(error.name)) {
        throw new ApiError(503, 'LOGIN_UNAVAILABLE', 'Google 로그인 연결을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
      }
      throw invalidCredential();
    }
    // Do not accept the library's expiry clock-skew grace period for a new
    // application session, and bind the token to this browser's challenge.
    if (!payload || payload.aud !== clientId
        || !['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)
        || !Number.isFinite(payload.exp) || payload.exp * 1000 <= now()
        || !Number.isFinite(payload.iat) || payload.iat * 1000 > now() + 60000
        || typeof payload.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(payload.sub)
        || !secureEqual(payload.nonce, expectedNonce)
        || (payload.azp !== undefined && payload.azp !== clientId)) {
      throw invalidCredential();
    }
    return {
      googleSub: payload.sub,
      name: typeof payload.name === 'string' && payload.name.trim()
        ? [...payload.name.trim()].slice(0, 80).join('') : '참여자',
    };
  };
}
