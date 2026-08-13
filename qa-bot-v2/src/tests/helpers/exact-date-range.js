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

function makeRange(start) {
  const end = addDays(start, 6);
  return {
    start,
    end,
    startIso: formatDateIso(start),
    endIso: formatDateIso(end),
    label: `${formatKoreanMonthDay(start)} ~ ${formatKoreanMonthDay(end)}`
  };
}

function getRandomExactSearchDateRange(now = new Date()) {
  const year = now.getFullYear();
  const windowStart = new Date(year, 7, 1, 12, 0, 0, 0);
  const tomorrow = addDays(now, 1);
  const minStart = tomorrow > windowStart ? tomorrow : windowStart;
  const maxStart = new Date(year, 7, 25, 12, 0, 0, 0);

  if (minStart > maxStart) {
    return makeRange(windowStart);
  }

  const days = Math.floor((maxStart - minStart) / 86400000);
  const offset = Math.floor(Math.random() * (days + 1));
  return makeRange(addDays(minStart, offset));
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
