// Shared display-name rules. A display name is never an account identifier.
export const PROFILE_ALIAS_LIMITS = Object.freeze({ minCodePoints: 2, maxCodePoints: 24, maxBytes: 96 });

const ALLOWED = /^[\p{L}\p{M}\p{N} _.\-]+$/u;
const INVISIBLE_OR_EMOJI = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Extended_Pictographic}\u20e3]/u;

export function normalizeProfileAlias(value) {
  if (typeof value !== 'string' || value.length > 1024 || INVISIBLE_OR_EMOJI.test(value)) return null;
  const alias = value.normalize('NFC').trim();
  const length = [...alias].length;
  if (length < PROFILE_ALIAS_LIMITS.minCodePoints || length > PROFILE_ALIAS_LIMITS.maxCodePoints
      || !ALLOWED.test(alias) || new TextEncoder().encode(alias).length > PROFILE_ALIAS_LIMITS.maxBytes) return null;
  return alias;
}

export function isValidProfileAlias(value) {
  return typeof value === 'string' && normalizeProfileAlias(value) === value;
}
