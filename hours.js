// 解析 OpenStreetMap 的 opening_hours 格式，只支持常见写法：
//   "Mo-Su 09:00-23:00"、"Mo-Fr 09:00-17:00; Sa,Su 10:00-18:00"、
//   "Tu-Su 09:30-17:00; Mo off"、"24/7"、"11:00-14:00,17:00-22:00"、"18:00-02:00"
// 看不懂的写法返回 null，界面会显示原文并让用户手动输入。

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']; // 对应 Date.getDay()

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseDaySelector(sel) {
  // 返回 7 个布尔值，Su..Sa
  const days = new Array(7).fill(false);
  for (const part of sel.split(',')) {
    const p = part.trim();
    const range = /^([A-Z][a-z])-([A-Z][a-z])$/.exec(p);
    if (range) {
      let a = DAYS.indexOf(range[1]);
      const b = DAYS.indexOf(range[2]);
      if (a < 0 || b < 0) return null;
      for (let i = 0; i < 7; i++) {
        days[a] = true;
        if (a === b) break;
        a = (a + 1) % 7;
      }
    } else {
      const d = DAYS.indexOf(p);
      if (d < 0) return null;
      days[d] = true;
    }
  }
  return days;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// 规则开头的月份，例如 "Apr-Sep" 或 "Jan,Feb"；返回 [是否适用这个月, 剩下的文字]
function stripMonths(rule, month) {
  const m = /^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s*[-,]\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec))*)(?::|\s)\s*(.*)$/.exec(rule);
  if (!m) return [true, rule];
  let hit = false;
  for (const part of m[1].replace(/\s+/g, '').split(',')) {
    const [a, b] = part.split('-').map((x) => MONTHS.indexOf(x));
    if (b === undefined) hit ||= a === month;
    else hit ||= a <= b ? month >= a && month <= b : month >= a || month <= b;
  }
  return [hit, m[2].trim()];
}

// 解析成每周规则：week[dayIndex] = [[openMin, closeMin], ...]，closeMin 可以超过 1440（过午夜）
// month = 0..11，用来处理按月份不同的营业时间
export function parseOpeningHours(raw, month = new Date().getMonth()) {
  if (!raw) return null;
  const text = raw.trim();
  if (text === '24/7') {
    return Array.from({ length: 7 }, () => [[0, 1440]]);
  }
  const week = Array.from({ length: 7 }, () => null); // null = 规则没有提到
  for (let rule of text.split(';')) {
    rule = rule.trim();
    if (!rule) continue;
    // 指定日期的例外（例如 "Dec 29-Jan 01 off" 年末休息）先忽略
    // （"Jan 06:40-16:20" 是一月份的营业时间，不是日期，所以数字后面不能接冒号）
    if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*\d{1,2}(?![\d:])/.test(rule) || /^\d{4}\b/.test(rule)) continue;
    const [monthHit, rest] = stripMonths(rule, month);
    if (!monthHit) continue;
    rule = rest;
    // 公众假期（PH）/学校假期（SH）规则先忽略
    if (/^(PH|SH)\b(?!\s*,)/.test(rule)) continue;
    rule = rule.replace(/(PH|SH)\s*,\s*|\s*,\s*(PH|SH)\b/g, '').trim();

    let daySel = null;
    let timePart = rule;
    const m = /^([A-Z][a-z](?:\s*[-,]\s*[A-Z][a-z])*)\s+(.*)$/.exec(rule);
    if (m) {
      daySel = parseDaySelector(m[1].replace(/\s+/g, ''));
      if (!daySel) return null;
      timePart = m[2].trim();
    } else if (/^[A-Z][a-z](?:\s*[-,]\s*[A-Z][a-z])*$/.test(rule)) {
      // 只有星期没有时间，例如 "Mo-Fr"，看不懂
      return null;
    }
    if (!daySel) daySel = new Array(7).fill(true);

    let windows;
    if (/^(off|closed)$/i.test(timePart)) {
      windows = [];
    } else {
      windows = [];
      for (const seg of timePart.split(',')) {
        const r = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\+?$/.exec(seg.trim());
        if (!r) return null;
        const o = parseTime(r[1]);
        let c = parseTime(r[2]);
        if (o == null || c == null) return null;
        if (c <= o) c += 1440; // 过午夜
        windows.push([o, c]);
      }
    }
    for (let d = 0; d < 7; d++) if (daySel[d]) week[d] = windows;
  }
  // 规则没有提到的日子当作休息
  return week.map((w) => w || []);
}

// 某一天的营业窗口（分钟，相对当天 00:00），包含前一天过午夜延续过来的部分
export function windowsForDay(week, dayIndex) {
  if (!week) return null;
  const today = week[dayIndex].map((w) => [...w]);
  const prev = week[(dayIndex + 6) % 7];
  for (const [, c] of prev) {
    if (c > 1440) today.unshift([0, c - 1440]);
  }
  return today.sort((a, b) => a[0] - b[0]);
}

export function minToHHMM(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// 返回某个地点在 date 那天的营业窗口：
//   { known: false } 不知道营业时间
//   { known: true, windows: [[openMin, closeMin]...], source: 'manual'|'osm' }（空数组 = 当天休息）
// App 告诉我们哪天是公共假期（营业时间里的「PH」规则要用）
let isHoliday = () => false;
export function setHolidayCheck(fn) {
  isHoliday = fn;
}

// 「PH off」「PH 10:00-14:00」：公共假期那天的营业时间；没写就返回 null
function holidayWindows(raw) {
  const m = /(?:^|;)\s*PH\s+([^;]+)/.exec(raw || '');
  if (!m) return null;
  const tp = m[1].trim();
  if (/^(off|closed)$/i.test(tp)) return [];
  const out = [];
  for (const seg of tp.split(',')) {
    const r = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\+?$/.exec(seg.trim());
    if (!r) return null;
    const o = parseTime(r[1]);
    let c = parseTime(r[2]);
    if (o == null || c == null) return null;
    if (c <= o) c += 1440;
    out.push([o, c]);
  }
  return out;
}

export function placeHoursOn(place, date) {
  const day = date.getDay();
  if (place.manual) {
    if (place.manual.closed) return { known: true, windows: [], source: 'manual' };
    const o = parseTime(place.manual.open || '');
    let c = parseTime(place.manual.close || '');
    if (o != null && c != null) {
      if (c <= o) c += 1440;
      return { known: true, windows: [[o, c]], source: 'manual' };
    }
  }
  const week = parseOpeningHours(place.hoursRaw, date.getMonth());
  if (!week) return { known: false };
  if (isHoliday(date)) {
    const ph = holidayWindows(place.hoursRaw);
    if (ph) return { known: true, windows: ph, source: 'osm', holiday: true };
  }
  return { known: true, windows: windowsForDay(week, day), source: 'osm' };
}
