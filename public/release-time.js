// Release presentation only. Idea timestamps and quota deadlines keep their
// explicitly labelled KST format; neither display zone changes the UTC target.
export function countdownParts(target, now) {
  const timestamp = typeof target === 'number' ? target : Date.parse(target);
  const remaining = Number.isFinite(timestamp) && Number.isFinite(now)
    ? Math.max(0, Math.ceil((timestamp - now) / 1000)) : 0;
  return { remaining, hours: Math.floor(remaining / 3600),
    minutes: Math.floor(remaining / 60) % 60, seconds: remaining % 60 };
}

export function formatReleaseDate(value, locale = 'en') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const korean = locale === 'ko';
  const timeZone = korean ? 'Asia/Seoul' : 'America/New_York';
  if (korean) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23' }).formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}.${parts.month}.${parts.day} / ${parts.hour}:${parts.minute} KST`;
  }
  const day = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric',
    month: 'short', day: 'numeric' }).format(date);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric',
    minute: '2-digit', hour12: true, timeZoneName: 'short' }).format(date);
  return `${day} / ${time}`.replace(/\u202f/g, ' ');
}
