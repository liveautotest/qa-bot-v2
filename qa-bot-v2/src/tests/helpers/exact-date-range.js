function addDays(date, days) {
  const next = new Date(date);
  next.setHours(12, 0, 0, 0);
  next.setDate(next.getDate() + days);
  return next;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDateIso(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatMonthLabel(date) {
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
}

function formatKoreanMonthDay(date) {
  return `${date.getMonth() + 1}월 ${date.getDate()}일`;
}

function makeRange(start, nights = 6) {
  const end = addDays(start, nights);
  return {
    start,
    end,
    nights,
    startIso: formatDateIso(start),
    endIso: formatDateIso(end),
    label: `${formatKoreanMonthDay(start)} ~ ${formatKoreanMonthDay(end)}`
  };
}

function pickRandomNights(minNights, maxNights, buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) {
    return minNights + Math.floor(Math.random() * (maxNights - minNights + 1));
  }

  const candidates = buckets
    .map((bucket) => ({
      min: Math.max(minNights, bucket.min),
      max: Math.min(maxNights, bucket.max)
    }))
    .filter((bucket) => bucket.min <= bucket.max);
  if (!candidates.length) {
    return minNights + Math.floor(Math.random() * (maxNights - minNights + 1));
  }

  const bucket = candidates[Math.floor(Math.random() * candidates.length)];
  return bucket.min + Math.floor(Math.random() * (bucket.max - bucket.min + 1));
}

function getRandomExactSearchDateRange(now = new Date(), options = {}) {
  const minNights = Number.isFinite(options.minNights) ? options.minNights : 6;
  const maxNights = Number.isFinite(options.maxNights) ? options.maxNights : 6;
  const maxEndDate = options.maxEndDate instanceof Date ? options.maxEndDate : null;
  const nightBuckets = options.nightBuckets;
  const year = now.getFullYear();
  const windowStart = new Date(year, 7, 1, 12, 0, 0, 0);
  const tomorrow = addDays(now, 1);
  const minStart = tomorrow > windowStart ? tomorrow : windowStart;
  const maxStart = new Date(year, 7, 25, 12, 0, 0, 0);

  if (minStart > maxStart) {
    const cappedMaxNights = maxEndDate
      ? Math.max(minNights, Math.min(maxNights, Math.floor((maxEndDate - windowStart) / 86400000)))
      : Math.max(minNights, maxNights);
    const nights = pickRandomNights(minNights, cappedMaxNights, nightBuckets);
    return makeRange(windowStart, nights);
  }

  const days = Math.floor((maxStart - minStart) / 86400000);
  const offset = Math.floor(Math.random() * (days + 1));
  const start = addDays(minStart, offset);
  const cappedMaxNights = maxEndDate
    ? Math.max(minNights, Math.min(maxNights, Math.floor((maxEndDate - start) / 86400000)))
    : Math.max(minNights, maxNights);
  const nights = pickRandomNights(minNights, cappedMaxNights, nightBuckets);
  return makeRange(start, nights);
}

function schedulePattern() {
  return /\d{1,2}월\s*\d{1,2}일\s*~\s*\d{1,2}월\s*\d{1,2}일/;
}

module.exports = {
  addDays,
  formatDateIso,
  formatKoreanMonthDay,
  formatMonthLabel,
  getRandomExactSearchDateRange,
  schedulePattern
};
