// 线条图标（风格参考 Lucide，24×24，颜色跟着文字）
const P = {
  back: '<path d="m15 18-6-6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  fit: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  calendar: '<rect x="3" y="4.5" width="18" height="17" rx="2.5"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>',
  reorder: '<path d="m21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  bed: '<path d="M2 5v14M2 9h17a3 3 0 0 1 3 3v7M2 16h20"/><circle cx="7" cy="12" r="1.6"/>',
  sparkles: '<path d="M12 3l1.8 4.9L19 10l-5.2 1.9L12 17l-1.8-5.1L5 10l5.2-2.1Z"/><path d="M19 15v4M17 17h4"/>',
  nav: '<path d="m3 11 18-8-8 18-2-8-8-2Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  car: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M3 16h18v3H3z"/><circle cx="7.5" cy="13" r="1"/><circle cx="16.5" cy="13" r="1"/>',
  walk: '<circle cx="13" cy="4" r="2"/><path d="m7 21 3-7 3 2v5M8 11l2-3 4 1 2 4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pin: '<path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9Z"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5Z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  share: '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v13"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.2"/>',
  utensils: '<path d="M4 3v8a3 3 0 0 0 3 3v7M10 3v8a3 3 0 0 1-3 3M7 3v8"/><path d="M20 15V3a4 4 0 0 0-4 4v6a2 2 0 0 0 2 2h2v6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  cloud: '<path d="M17.5 19H8a5 5 0 1 1 1-9.9A6 6 0 0 1 20.5 11 4 4 0 0 1 17.5 19Z"/>',
  rain: '<path d="M17.5 15H8a5 5 0 1 1 1-9.9A6 6 0 0 1 20.5 7 4 4 0 0 1 17.5 15Z"/><path d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
  storm: '<path d="M17.5 14H8a5 5 0 1 1 1-9.9A6 6 0 0 1 20.5 6 4 4 0 0 1 17.5 14Z"/><path d="m12 15-2 4h4l-2 4"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z"/>',
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M21 12h-5a2 2 0 0 0 0 4h5Z"/>',
  ticket: '<path d="M3 9a3 3 0 0 0 0 6v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3a3 3 0 0 1 0-6V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  train: '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14M8 21l2-4M16 21l-2-4"/><circle cx="9" cy="14" r=".8"/><circle cx="15" cy="14" r=".8"/>',
  route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  play: '<path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L6 21"/>',
  volume: '<path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>',
  mute: '<path d="M11 5 6 9H3v6h3l5 4Z"/><path d="m22 9-6 6M16 9l6 6"/>',
  grip: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M8 12h8M8 16h5"/>',
  sunset: '<path d="M12 10V2M8.5 5.5 12 2l3.5 3.5M4.2 10.2l1.4 1.4M1 18h2M21 18h2M18.4 11.6l1.4-1.4M23 22H1M16 18a4 4 0 0 0-8 0"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  map: '<path d="m9 4-6 2.5v14L9 18l6 2.5 6-2.5v-14L15 6.5Z"/><path d="M9 4v14M15 6.5v14"/>',
  fuel: '<path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M4 10h10"/><path d="M14 8h2a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V8.5L18 5.5"/>',
  pinned: '<path d="M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3Z"/>',
  phoneApp:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
};

