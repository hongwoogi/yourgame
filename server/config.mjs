import packageInfo from '../package.json' with { type: 'json' };
import { ApiError } from './errors.mjs';

export const INITIAL_CUTOFF = Date.parse('2026-08-31T14:00:00.000Z');
export const FIRST_RELEASE = Date.parse('2026-08-31T15:00:00.000Z');
export const MAX_BYTES = 2000;
export const SUBMISSION_LIMIT = 3;
export const WINDOW_MS = 60 * 60 * 1000;
export const ANONYMOUS_SESSION_MS = 60 * 60 * 1000;
export const LOGIN_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
export const GOOGLE_NONCE_MS = 10 * 60 * 1000;
export const SESSION_CREATION_LIMIT = 30;
export const SESSION_CREATION_WINDOW_MS = 60 * 1000;

export function isTrustedVercelGeoDeployment(env = process.env) {
  return env.VERCEL === '1' && ['production', 'preview'].includes(env.VERCEL_ENV);
}

export function readConfig(env = process.env) {
  const production = env.NODE_ENV === 'production' || env.VERCEL === '1';
  const configuredOrigin = env.APP_ORIGIN || (production ? 'https://yourga.me' : 'http://localhost:3000');
  let parsed;
  try {
    parsed = new URL(configuredOrigin);
  } catch {
    throw new ApiError(503, 'CONFIGURATION_ERROR', '서비스 주소 설정을 확인해야 합니다.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/'
      || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback && !production))) {
    throw new ApiError(503, 'CONFIGURATION_ERROR', '서비스 주소 설정을 확인해야 합니다.');
  }
  const databaseUrl = env.TURSO_DATABASE_URL?.trim() || null;
  if (databaseUrl && (!/^(file:|libsql:\/\/|https:\/\/)/.test(databaseUrl)
      || (production && databaseUrl.startsWith('file:')))) {
    throw new ApiError(503, 'CONFIGURATION_ERROR', '데이터베이스 연결 설정을 확인해야 합니다.');
  }
  const rawClientId = env.GOOGLE_CLIENT_ID?.trim();
  const googleClientId = rawClientId && /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(rawClientId)
    ? rawClientId : null;
  const proposedVersion = env.APP_VERSION || env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || packageInfo.version;
  return {
    production,
    trustVercelIpHeader: env.VERCEL === '1',
    trustVercelGeoHeader: isTrustedVercelGeoDeployment(env),
    appOrigin: parsed.origin,
    secureCookies: parsed.protocol === 'https:',
    databaseUrl,
    databaseAuthToken: env.TURSO_AUTH_TOKEN,
    googleClientId,
    autoInitialize: !production && Boolean(databaseUrl?.startsWith('file:')),
    version: /^[A-Za-z0-9._+-]{1,80}$/.test(proposedVersion) ? proposedVersion : packageInfo.version,
  };
}

export function currentCollection(now = Date.now()) {
  const initialClosed = now >= INITIAL_CUTOFF;
  return {
    id: initialClosed ? 'pending' : 'initial',
    status: 'open',
    closesAt: initialClosed ? null : new Date(INITIAL_CUTOFF).toISOString(),
    releaseAt: initialClosed ? null : new Date(FIRST_RELEASE).toISOString(),
    initialClosed,
  };
}
