// Korea has a fixed UTC+09:00 offset. A daily cycle is [previous23:00,23:00),
// and its release target is one hour after closing. These are scheduling data,
// not publication authority; a timestamp cannot bypass review/release gates.
export const DAY_MS = 24 * 60 * 60 * 1000;
export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAILY_CUTOFF_HOUR_KST = 23;
export const DAILY_RELEASE_DELAY_MS = 60 * 60 * 1000;
export const INITIAL_CUTOFF = Date.parse('2026-08-31T14:00:00.000Z');
export const FIRST_DAILY_CUTOFF = INITIAL_CUTOFF + DAY_MS;

function timestamp(value) {
  if (!Number.isSafeInteger(value) || Math.abs(value) > 8640000000000000) throw new RangeError('INVALID_DAILY_DATE');
  return value;
}
function cycle(closesAt) {
  const releaseAt = timestamp(closesAt + DAILY_RELEASE_DELAY_MS);
  return {
    cycleId: 'daily-' + new Date(closesAt + KST_OFFSET_MS).toISOString().slice(0, 10),
    opensAt: new Date(closesAt - DAY_MS).toISOString(),
    closesAt: new Date(closesAt).toISOString(),
    releaseAt: new Date(releaseAt).toISOString(),
  };
}

export function dailyCycleAt(now = Date.now()) {
  timestamp(now);
  if (now < INITIAL_CUTOFF) return null;
  return cycle(pendingProposalClosesAt(now));
}

// The date identifies the KST closing day, not the midnight release day.
export function dailyCycleForDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('INVALID_DAILY_DATE');
  const close = Date.parse(`${date}T14:00:00.000Z`);
  if (!Number.isFinite(close) || close < FIRST_DAILY_CUTOFF || new Date(close).toISOString().slice(0, 10) !== date) {
    throw new RangeError('INVALID_DAILY_DATE');
  }
  return cycle(close);
}

// Do not derive this from updated_at, a current round label, or the retry time.
// Requests made exactly at23:00 belong to the following day's cycle.
export function pendingProposalClosesAt(createdAt) {
  timestamp(createdAt);
  return timestamp(INITIAL_CUTOFF + Math.max(1, Math.floor((createdAt - INITIAL_CUTOFF) / DAY_MS) + 1) * DAY_MS);
}

export function pendingProposalClosesAtSql(createdAtColumn = 'created_at') {
  // Only trusted column identifiers are accepted; never interpolate public input.
  if (typeof createdAtColumn !== 'string' || !/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?[A-Za-z_][A-Za-z0-9_]*$/.test(createdAtColumn)) {
    throw new TypeError('INVALID_DAILY_COLUMN');
  }
  // pending rows start at INITIAL_CUTOFF; MAX also freezes any legacy earlier
  // pending row at the first daily cutoff. SQLite integer truncation is safe here.
  return `MAX(${FIRST_DAILY_CUTOFF}, ${INITIAL_CUTOFF} + (CAST((${createdAtColumn} - ${INITIAL_CUTOFF}) / ${DAY_MS} AS INTEGER) + 1) * ${DAY_MS})`;
}
