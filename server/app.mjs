import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import {
  ANONYMOUS_SESSION_MS, FIRST_RELEASE, LOGIN_SESSION_MS,
  MAX_BYTES, SUBMISSION_LIMIT, WINDOW_MS, currentCollection, readConfig,
} from './config.mjs';
import { openDatabase } from './database.mjs';
import { ApiError, unavailable } from './errors.mjs';
import { createGoogleVerifier, secureEqual } from './google.mjs';
import { createStore, hashValue } from './store.mjs';
import { withNetworkDeadline } from './network.mjs';
import { publicService, proposalsAllowed } from './admin-policy.mjs';

const BODY_LIMIT = 16 * 1024;
const METHODS = {
  '/api/status': ['GET'],
  '/api/session': ['GET'],
  '/api/login': ['POST'],
  '/api/logout': ['POST'],
  '/api/proposals': ['GET', 'POST', 'PATCH'],
  '/api/health': ['GET'],
  '/api/admin': ['GET', 'POST'],
  '/api/admin-page': ['GET'],
};

function header(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return typeof value === 'string' ? value : '';
}

function ensureOrigin(req, appOrigin, mutation) {
  const origin = header(req, 'origin');
  if (header(req, 'sec-fetch-site') === 'cross-site'
      || (origin && origin !== appOrigin) || (mutation && origin !== appOrigin)) {
    throw new ApiError(403, 'ORIGIN_REJECTED', '이 사이트에서 요청을 다시 진행해 주세요.');
  }
}

function cookieName(config) {
  return config.secureCookies ? '__Host-yourgame_session' : 'yourgame_session';
}

function clientFingerprint(req, config) {
  // Vercel supplies/overwrites this header. Other hosts must use their actual
  // socket address, never an arbitrary client-supplied forwarding header.
  const candidate = config.trustVercelIpHeader
    ? header(req, 'x-vercel-forwarded-for').split(',')[0].trim()
    : req.socket?.remoteAddress;
  const address = isIP(candidate || '') ? candidate : 'unknown';
  return hashValue(`${config.appOrigin}:${address}`);
}

function sessionToken(req, config) {
  const name = cookieName(config);
  const cookies = header(req, 'cookie').split(';').map(part => part.trim());
  const matching = cookies.filter(part => part.startsWith(`${name}=`));
  return matching.length === 1 ? matching[0].slice(name.length + 1) : null;
}

function setSessionCookie(res, token, config, authenticated) {
  const lifetime = authenticated ? LOGIN_SESSION_MS : ANONYMOUS_SESSION_MS;
  res.setHeader('Set-Cookie', `${cookieName(config)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(lifetime / 1000)}${config.secureCookies ? '; Secure' : ''}`);
}

function sessionPayload(session) {
  return { user: session.user, csrfToken: session.csrfToken, googleNonce: session.googleNonce };
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(header(req, 'content-type'))) {
    throw new ApiError(415, 'JSON_REQUIRED', 'JSON 형식으로 요청해야 합니다.');
  }
  const declaredLength = header(req, 'content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > BODY_LIMIT)) {
    throw new ApiError(413, 'REQUEST_TOO_LARGE', '요청이 너무 큽니다. 입력 내용을 확인해 주세요.');
  }
  let body = req.body;
  if (body === undefined) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > BODY_LIMIT) throw new ApiError(413, 'REQUEST_TOO_LARGE', '요청이 너무 큽니다. 입력 내용을 확인해 주세요.');
      chunks.push(bytes);
    }
    body = Buffer.concat(chunks);
  }
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (bytes.byteLength > BODY_LIMIT) throw new ApiError(413, 'REQUEST_TOO_LARGE', '요청이 너무 큽니다.');
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new ApiError(400, 'INVALID_JSON', '요청 형식을 확인해 주세요.');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_JSON', '요청 형식을 확인해 주세요.');
  }
  if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT) {
    throw new ApiError(413, 'REQUEST_TOO_LARGE', '요청이 너무 큽니다.');
  }
  return body;
}