// 交通方式的实心图标（地图上、路线列表用，要够显眼）
// fill = 主体；cut = 挖空的部分（窗户、车灯，用底色画）；head = 走路小人的头；stroke = 走路小人的身体
const MODE = {
  car: {
    fill: ['M4 11.5 5.8 6.6A2 2 0 0 1 7.7 5.3h8.6a2 2 0 0 1 1.9 1.3l1.8 4.9A2 2 0 0 1 21 13.3V17a1 1 0 0 1-1 1h-1.2a2.3 2.3 0 0 1-4.6 0H9.8a2.3 2.3 0 0 1-4.6 0H4a1 1 0 0 1-1-1v-3.7a2 2 0 0 1 1-1.8Z'],
    cut: ['M6.6 11h10.8l-1.3-3.6a.9.9 0 0 0-.8-.6H8.7a.9.9 0 0 0-.8.6Z'],
    dots: [[7.3, 14.2, 1.15], [16.7, 14.2, 1.15]],
  },
  bus: {
    fill: ['M6 2.5h12A2.5 2.5 0 0 1 20.5 5v12a1.5 1.5 0 0 1-1.5 1.5V20a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-1.5h-7V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-1.5A1.5 1.5 0 0 1 3.5 17V5A2.5 2.5 0 0 1 6 2.5Z'],
    cut: ['M5.8 5.5h12.4v6H5.8Z'],
    dots: [[7.5, 15, 1.2], [16.5, 15, 1.2]],
  },
  train: {
    fill: ['M7 2.5h10A3 3 0 0 1 20 5.5V15a3.5 3.5 0 0 1-3 3.46L18.8 21h-2.3l-1.6-2.5H9.1L7.5 21H5.2L7 18.46A3.5 3.5 0 0 1 4 15V5.5a3 3 0 0 1 3-3Z'],
    cut: ['M6.3 5.6h5v5.2h-5ZM12.7 5.6h5v5.2h-5Z'],
    dots: [[8, 14.6, 1.2], [16, 14.6, 1.2]],
  },
  foot: {
    head: [13.6, 3.8, 2.4],
    stroke: ['M13.6 8.4 11 13.2l3.2 2.6V21', 'M11 13.2 8.8 21', 'M10.7 9.7 7.3 12.6', 'M14.3 9.5l3.5 2.9'],
  },
};
export const MODE_COLOR = { car: '#2563eb', foot: '#059669', bus: '#7c3aed', train: '#ea580c' };
export const MODE_NAME = { car: '开车', foot: '走路', bus: '巴士', train: '地铁 / 火车' };

// SVG 版本（白色图标，底色给挖空的部分）
export function modeIcon(name, size = 16, fg = '#fff', bg = MODE_COLOR[name]) {
  const m = MODE[name] || MODE.car;
  const parts = [
    ...(m.fill || []).map((d) => `<path d="${d}" fill="${fg}"/>`),
    ...(m.cut || []).map((d) => `<path d="${d}" fill="${bg}"/>`),
    ...(m.dots || []).map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${bg}"/>`),
    ...(m.head ? [`<circle cx="${m.head[0]}" cy="${m.head[1]}" r="${m.head[2]}" fill="${fg}"/>`] : []),
    ...(m.stroke || []).map((d) => `<path d="${d}" fill="none" stroke="${fg}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>`),
  ];
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${parts.join('')}</svg>`;
}

// 画在 canvas 上（地图路线上的图标）：彩色圆底 + 白边 + 白色实心图标
export function drawModeIcon(g, name, size) {
  const m = MODE[name] || MODE.car;
  const color = MODE_COLOR[name] || MODE_COLOR.car;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 3, 0, Math.PI * 2);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = '#ffffff';
  g.stroke();
  const s = size * 0.58;
  g.save();
  g.translate((size - s) / 2, (size - s) / 2);
  g.scale(s / 24, s / 24);
  g.fillStyle = '#ffffff';
  (m.fill || []).forEach((d) => g.fill(new Path2D(d)));
  g.fillStyle = color;
  (m.cut || []).forEach((d) => g.fill(new Path2D(d)));
  (m.dots || []).forEach(([x, y, r]) => {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  });
  if (m.head) {
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(m.head[0], m.head[1], m.head[2], 0, Math.PI * 2);
    g.fill();
  }
  g.strokeStyle = '#ffffff';
  g.lineWidth = 2.8;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  (m.stroke || []).forEach((d) => g.stroke(new Path2D(d)));
  g.restore();
}

export function ic(name, size = 20, extra = '') {
  return `<svg class="ic ${extra}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}

// 画在地图上的图标（给 canvas 用）
export function iconPaths(name) {
  return [...(P[name] || '').matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
}
export function iconCircles(name) {
  return [...(P[name] || '').matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
}
