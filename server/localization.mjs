export const SUPPORTED_LOCALES = Object.freeze(['en', 'ko']);
export const LOCALE_VARY = 'Cookie, X-Yourgame-Language, X-Vercel-IP-Country';

function supported(value) {
  return value === 'en' || value === 'ko';
}

function singleHeader(req, name) {
  // Node combines repeated headers into strings. Reject repetition using the
  // raw header list as well; arrays and comma-joined values are not preferences.
  if (Array.isArray(req.rawHeaders)) {
    let count = 0;
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      if (typeof req.rawHeaders[index] === 'string' && req.rawHeaders[index].toLowerCase() === name) count += 1;
    }
    if (count > 1) return '';
  }
  const entries = Object.entries(req.headers || {}).filter(([key]) => key.toLowerCase() === name);
  return entries.length === 1 && typeof entries[0][1] === 'string' ? entries[0][1] : '';
}

function cookiePreference(req) {
  const cookie = singleHeader(req, 'cookie');
  if (!cookie || cookie.length > 16384) return null;
  const candidates = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith('yourgame_language='));
  if (candidates.length !== 1) return null;
  const value = candidates[0].slice('yourgame_language='.length);
  // No percent decoding, case coercion, JSON parsing or arbitrary cookie data.
  return supported(value) ? value : null;
}

export function requestLocale(req, { trustVercelGeoHeader = false } = {}) {
  const header = singleHeader(req, 'x-yourgame-language');
  if (supported(header)) return { locale: header, source: 'preference', supportedLocales: [...SUPPORTED_LOCALES] };
  const cookie = cookiePreference(req);
  if (cookie) return { locale: cookie, source: 'preference', supportedLocales: [...SUPPORTED_LOCALES] };
  if (trustVercelGeoHeader === true && singleHeader(req, 'x-vercel-ip-country') === 'KR') {
    return { locale: 'ko', source: 'country', supportedLocales: [...SUPPORTED_LOCALES] };
  }
  return { locale: 'en', source: 'default', supportedLocales: [...SUPPORTED_LOCALES] };
}

const SAFETY_MESSAGES = {
  en: {
    pending: 'Awaiting safety review. Not available for publication, voting or development yet.',
    approved: 'Safety review is complete for this text. This does not mean it will be included in the game or has an official rating.',
    held: 'Safety review is on hold. Not available for publication, voting or development.',
    blocked: 'Use is restricted under the safety rules. You and the administrator can still view the original text.',
  },
  ko: {
    pending: '안전 검토 대기 중입니다. 아직 공개·투표·개발 대상으로 사용하지 않습니다.',
    approved: '현재 본문의 안전 검토가 완료되었습니다. 실제 게임 반영이나 공식 등급 인증을 뜻하지 않습니다.',
    held: '안전 검토가 보류되었습니다. 공개·투표·개발 대상으로 사용하지 않습니다.',
    blocked: '안전 기준에 따라 사용이 제한되었습니다. 원문은 본인과 관리자가 확인할 수 있습니다.',
  },
};

function localizeProposal(proposal, locale) {
  if (!proposal?.safety || typeof proposal.safety !== 'object') return proposal;
  const messages = SAFETY_MESSAGES[locale === 'ko' ? 'ko' : 'en'];
  const status = proposal.safety.status;
  return { ...proposal, safety: { ...proposal.safety,
    message: Object.hasOwn(messages, status) ? messages[status] : messages.pending } };
}

export function localizeProposalPayload(payload, locale) {
  // Only the public fixed notice is translated. Never recurse into user text,
  // names, administrator reasons, service announcements, hashes or request data.
  return { ...payload,
    ...(payload.proposal ? { proposal: localizeProposal(payload.proposal, locale) } : {}),
    ...(Array.isArray(payload.proposals) ? { proposals: payload.proposals.map(proposal => localizeProposal(proposal, locale)) } : {}),
  };
}