function respond(res, status, payload) {
  res.statusCode = status;
  res.end(JSON.stringify(payload));
}

function safeLog(log, event, route, requestId, error) {
  const code = /^[A-Z][A-Z0-9_]{0,50}$/.test(error?.code || '') ? error.code : 'UNKNOWN';
  log({ event, route, requestId, code });
}

export function createApiHandler({
  config = readConfig(),
  store,
  getStore,
  verifyCredential,
  readAdminPage = () => readFile(new URL('./admin-page.html', import.meta.url), 'utf8'),
  now = Date.now,
  log = entry => console.error(JSON.stringify(entry)),
} = {}) {
  let storePromise;
  const resolveStore = getStore || (store ? async () => store : async () => {
    storePromise ||= openDatabase(config).then(client => createStore(client, { now })).catch(error => {
      storePromise = undefined;
      throw error;
    });
    return storePromise;
  });
  const verify = verifyCredential || createGoogleVerifier({ clientId: config.googleClientId, now });

  return function apiHandler(req, res, routeOverride) {
    return withNetworkDeadline(async () => {
      const requestId = randomUUID();
      let route = routeOverride || '/unknown';
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, private');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Vary', 'Cookie');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Request-Id', requestId);
      try {
        if (!routeOverride) route = new URL(req.url, 'http://internal.invalid').pathname;
        const method = req.method || 'GET';
        if (!METHODS[route]) throw new ApiError(404, 'NOT_FOUND', '요청한 기능을 찾을 수 없습니다.');
        if (!METHODS[route].includes(method)) {
          res.setHeader('Allow', METHODS[route].join(', '));
          throw new ApiError(405, 'METHOD_NOT_ALLOWED', '지원하지 않는 요청 방식입니다.');
        }
        const mutation = method !== 'GET';
        ensureOrigin(req, config.appOrigin, mutation);

        if (route === '/api/status') {
          const time = now();
          const service = await (await resolveStore()).getService();
          const collection = currentCollection(time);
          if (!proposalsAllowed(service)) collection.status = service.mode === 'ended' ? 'ended' : 'paused';
          return respond(res, 200, {
            serverTime: new Date(time).toISOString(),
            collection,
            service: publicService(service),
            firstReleaseAt: new Date(FIRST_RELEASE).toISOString(),
            googleClientId: config.googleClientId,
            limits: { bytes: MAX_BYTES, submissions: SUBMISSION_LIMIT, windowSeconds: WINDOW_MS / 1000 },
            // Publication requires an actual verified game artifact. Time alone
            // never changes this value to true.
            game: { published: false },
          });
        }

        if (route === '/api/health') {
          let database = config.databaseUrl || store || getStore ? 'unavailable' : 'unconfigured';
          let service = null;
          try {
            const db = await resolveStore();
            await db.health();
            service = await db.getService();
            database = 'ok';
          } catch (error) {
            safeLog(log, 'health_database_error', route, requestId, error);
          }
          const authConfigured = Boolean(config.googleClientId);
          const healthy = database === 'ok' && authConfigured;
          return respond(res, healthy ? 200 : 503, {
            status: healthy ? 'ok' : 'degraded', database, authConfigured,
            version: config.version, serverTime: new Date(now()).toISOString(),
            collectionOpen: service ? proposalsAllowed(service) : false, gamePublished: false,
            serviceMode: service?.mode ?? 'unknown',
            developmentEnabled: service ? service.mode === 'active' && service.developmentEnabled : false,
          });
        }

        const db = await resolveStore();
        let session = await db.getSession(sessionToken(req, config));
        if (route === '/api/session') {
          if (session) session = await db.refreshSessionNonce(session);
          if (!session) {
            const created = await db.createAnonymousSession(clientFingerprint(req, config));
            session = created.session;
            setSessionCookie(res, created.token, config, false);
          }
          return respond(res, 200, sessionPayload(session));
        }
        if (route === '/api/admin-page') {
          if (!session?.user) {
            res.statusCode = 302;
            res.setHeader('Location', '/?admin=1');
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.end('관리자 로그인이 필요합니다.');
          }
          await db.admin.requireAdmin(session);
          const html = await readAdminPage();
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.statusCode = 200;
          return res.end(html);
        }
        if (!session) throw new ApiError(401, 'LOGIN_REQUIRED', '로그인한 뒤 제안을 제출해 주세요.');
        if (mutation && !secureEqual(header(req, 'x-csrf-token'), session.csrfToken)) {
          throw new ApiError(403, 'CSRF_REJECTED', '접속 상태를 새로 확인한 뒤 다시 시도해 주세요.');
        }

        if (route === '/api/login') {
          const body = await readJson(req);
          if (session.nonceExpiresAt <= now()) {
            throw new ApiError(401, 'GOOGLE_NONCE_EXPIRED', '로그인 대기 시간이 지났습니다. Google 로그인을 다시 진행해 주세요.');
          }
          const identity = await verify(body.credential, session.googleNonce);
          const authenticated = await db.completeLogin(session, identity);
          setSessionCookie(res, authenticated.token, config, true);
          return respond(res, 200, sessionPayload(authenticated.session));
        }
        if (route === '/api/logout') {
          await readJson(req);
          if (!session.user) return respond(res, 200, sessionPayload(session));
          const anonymous = await db.logout(session);
          setSessionCookie(res, anonymous.token, config, false);
          return respond(res, 200, sessionPayload(anonymous.session));
        }
        if (!session.user) throw new ApiError(401, 'LOGIN_REQUIRED', '로그인한 뒤 제안을 제출해 주세요.');
        if (route === '/api/admin') {
          if (method === 'GET') {
            const url = new URL(req.url, 'http://internal.invalid');
            const keys = [...url.searchParams.keys()];
            if (url.search.length > 4096 || new Set(keys).size !== keys.length) {
              throw new ApiError(422, 'INVALID_ADMIN_INPUT', '관리 목록 조회 조건을 확인해 주세요.');
            }
            return respond(res, 200, await db.admin.query(session, Object.fromEntries(url.searchParams)));
          }
          await db.admin.requireAdmin(session);
          return respond(res, 200, await db.admin.mutate(session, await readJson(req)));
        }
        if (method === 'GET') {
          const result = await db.listProposals(session.user.id);
          return respond(res, 200, { ...result, ownerId: session.user.id });
        }
        const body = await readJson(req);
        if (method === 'POST') {
          const result = await db.createProposal(session.user.id, body);
          return respond(res, result.created ? 201 : 200, { proposal: result.proposal, quota: result.quota });
        }
        return respond(res, 200, await db.editProposal(session.user.id, body));
      } catch (error) {
        const failure = error instanceof ApiError ? error : unavailable();
        if (failure.status >= 500) {
          safeLog(log, 'api_error', route, requestId, error);
          res.setHeader('Retry-After', '3');
        }
        if (failure.status === 429 && failure.details.quota?.nextAvailableAt) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((Date.parse(failure.details.quota.nextAvailableAt) - now()) / 1000))));
        } else if (failure.status === 429 && failure.details.retryAfterSeconds) {
          res.setHeader('Retry-After', String(failure.details.retryAfterSeconds));
        }
        return respond(res, failure.status, {
          error: { code: failure.code, message: failure.message }, ...failure.details, requestId,
        });
      }
    });
  };
}

let runtimeHandler;
export async function handleApi(req, res, route) {
  try {
    runtimeHandler ||= createApiHandler();
  } catch {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return respond(res, 503, { error: { code: 'CONFIGURATION_ERROR', message: '서비스 설정을 확인해야 합니다.' } });
  }
  return runtimeHandler(req, res, route);
}

export default handleApi;
