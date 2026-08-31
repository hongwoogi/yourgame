import { ApiError } from './errors.mjs';

export const SAFETY_POLICY_VERSION = 'teen-v1';
export const SAFETY_STATUSES = ['pending', 'approved', 'held', 'blocked'];
export const PROPOSAL_ATTEMPT_LIMIT = 30;
export const PROPOSAL_ATTEMPT_WINDOW_MS = 60000;
export const EDIT_REVIEW_COOLDOWN_MS = 3000;

// This intentionally narrow screen rejects conspicuous requests, not all
// unsafe meanings. A clear screen ALWAYS remains pending human review.
const INJECTION = [
  /\b(?:ignore|disregard|override|bypass)\s+(?:(?:all|any|the|previous|prior|system|developer|safety|security|above)\s+){1,6}(?:instructions|prompts?|rules|polic(?:y|ies))\b/giu,
  /(?:시스템|개발자|이전|앞선|상위|모든).{0,25}(?:지침|프롬프트|규칙|명령|안전\s*정책).{0,18}(?:무시|우회|덮어쓰|무력화|해제)/giu,
  /\b(?:reveal|dump|print|exfiltrate|upload|send)\b.{0,60}(?:api[_ -]?keys?|secrets?|access[_ -]?tokens?|session[_ -]?(?:cookies?|tokens?)|environment variables|\.env\b|system prompt)/giu,
  /(?:api\s*키|비밀\s*키|인증\s*토큰|세션\s*(?:쿠키|토큰)|환경\s*변수|\.env|시스템\s*프롬프트).{0,45}(?:출력|노출|보내|전송|업로드|추출|알려|읽어)/giu,
  /(?:나를|내\s*계정|이\s*계정).{0,20}관리자.{0,12}(?:승격|만들|바꿔)/giu,
  /\b(?:make me|grant me)\b.{0,20}\b(?:admin|administrator|root)\b/giu,
  /(?:run|execute|실행해|실행하|명령어).{0,50}(?:rm\s+-rf|remove-item|powershell\s+-enc|curl.{0,80}\|\s*(?:sh|bash))/giu,
  /(?:인증|보안|안전|심사|등급)\s*(?:검사|필터|제한|정책|가드레일).{0,20}(?:비활성화|무력화|우회|해제해|꺼줘)/giu,
];
const CONTENT = [
  /\b(?:explicit|graphic|uncensored|pornographic)\s+(?:sex(?:ual acts?)?|sexual intercourse|genitals|dismemberment|torture|gore)\b/giu,
  /(?:노골적(?:인)?|적나라한|상세한).{0,12}(?:성행위|성교|성기|성폭행)/giu,
  /(?:성기|음부).{0,8}(?:노출|묘사)/giu,
  /(?:포르노|pornography|pornographic)/giu,
  /(?:아동|미성년자|어린이|소년|소녀).{0,25}(?:성행위|성교|성적\s*대상|성기\s*노출)/giu,
  /(?:사실적(?:인)?|잔혹한|자세한|노골적인|적나라한|고어).{0,30}(?:신체\s*훼손|사지\s*절단|장기\s*적출|고문)/giu,
  /(?:신체\s*훼손|사지\s*절단|장기\s*적출|고문).{0,30}(?:자세히|적나라하게|사실적으로|노골적으로|고어)/giu,
];
const DIRECT_PREFIX = /(?:\b(?:do not|don't|never|without|avoid|remove|prevent|detect|block|reject|prohibit)(?:\s+(?:any|all|the|phrase|text|requests?|attempts?|content|containing)){0,3}\s*["'“‘([]*\s*)$/iu;
const DIRECT_SUFFIX = /^(?:\s*["'”’\])]*\s*)(?:하지\s*(?:마|말|않)|(?:이|가|은|는|을|를)?\s*(?:(?:모두|전부|절대)\s*)?(?:제거|삭제|차단|배제|금지|방지|없애|없게|넣지\s*마|추가하지|보여주지|원하지\s*않)|없이|없는|(?:하는|하라는)\s*(?:요청|명령|문구|시도)(?:을|를|은|는)?\s*(?:차단|방지|탐지|거부)|(?:is|are)\s+(?:forbidden|prohibited|disallowed|unwanted)|(?:must|should|shall)\s+(?:(?:not|never)\s+be\s+(?:allowed|shown|added|included)|be\s+(?:removed|blocked|excluded)))/iu;

function positiveHit(text, pattern) {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const start = Math.max(0, match.index - 90);
    const end = Math.min(text.length, match.index + match[0].length + 100);
    const before = text.slice(start, match.index).split(/[.!?。\n;]/u).at(-1);
    const after = text.slice(match.index + match[0].length, end).split(/[.!?。\n;]/u)[0];
    // Protection must directly negate/remove THIS expression. An unrelated
    // 'prevent delays' or 'without exception' must not excuse an override.
    if (!DIRECT_PREFIX.test(before) && !DIRECT_SUFFIX.test(after)) return true;
  }
  return false;
}

export function screenProposalBody(body) {
  if (typeof body !== 'string' || !body.isWellFormed()) return { hardBlocked: true, code: 'INVALID_TEXT' };
  const text = body.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu, '').toLowerCase();
  if (INJECTION.some(pattern => positiveHit(text, pattern))) return { hardBlocked: true, code: 'INSTRUCTION_OVERRIDE' };
  if (CONTENT.some(pattern => positiveHit(text, pattern))) return { hardBlocked: true, code: 'CONTENT_LIMIT' };
  return { hardBlocked: false, code: null };
}

export function assertScreenedBody(body) {
  if (screenProposalBody(body).hardBlocked) {
    throw new ApiError(422, 'PROPOSAL_SAFETY_REJECTED', '이 내용은 게임 개발용 안전 기준을 충족하지 않아 승인할 수 없습니다.');
  }
}

export function validateDevelopmentBrief(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim()
      || Buffer.byteLength(value, 'utf8') > 2000 || value.includes('\0')) {
    throw new ApiError(422, 'INVALID_SAFETY_BRIEF', '개발용 정리문을 UTF-8 2,000바이트 이내로 입력해 주세요.');
  }
  const brief = value.trim();
  assertScreenedBody(brief);
  return brief;
}

export function safetyMessage(status) {
  return {
    pending: '게임 개발용 안전 검토 대기 중입니다. 제안 공개와 투표에는 영향을 주지 않습니다.',
    approved: '현재 본문의 안전 검토가 완료되었습니다. 실제 게임 반영이나 공식 등급 인증을 뜻하지 않습니다.',
    held: '게임 개발용 안전 검토가 보류되었습니다. 제안 공개와 투표에는 영향을 주지 않습니다.',
    blocked: '게임 개발용 안전 기준에 따라 개발 입력에서 제외되었습니다. 제안 공개와 투표에는 영향을 주지 않습니다.',
  }[status] || '안전 검토가 필요합니다.';
}
