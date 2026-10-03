import { travelRow, transitPlan, hasCJK, smartSearch, searchPlaces, parseCoords, suggestPlaces, lookupDetails, reverseGeocode, travelTable, routeLine, estimateTable, haversine } from './geo.js?v=18';
import { optimize, evaluate } from './optimizer.js?v=18';
import { arrangeDays } from './days.js?v=18';
import { ic, modeIcon, MODE_COLOR, MODE_NAME } from './icons.js?v=18';
import { placeHoursOn, minToHHMM, parseOpeningHours } from './hours.js?v=18';
import { CITY_PRESETS, searchCities, fetchPopular, categoryOf, typeZh, findPhoto, tileThumb, penangDemo, placeDetails, TEMPLATES, pickTemplatePlaces } from './discover.js?v=18';

/* ================= 状态与保存 ================= */

const STORE_KEY = 'shunlu:v2';
const REPLAN_AFTER_MS = 5 * 60e3; // 回到 App 超过 5 分钟就自动重算

const defaultSettings = () => ({
  mode: 'auto',
  walkMaxM: 1000,
  parkMin: 5,
  startFrom: 'home',
  returnHome: true,
  departMode: 'now',
  departAt: '09:00',
  defaultStay: 60,
  dayEnd: '21:00', // 多天行程：每天最晚回到住的地方
  arrangePref: 'balanced', // 分到每一天：balanced = 每天时间平均，shortest = 总路程最少
});

const newTrip = (name) => ({
  id: uid(),
  name: name || `行程 ${new Date().getMonth() + 1}月${new Date().getDate()}日`,
  created: Date.now(),
  updated: Date.now(),
  dest: null, // {name, sub, lat, lon, bbox}
  home: null, // {name, address, lat, lon}
  manualOrders: {}, // 每天手动排的顺序 { 天: [id...] }；没有 = 自动最优
  days: 1, // 几天
  startDate: todayStr(), // 第一天日期 YYYY-MM-DD
  curDay: 0, // 地图页正在看第几天（0 = 总览）
  dayPlans: {}, // 每天的路线 { 天: plan }
  places: [], // {id, name, address, lat, lon, osm, kind, hoursRaw, manual, stayMin, note, done}
  settings: defaultSettings(),
  plan: null,
});

let state = load();

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.trips)) {
      s.trips.forEach((t) => {
        t.settings = { ...defaultSettings(), ...t.settings };
        t.days ||= 1;
        t.startDate ||= todayStr();
        t.dayPlans ||= {};
        t.manualOrders ||= t.manualOrder ? { 1: t.manualOrder } : {};
        delete t.manualOrder;
      });
      return s;
    }
  } catch {}
  const s = { trips: [], currentId: null, lastView: 'trips', mapView: null };
  // 旧版本资料搬过来
  try {
    const old = JSON.parse(localStorage.getItem('shunlu:v1'));
    if (old?.places?.length) {
      const t = newTrip('我的行程');
      Object.assign(t, { home: old.home, places: old.places, settings: { ...defaultSettings(), ...old.settings } });
      s.trips.push(t);
    }
  } catch {}
  return s;
}

function save() {
  const t = T();
  if (t) t.updated = Date.now();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {}
}

/** 目前打开的行程 */
function T() {
  return state.trips.find((t) => t.id === state.currentId) || null;
}

/* ================= 小工具 ================= */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function uid() {
  return Math.random().toString(36).slice(2, 10);
}
function fmtDur(ms) {
  const m = Math.max(0, Math.round(ms / 60e3));
  if (m < 60) return `${m}分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}小时${m % 60}分` : `${h}小时`;
}
function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10}米` : `${(m / 1000).toFixed(1)}公里`;
}
function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
// 是不是同一个地方：编号一样就是；两边都有编号但不一样就不是（隔壁的店坐标可能几乎一样）；
// 没有编号时，才看坐标很近、而且名字差不多
const nameKey = (x) => String(x || '').toLowerCase().replace(/[\s()（）\-·,.]/g, '');
function samePlace(a, b) {
  if (a.osm && b.osm && a.osm === b.osm) return true;
  if (a.wikidata && b.wikidata && a.wikidata === b.wikidata) return true;
  if ((a.osm && b.osm) || (a.wikidata && b.wikidata)) return false;
  if (Math.abs(a.lat - b.lat) >= 1e-4 || Math.abs(a.lon - b.lon) >= 1e-4) return false;
  const na = nameKey(a.name);
  const nb = nameKey(b.name);
  return !na || !nb || na.includes(nb) || nb.includes(na) || (!!a.en && nameKey(a.en) === nameKey(b.en));
}

// 地点类型 → 图标
function kindIcon(kind = '') {
  const k = kind.toLowerCase();
  if (/hotel|hostel|guest_house|motel|apartment/.test(k)) return '🏨';
  if (/restaurant|food|fast_food/.test(k)) return '🍽️';
  if (/cafe|coffee/.test(k)) return '☕';
  if (/bar|pub/.test(k)) return '🍺';
  if (/museum|gallery|arts/.test(k)) return '🏛️';
  if (/park|garden|nature|forest|beach/.test(k)) return '🌳';
  if (/station|halt|subway|railway|bus|airport|aerodrome/.test(k)) return '🚉';
  if (/shop|mall|market|supermarket|department/.test(k)) return '🛍️';
  if (/temple|shrine|church|place_of_worship|mosque/.test(k)) return '⛩️';
  if (/zoo|aquarium|theme_park|attraction|viewpoint|tower/.test(k)) return '🎡';
  if (/city|town|village|suburb|district|state|country/.test(k)) return '🏙️';
  return '📍';
}

// 地点类型 → 中文说明（同名的结果靠这个分辨）
const KIND_LABELS = [
  [/hotel|hostel|guest_house|motel/, '住宿'], [/apartment/, '公寓'],
  [/restaurant|food_court/, '餐厅'], [/fast_food/, '快餐'], [/cafe/, '咖啡店'], [/bar|pub/, '酒吧'],
  [/museum/, '博物馆'], [/gallery|arts_centre/, '美术馆'], [/attraction|viewpoint|tower/, '景点'],
  [/zoo/, '动物园'], [/aquarium/, '水族馆'], [/theme_park/, '游乐园'], [/park|garden/, '公园'],
  [/temple|shrine|place_of_worship|church|mosque/, '寺庙/宗教'], [/castle|monument|memorial|ruins|historic/, '古迹'],
  [/bus_stop|bus_station/, '公交站'], [/station|halt|subway_entrance|tram_stop/, '车站'], [/aerodrome|airport/, '机场'],
  [/mall|department_store/, '商场'], [/supermarket|convenience/, '超市'], [/marketplace|market/, '市场'], [/shop/, '商店'],
  [/residential|primary|secondary|tertiary|footway|pedestrian|street|road|service|path|unclassified/, '道路'],
  [/city|town|village|suburb|neighbourhood|quarter|district/, '地区'], [/building|house|yes/, '建筑'],
];
function kindLabel(kind = '') {
  const k = kind.toLowerCase();
  return KIND_LABELS.find(([re]) => re.test(k))?.[1] || '';
}

let toastTimer;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

/* ================= 页面切换 ================= */

let currentView = 'trips';
function showView(name) {
  currentView = name;
  for (const v of ['trips', 'setup', 'map']) $(`#view${v[0].toUpperCase()}${v.slice(1)}`).hidden = v !== name;
  state.lastView = name;
  save();
  if (name !== 'map') {
    updateGeoWatch();
    $('#geoPrompt').hidden = true;
  }
  if (name === 'trips') renderTrips();
  if (name === 'map') {
    ensureMap();
    map.resize();
    renderMap();
  }
}

/* ================= 首页：行程列表 ================= */

function renderTrips() {
  const list = $('#tripList');
  const trips = [...state.trips].sort((a, b) => b.updated - a.updated);
  $('#tripSection').hidden = !trips.length;
  $('#btnExport').hidden = !trips.length;
  $('#onboard').hidden = !!trips.length;
  renderTemplates();
  updateInstallCard();
  list.innerHTML = trips
    .map((t) => {
      const left = t.places.filter((p) => !p.done).length;
      const sub = [
        `${t.places.length} 个地点${t.places.length && left < t.places.length ? `（剩 ${left}）` : ''}`,
        t.home ? `住 ${t.home.name}` : null,
        fmtDate(t.updated),
      ].filter(Boolean).join(' · ');
      const status = !t.places.length ? '未完成' : left === 0 ? '全部去过了' : t.plan?.stops?.length ? `约 ${fmtClock(t.plan.endArrive ?? t.plan.finish)} 结束` : '';
      return `<div class="trip-card" data-id="${t.id}">
        <div class="tc-cover" data-cover="${t.id}"><span>${esc((t.dest?.name || t.name).slice(0, 2))}</span></div>
        <div class="tc-main">
          <div class="tc-name">${esc(t.name)}</div>
          <div class="tc-sub">${esc(sub)}</div>
          ${status ? `<div class="tc-status">${esc(status)}</div>` : ''}
        </div>
        <div class="tc-acts">
          <button data-tact="copy" title="复制成新的一天">复制</button>
          <button data-tact="del" class="danger" title="删除">删除</button>
        </div></div>`;
    })
    .join('');
  // 封面：用行程里第一个有照片的地方
  trips.forEach((t) => {
    const el = list.querySelector(`[data-cover="${t.id}"]`);
    const withPhoto = t.places.find((p) => p.photo) || t.places.find((p) => p.wikidata) || t.places[0];
    if (!el || !withPhoto) return;
    findPhoto(withPhoto).then((url) => {
      if (url && el.isConnected) {
        el.style.backgroundImage = `url("${url}")`;
        el.classList.add('has-img');
      }
    });
  });
}

// 示例卡片的照片（极乐寺）
findPhoto({ wikidata: 'Q822518', lat: 5.3997, lon: 100.2739, name: 'Kek Lok Si' }).then((url) => {
  if (url) $('#demoImg').style.backgroundImage = `url("${url}")`;
});

$('#tripList').addEventListener('click', (e) => {
  const card = e.target.closest('.trip-card');
  if (!card) return;
  const t = state.trips.find((x) => x.id === card.dataset.id);
  if (!t) return;
  const act = e.target.closest('[data-tact]')?.dataset.tact;
  if (act === 'del') {
    if (!confirm(`删除「${t.name}」？`)) return;
    state.trips = state.trips.filter((x) => x.id !== t.id);
    if (state.currentId === t.id) state.currentId = null;
    save();
    renderTrips();
    return;
  }
  if (act === 'copy') {
    // 新的一天：保留住的地方和设置，地点清空
    const c = newTrip();
    c.home = t.home ? { ...t.home } : null;
    c.dest = t.dest ? { ...t.dest } : null;
    if (c.dest) loadPopular(c.dest);
    c.settings = { ...t.settings };
    state.trips.push(c);
    state.currentId = c.id;
    save();
    openSetup({ edit: false, step: 2 });
    toast('已复制城市、住的地方和设置，请添加今天要去的地方');
    return;
  }
  openTrip(t.id);
});

function openTrip(id) {
  state.currentId = id;
  save();
  const t = T();
  if (!t.places.length) return openSetup({ edit: true, step: !t.dest ? 1 : 2 });
  if (isMulti(t)) {
    t.curDay = todayDay(t) || 0;
    t.plan = t.curDay ? t.dayPlans?.[t.curDay] || null : null;
  }
  showView('map');
  setTimeout(fitAll, 300);
  replanIfStale(true);
}

$('#btnNewTrip').addEventListener('click', () => {
  const t = newTrip();
  state.trips.push(t);
  state.currentId = t.id;
  save();
  openSetup({ edit: false, step: 1 });
});

// 槟城示例行程（测试用）：直接生成，打开地图
$('#btnDemo').addEventListener('click', () => {
  const d = penangDemo();
  const t = newTrip(d.name);
  t.dest = d.dest;
  t.home = d.home;
  t.settings = { ...t.settings, departMode: 'at', departAt: '08:30', startFrom: 'home', returnHome: true, dayEnd: '22:00' };
  t.days = d.days || 1;
  // 从明天开始的行程
  const tm = new Date();
  tm.setDate(tm.getDate() + 1);
  t.startDate = `${tm.getFullYear()}-${String(tm.getMonth() + 1).padStart(2, '0')}-${String(tm.getDate()).padStart(2, '0')}`;
  t.curDay = 0;
  state.trips.push(t);
  state.currentId = t.id;
  t.places = d.places.map((p) => makePlace({ ...p, needsDetails: false, hoursRaw: p.hoursRaw || null }));
  t.places.forEach((p) => (p.needsDetails = false));
  save();
  loadPopular(t.dest);
  showView('map');
  setTimeout(fitAll, 300);
  arrangeTrip(t).then(() => replan());
  toast(`槟城 ${t.days} 天示例：自动把 ${t.places.length} 个地点分到每一天`, 3500);
});

/* ---- 首页：热门路线模板（按一下就有城市、天数和热门景点，再自己加减） ---- */

function renderTemplates() {
  const box = $('#tplList');
  if (box.dataset.ready) return;
  box.dataset.ready = '1';
  box.innerHTML = TEMPLATES.map((x, i) => {
    const c = CITY_PRESETS.find((y) => y.name === x.city);
    return `<button type="button" class="tpl-card" data-tpl="${i}">
      <div class="tpl-img" data-tplimg="${i}"><span class="tpl-flag">${c?.flag || '🌏'}</span><span class="tpl-days">${x.days} 天</span></div>
      <div class="tpl-body"><b>${esc(x.city)}</b><span>${esc(x.line)}</span></div></button>`;
  }).join('');
  TEMPLATES.forEach((x, i) =>
    findPhoto(x.cover).then((url) => {
      const el = box.querySelector(`[data-tplimg="${i}"]`);
      if (url && el) {
        el.style.backgroundImage = `url("${url}")`;
        el.classList.add('has-img');
      }
    }),
  );
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function useTemplate(x) {
  const c = CITY_PRESETS.find((y) => y.name === x.city);
  const t = newTrip(`${x.city} ${x.days} 天`);
  t.dest = { name: c.name, sub: c.sub, lat: c.lat, lon: c.lon, bbox: c.bbox };
  t.days = x.days;
  const tm = new Date();
  tm.setDate(tm.getDate() + 1);
  t.startDate = ymd(tm);
  state.trips.push(t);
  state.currentId = t.id;
  const add = (r) => {
    const p = makePlace(r);
    t.places.push(p);
    if (p.needsDetails) fillDetails(p);
  };
  if (x.curated) penangDemo().places.forEach((r) => add({ ...r, needsDetails: false }));
  save();
  openSetup({ edit: false, step: 2 });
  if (x.curated) return toast(`已放好 ${t.places.length} 个热门地点：不要的按 ✕，想加的从下面挑`, 4000);
  toast('正在挑选热门景点…（第一次大约 10 秒）', 4000);
  const job = loadPopular(t.dest);
  if (job) await job;
  // 等的时候用户可能已经离开、或自己加了地点：就不要再塞
  if (T() !== t || t.places.length || !popular.items?.length) {
    if (T() === t && !popular.items?.length) toast('热门景点载入失败，请自己搜索想去的地方');
    return;
  }
  pickTemplatePlaces(popular.items, x.days * 4).forEach(add);
  save();
  if (currentView === 'setup') renderSetup();
  toast(`已帮你挑好 ${t.places.length} 个热门地点：不要的按 ✕，想加的从下面挑`, 4000);
}

$('#tplList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tpl]');
  if (b) useTemplate(TEMPLATES[Number(b.dataset.tpl)]);
});

/* ---- 首页：会动的标题、慢慢滑过的热门城市 ---- */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
(function heroWord() {
  const words = ['哪里', '槟城', '东京', '曼谷', '首尔', '新加坡', '台北', '大阪', '吉隆坡'];
  const el = $('#heroWord');
  if (reduceMotion) return;
  let i = 0;
  setInterval(() => {
    if (currentView !== 'trips' || document.hidden) return;
    el.classList.add('out');
    setTimeout(() => {
      i = (i + 1) % words.length;
      el.textContent = words[i];
      el.classList.remove('out');
      el.classList.add('in');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('in')));
    }, 320);
  }, i === 0 ? 2600 : 2200);
})();

(function destMarquee() {
  const chip = (c, i) => `<button type="button" class="dm-chip" data-mq="${i}"><span>${c.flag || '🌏'}</span>${esc(c.name)}<small>${esc(c.sub)}</small></button>`;
  const html = CITY_PRESETS.map(chip).join('');
  // 两份接在一起，滑到一半刚好接回开头（看起来不会断）
  $('#destMarquee').innerHTML = html + html;
})();
$('#destMarquee').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mq]');
  if (!b) return;
  const t = newTrip();
  state.trips.push(t);
  state.currentId = t.id;
  save();
  openSetup({ edit: false, step: 1 });
  chooseDest(CITY_PRESETS[Number(b.dataset.mq)]);
});

/* ---- 首页：教用户装到手机桌面 ---- */

const INSTALL_KEY = 'shunlu:install-x';
let installEvt = null; // Android Chrome 给的「安装」事件
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isPhone = () => /Android|iPhone|iPad|iPod/.test(navigator.userAgent) || isIOS();

function updateInstallCard() {
  let dismissed = false;
  try {
    dismissed = !!localStorage.getItem(INSTALL_KEY);
  } catch {}
  const show = !dismissed && !isStandalone() && isPhone() && (installEvt || isIOS());
  $('#installCard').hidden = !show;
  if (!show) return;
  $('#installText').innerHTML = installEvt
    ? '像 App 一样全屏打开，速度更快'
    : `按 Safari 下面的 <b>分享</b> ${ic('share', 14)}，再按「<b>加入主屏幕</b>」`;
  $('#installGo').hidden = !installEvt;
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvt = e;
  updateInstallCard();
});
window.addEventListener('appinstalled', () => {
  installEvt = null;
  $('#installCard').hidden = true;
  toast('装好了！以后从手机桌面打开「顺路」');
});
$('#installGo').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt();
  const r = await installEvt.userChoice.catch(() => null);
  installEvt = null;
  if (r?.outcome !== 'accepted') updateInstallCard();
  else $('#installCard').hidden = true;
});
$('#installX').addEventListener('click', () => {
  try {
    localStorage.setItem(INSTALL_KEY, '1');
  } catch {}
  $('#installCard').hidden = true;
});

/* 备份 */
$('#btnExport').addEventListener('click', async () => {
  if (!state.trips.length) return toast('还没有行程');
  const data = JSON.stringify({ app: 'shunlu', version: 2, trips: state.trips }, null, 1);
  const file = new File([data], `顺路备份-${new Date().toISOString().slice(0, 10)}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '顺路备份' });
      return;
    } catch {}
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('#btnImport').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const trips = Array.isArray(data.trips) ? data.trips : Array.isArray(data.places) ? [{ ...newTrip('导入的行程'), ...data, id: uid() }] : null;
    if (!trips) throw new Error('格式不对');
    let n = 0;
    for (const t of trips) {
      if (state.trips.some((x) => x.id === t.id)) t.id = uid();
      t.settings = { ...defaultSettings(), ...t.settings };
      t.plan = null;
      state.trips.push(t);
      n++;
    }
    save();
    renderTrips();
    toast(`导入了 ${n} 个行程`);
  } catch (err) {
    toast(`导入失败：${err.message}`);
  }
});

/* ================= 搜索框（选了才添加，每个结果有照片） ================= */

// 一行地点（搜索结果和热门景点共用）
function placeRowHtml(r, i, a, near, nearLabel) {
  const typeTxt = r.type ? typeZh(r.type) : kindLabel(r.kind);
  const meta = [typeTxt ? esc(typeTxt) : '', near ? `<span data-rd="${i}">${esc(nearLabel || '距离')} …</span>` : ''].filter(Boolean).join(' · ');
  return `<div class="sitem" data-i="${i}">
    <div class="si-thumb" data-prev="${i}">${kindIcon(r.kind)}</div>
    <div class="si-main" data-prev="${i}">
      <div class="si-name">${esc(r.name)}</div>
      ${r.alt ? `<div class="si-addr">${esc(r.alt)}</div>` : ''}
      ${meta ? `<div class="si-meta">${meta}</div>` : ''}
      ${r.address ? `<div class="si-addr">${esc(r.address)}</div>` : ''}
      ${r.hoursRaw ? `<div class="si-extra">${ic('clock', 12)} ${esc(r.hoursRaw)}</div>` : ''}
    </div>
    <button type="button" class="si-info" data-prev="${i}" aria-label="介绍">${ic('info', 19)}</button>
    <div class="si-act"><button type="button" data-pick="${i}" class="${a.state === 'in' || (a.done && !a.toggle) ? 'added' : a.state === 'sel' ? 'selected' : 'primary'}" ${a.done && !a.toggle ? 'disabled' : ''}>${esc(a.label)}</button></div>
  </div>`;
}

// 真实路程（开车或走路的时间和距离，来自路线服务）；算不出来才显示直线距离并写明
function roadText(road, label, profile = 'car') {
  return `${label} ${profile === 'foot' ? '走路' : '开车'} ${fmtDur(road.dur)} · ${fmtDist(road.dist)}`;
}
async function hydrateRoad(container, items, near, label, profile = 'car') {
  if (!near || !items.length || !container.querySelector('[data-rd]')) return;
  const rows = await travelRow(profile, near, items).catch(() => null);
  container.querySelectorAll('[data-rd]').forEach((el) => {
    const i = Number(el.dataset.rd);
    const r = rows?.[i];
    if (!items[i]) return;
    el.textContent = r ? roadText(r, label, profile) : `${label} 直线 ${fmtDist(haversine(near, items[i]))}`;
  });
}

// 把小图换成照片；找不到照片就显示地图小图（红点 = 位置）
function hydrateThumbs(container, items) {
  container.querySelectorAll('.si-thumb[data-prev]').forEach((el) => {
    const r = items[Number(el.dataset.prev)];
    if (!r) return;
    findPhoto(r).then((url) => {
      if (!el.isConnected) return;
      if (url) {
        r.photo = url;
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.onload = () => {
          el.textContent = '';
          el.appendChild(img);
        };
        img.onerror = () => showTile(el, r);
        img.src = url;
      } else showTile(el, r);
    });
  });
}
function showTile(el, r) {
  const t = tileThumb(r.lat, r.lon);
  const size = el.getBoundingClientRect().width || 56;
  const big = size * 4;
  el.textContent = '';
  el.classList.add('tile');
  // 图块放大 4 倍，并让地点落在正中间
  el.style.backgroundImage = `url(${t.url})`;
  el.style.backgroundSize = `${big}px ${big}px`;
  el.style.backgroundPosition = `${size / 2 - t.px * big}px ${size / 2 - t.py * big}px`;
}

// opts: { placeholder, near(): {lat,lon}|null, nearLabel(), bbox(): [w,s,e,n]|null, action(r): {label, done}, onPick(r) }
function createSearch(root, opts) {
  root.innerHTML = `
    <form class="sbox" autocomplete="off">
      <input type="search" placeholder="${esc(opts.placeholder)}" enterkeyhint="search">
      <button type="submit" class="primary">搜索</button>
    </form>
    ${opts.bulk ? `<button type="button" class="link bulk-link">${ic('clipboard', 15)} 一次贴上很多地点（从文章、小红书复制）</button>` : ''}
    <div class="sres-h" hidden></div>
    <div class="sres"></div>`;
  root.querySelector('.bulk-link')?.addEventListener('click', () => openBulk(opts.bulkAfter));
  const form = root.querySelector('form');
  const input = root.querySelector('input');
  const head = root.querySelector('.sres-h');
  const box = root.querySelector('.sres');
  let results = [];
  let approx = null; // 找不到准确地址时：{ label, exact } —— results[0] 是最接近的位置，后面是附近的地方
  let timer = null;
  let seq = 0;

  function draw() {
    const near = opts.near?.();
    const row = (r, i) => placeRowHtml(r, i, opts.action(r), near, opts.nearLabel?.());
    if (approx) {
      box.innerHTML =
        `<div class="sres-sec">${approx.exact ? '这个位置' : `找不到准确地址，最接近的是「${esc(approx.label)}」`}</div>` +
        row(results[0], 0) +
        (results.length > 1 ? `<div class="sres-sec">附近的地方（是不是其中一个？）</div>${results.slice(1).map((r, i) => row(r, i + 1)).join('')}` : '');
    } else box.innerHTML = results.map(row).join('');
    hydrateThumbs(box, results);
    hydrateRoad(box, results, near, opts.nearLabel?.() || '距离');
  }

  function showMsg(h, msg) {
    head.hidden = !h;
    head.textContent = h || '';
    box.innerHTML = msg ? `<div class="smsg">${msg}</div>` : '';
  }

  // 打字时：建议（中文输入法打拼音时先不查，选好字再查）
  let composing = false;
  let lastQ = '';
  input.addEventListener('compositionstart', () => (composing = true));
  input.addEventListener('compositionend', () => {
    composing = false;
    onType();
  });
  input.addEventListener('input', () => !composing && onType());
  input.addEventListener('keyup', () => !composing && onType());
  // 一次打很多个地方（用逗号、顿号、分号分开）：建议只看最后一个
  const MULTI_SEP = /[，,、;；|\n]+/;
  const segments = () => input.value.split(MULTI_SEP).map((x) => x.trim()).filter(Boolean);
  // 地址（「10 Lebuh Farquhar, George Town」）、链接、坐标本来就有逗号：当一个地方
  const ADDR = /jalan|lebuh|lorong|road|street|\brd\b|\bst\b|ave|路|街|号|丁目/i;
  const AREA = /^(malaysia|singapore|thailand|japan|korea|taiwan|penang|pulau pinang|george ?town|kuala lumpur|melaka|malacca|马来西亚|新加坡|泰国|日本|韩国|台湾|槟城|吉隆坡|马六甲)$/i;
  const isMultiInput = () => {
    const v = input.value.trim().replace(/[，,、;；|\s]+$/, '');
    if (!MULTI_SEP.test(v) || /https?:\/\//.test(v) || parseCoords(v) || (/\d/.test(v) && ADDR.test(v))) return false;
    // 「Penang Hill, Penang」后面那段只是地区：也当一个地方
    return placeSegs().length >= 2;
  };
  function placeSegs() {
    return segments().filter((x) => !AREA.test(x) && nameKey(x) !== nameKey(T()?.dest?.name));
  }
  function onType() {
    const full = input.value.trim();
    if (full === lastQ) return;
    lastQ = full;
    clearTimeout(timer);
    const multi = isMultiInput() || /[，,、;；|]\s*$/.test(full);
    const q = multi ? (/[，,、;；|]\s*$/.test(full) ? '' : segments().at(-1) || '') : full;
    if (multi && q.length < 2) {
      results = [];
      showMsg(`${placeSegs().length} 个地方 · 按「搜索」一次全部找出来`, '');
      return;
    }
    if (q.length < 2) {
      results = [];
      showMsg('', '');
      return;
    }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const r = await suggestPlaces(q, opts.near?.(), opts.bbox?.());
        if (my !== seq) return;
        approx = null;
        results = r;
        head.hidden = false;
        head.textContent = r.length
          ? multi ? `「${q}」的建议 · 按「搜索」就一次找全部 ${placeSegs().length} 个` : '建议（点照片看大图；地址或中文名找不到就按「搜索」）'
          : '';
        if (r.length) draw();
        else showMsg('', '没有建议，按「搜索」试试');
      } catch (e) {
        if (e.name !== 'AbortError') console.warn(e);
      }
    }, 350);
  }

  // 按搜索：完整搜索（会带营业时间）
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) return;
    input.blur();
    const my = ++seq;
    // 很多个地方：一个一个找，再一次确认
    const items = isMultiInput() ? parseBulk(q.split(MULTI_SEP).filter((x) => !AREA.test(x.trim())).join('\n')) : [];
    if (items.length >= 2) {
      const res = await runBulk(items, (msg) => showMsg(msg, ''), () => my === seq);
      if (!res) return;
      const msg = offerBulk(res, opts.bulkAfter);
      showMsg('', msg ? esc(msg) : '');
      if (!msg) {
        input.value = '';
        lastQ = '';
      }
      return;
    }
    showMsg('搜索中…', '');
    try {
      const res = await smartSearch(q, opts.bbox?.(), opts.near?.());
      if (my !== seq) return;
      if (res.approx) {
        approx = res.approx;
        results = [res.approx.point, ...(res.nearby || [])];
        head.hidden = false;
        head.textContent = '点照片看大图和地图，确认是对的再添加';
        draw();
        return;
      }
      approx = null;
      results = res.results;
      if (!results.length) {
        showMsg('', '找不到这个地方。<br>· 名字、地址都可以输入，任何语言都可以<br>· 也可以贴上 Google Maps 的链接或坐标<br>· 或者打开地图，在地图上<b>长按</b>选择');
        return;
      }
      head.hidden = false;
      head.textContent = `搜索结果（${results.length}）· 点照片看大图`;
      draw();
    } catch (err) {
      showMsg('', `搜索失败：${esc(err.message)}，请检查网络再试一次`);
    }
  });

  box.addEventListener('click', (e) => {
    const pick = e.target.closest('button[data-pick]');
    if (pick) {
      opts.onPick(results[Number(pick.dataset.pick)]);
      if (isMultiInput()) {
        input.value = `${segments().slice(0, -1).join('，')}，`;
        lastQ = input.value.trim();
      }
      draw();
      return;
    }
    const prev = e.target.closest('[data-prev]');
    if (prev) {
      const r = results[Number(prev.dataset.prev)];
      openPreview(r, opts.action, (x) => {
        opts.onPick(x);
        draw();
      }, opts.near?.(), opts.nearLabel?.());
    }
  });

  return {
    redraw: draw,
    clear() {
      input.value = '';
      lastQ = '';
      results = [];
      approx = null;
      showMsg('', '');
    },
    focus: () => input.focus(),
  };
}

/* ================= 地点详情：多张照片、介绍、营业时间、地图 ================= */

let pvMap = null;
let pvMarker = null;
let pvCurrent = null;
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 搜索结果 / 热门景点用：底部是「添加」
function openPreview(r, action, onPick, near, nearLabel) {
  openDetails(r, { action, onPick, near, nearLabel });
}

// opts: { action, onPick, near, nearLabel } 给还没加入的地点；{ inTrip: true } 给行程里的地点
function openDetails(r, opts = {}) {
  pvCurrent = { r, ...opts };
  const t = T();
  $('#pvName').textContent = r.name;
  $('#pvTitle').textContent = r.name;
  $('#pvAlt').textContent = r.alt || '';
  const near = opts.near || (opts.inTrip ? t?.home : null);
  const nearLabel = opts.nearLabel || '离住的地方';
  const typeTxt = r.type ? typeZh(r.type) : kindLabel(r.kind);
  $('#pvMeta').innerHTML = (typeTxt ? `<span class="chip">${esc(typeTxt)}</span>` : '') + (near ? `<span class="chip" data-rd="0">${esc(nearLabel)} …</span>` : '');
  if (near) hydrateRoad($('#pvMeta'), [r], near, nearLabel);

  // 行程里的安排
  let planHtml = '';
  if (opts.inTrip) {
    const st = (isMulti(t) ? t.dayPlans?.[r.day] : t.plan)?.stops.find((x) => x.id === r.id);
    const dayTxt = t.days > 1 && r.day ? `第 ${r.day} 天 · ` : '';
    if (r.done) planHtml = `<div class="dt-plan ok">${ic('check', 16)} 已经去过了</div>`;
    else if (st) planHtml = `<div class="dt-plan">${ic('calendar', 16)} ${dayTxt}${fmtClock(st.start)} – ${fmtClock(st.depart)} · 停留 ${fmtDur(st.depart - st.start)}</div>`;
    else if (dayTxt) planHtml = `<div class="dt-plan">${ic('calendar', 16)} ${dayTxt}停留 ${r.stayMin} 分钟</div>`;
    if (st?.flag === 'closed') planHtml += `<div class="note bad">${ic('alert', 14)} 按现在的安排，到的时候已经关门</div>`;
    else if (st?.flag === 'short') planHtml += `<div class="note warn">${ic('clock', 14)} ${fmtClock(st.closeAt)} 关门，只能待 ${fmtDur(st.closeAt - st.start)}</div>`;
  }
  $('#pvPlan').innerHTML = planHtml;

  // 照片：先放一张，详细资料到了再换成多张
  $('#pvGallery').innerHTML = '<div class="gal-empty">正在找照片…</div>';
  findPhoto(r).then((url) => {
    if (pvCurrent?.r !== r) return;
    if (url && !$('#pvGallery').querySelector('img')) renderGallery([url.replace(/width=\d+/, 'width=800')]);
    else if (!url && !$('#pvGallery').querySelector('img')) $('#pvGallery').innerHTML = '<div class="gal-empty">网上没有找到这个地方的照片<br>请看下面的地图确认位置</div>';
  });

  $('#pvDesc').innerHTML = '<div class="dt-loading">正在找介绍…</div>';
  placeDetails(r).then((d) => {
    if (pvCurrent?.r !== r) return;
    if (d.gallery.length) renderGallery(d.gallery);
    const desc = d.extract || d.description;
    $('#pvDesc').innerHTML = desc
      ? `<p>${esc(desc).replace(/\n/g, '<br>')}</p>${d.wikiUrl ? `<a href="${esc(d.wikiUrl)}" target="_blank" rel="noopener">来自维基百科${d.extractLang === 'en' ? '（英文）' : ''}，看全文 ›</a>` : ''}`
      : '';
    if (d.website && !r.website) renderInfo(r, d.website);
  });
  renderInfo(r);

  // 底部按钮
  const foot = $('#pvFoot');
  if (opts.inTrip) {
    foot.innerHTML = `<button data-dt="nav">${ic('nav', 16)} 导航</button><button data-dt="edit">${ic('edit', 16)} 编辑</button>${r.done ? `<button data-dt="undo">${ic('undo', 16)} 恢复</button>` : `<button data-dt="done" class="primary">${ic('check', 16)} 去过了</button>`}`;
  } else {
    const a = opts.action(r);
    foot.innerHTML = `<button data-dt="add" class="primary" ${a.done ? 'disabled' : ''}>${esc(a.label)}</button>`;
  }

  $('#previewDialog').showModal();
  $('#previewDialog .dbody').scrollTop = 0;
  if (!pvMap) {
    pvMap = new maplibregl.Map({
      container: 'pvMap',
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [r.lon, r.lat],
      zoom: 15,
      attributionControl: { compact: true },
    });
    pvMarker = new maplibregl.Marker({ color: '#dc2626' }).setLngLat([r.lon, r.lat]).addTo(pvMap);
    // 版权文字先收起来（按 ⓘ 可以看），不然会挡住小地图
    pvMap.on('load', () => document.querySelectorAll('#pvMap .maplibregl-compact-show').forEach((e) => e.classList.remove('maplibregl-compact-show')));
  } else {
    pvMap.resize();
    pvMap.jumpTo({ center: [r.lon, r.lat], zoom: 15 });
    pvMarker.setLngLat([r.lon, r.lat]);
  }
}

function renderGallery(urls) {
  const g = $('#pvGallery');
  g.innerHTML = `<div class="gal-track">${urls.map((u) => `<img src="${esc(u)}" alt="" decoding="async">`).join('')}</div>
    ${urls.length > 1 ? `<div class="gal-count">1 / ${urls.length}</div>` : ''}`;
  const track = g.querySelector('.gal-track');
  const count = g.querySelector('.gal-count');
  // 坏掉的照片拿掉
  track.querySelectorAll('img').forEach((img) => (img.onerror = () => img.remove()));
  if (count) {
    track.addEventListener('scroll', () => {
      const i = Math.round(track.scrollLeft / track.clientWidth) + 1;
      count.textContent = `${i} / ${track.querySelectorAll('img').length}`;
    });
  }
}

// 资料列表：营业时间（一整个星期）、地址、官网、电话、Google Maps
function renderInfo(r, extraWebsite = '') {
  const rows = [];
  const week = [];
  const today = new Date();
  let known = false;
  for (let k = 1; k <= 7; k++) {
    const d = new Date(today);
    d.setDate(today.getDate() + ((k - today.getDay() + 7) % 7)); // 这个星期的周一 … 周日
    const h = placeHoursOn(r, d);
    if (h.known) known = true;
    const txt = !h.known ? '未知' : h.windows.length ? h.windows.map(([o, c]) => `${minToHHMM(o)}–${minToHHMM(c)}`).join('，') : '休息';
    week.push(`<div class="wk ${d.getDay() === today.getDay() ? 'today' : ''}"><span>${WEEK[d.getDay()]}</span><b>${esc(txt)}</b></div>`);
  }
  rows.push(`<div class="info-row"><div class="ir-ic">${ic('clock', 18)}</div><div class="ir-main"><div class="ir-t">营业时间${r.manual ? '（你手动设的）' : ''}</div>${
    known ? `<div class="week">${week.join('')}</div>` : `<div class="muted">${r.hoursRaw ? esc(r.hoursRaw) : '地图上没有资料，出发前请自己确认'}</div>`
  }</div></div>`);
  if (r.address) rows.push(`<div class="info-row"><div class="ir-ic">${ic('pin', 18)}</div><div class="ir-main"><div class="ir-t">地址</div><div>${esc(r.address)}</div></div></div>`);
  const site = r.website || extraWebsite;
  if (site) rows.push(`<a class="info-row" href="${esc(site)}" target="_blank" rel="noopener"><div class="ir-ic">${ic('globe', 18)}</div><div class="ir-main"><div class="ir-t">官方网站</div><div class="link-txt">${esc(site.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</div></div></a>`);
  if (r.phone) rows.push(`<a class="info-row" href="tel:${esc(r.phone.replace(/\s/g, ''))}"><div class="ir-ic">${ic('phone', 18)}</div><div class="ir-main"><div class="ir-t">电话</div><div class="link-txt">${esc(r.phone)}</div></div></a>`);
  const tk = T() && ticketText(T(), r);
  if (tk) rows.push(`<div class="info-row"><div class="ir-ic">${ic('ticket', 18)}</div><div class="ir-main"><div class="ir-t">门票</div><div>${esc(tk)}</div></div></div>`);
  if (r.note) rows.push(`<div class="info-row"><div class="ir-ic">${ic('note', 18)}</div><div class="ir-main"><div class="ir-t">备注</div><div>${esc(r.note)}</div></div></div>`);
  const q = encodeURIComponent(r.en || r.name);
  rows.push(`<a class="info-row" href="https://www.google.com/maps/search/?api=1&query=${q}%20${r.lat},${r.lon}" target="_blank" rel="noopener"><div class="ir-ic">${ic('star', 18)}</div><div class="ir-main"><div class="ir-t">评价和更多照片</div><div class="link-txt">在 Google Maps 打开</div></div></a>`);
  $('#pvInfo').innerHTML = rows.join('');
}

$('#pvFoot').addEventListener('click', (e) => {
  const act = e.target.closest('[data-dt]')?.dataset.dt;
  if (!act || !pvCurrent) return;
  const { r } = pvCurrent;
  if (act === 'add') {
    pvCurrent.onPick(r);
    $('#previewDialog').close();
  } else if (act === 'nav') openNav(r);
  else if (act === 'edit') {
    $('#previewDialog').close();
    openPlaceDialog(r.id);
  } else if (act === 'done' || act === 'undo') {
    $('#previewDialog').close();
    markDone(r.id, act === 'done');
  }
});
$('#pvClose').addEventListener('click', () => $('#previewDialog').close());

// 补查营业时间：有 OSM 编号就直接查；热门景点没有编号，就用名字在附近找
async function fillDetails(place) {
  if (!place.needsDetails) return;
  delete place.needsDetails;
  try {
    let d = null;
    if (place.osm) d = await lookupDetails(place.osm);
    else {
      const box = [place.lon - 0.004, place.lat - 0.004, place.lon + 0.004, place.lat + 0.004];
      const found = await searchPlaces(place.en || place.name, box, true);
      d = found.find((x) => haversine(x, place) < 400) || null;
      if (d?.osm) place.osm = d.osm;
    }
    if (d) {
      place.website ||= d.website || '';
      place.phone ||= d.phone || '';
      place.fee ||= d.fee || '';
      place.charge ||= d.charge || '';
    }
    if (d?.hoursRaw && !place.hoursRaw) {
      place.hoursRaw = d.hoursRaw;
      save();
      if (currentView === 'map') {
        renderMap();
        scheduleReplan(300);
      } else if (currentView === 'setup') renderSetupPlaces();
    }
  } catch (e) {
    console.warn(e);
  }
}

function makePlace(r) {
  return {
    id: uid(),
    name: r.name,
    en: r.en || '',
    address: r.address || r.alt || '',
    lat: r.lat,
    lon: r.lon,
    osm: r.osm || null,
    wikidata: r.wikidata || null,
    photo: r.photo || null,
    kind: r.kind || '',
    type: r.type || '',
    hoursRaw: r.hoursRaw || null,
    website: r.website || '',
    phone: r.phone || '',
    fee: r.fee || '',
    charge: r.charge || '',
    ticket: r.ticket ?? null, // 门票（每人），自己填的
    needsDetails: !!r.needsDetails || !r.hoursRaw,
    manual: null,
    stayMin: r.stayMin || Number(T().settings.defaultStay) || 60,
    note: r.note || '',
    done: false,
  };
}

function addPlaceToTrip(r) {
  const t = T();
  const dup = t.places.find((p) => samePlace(p, r));
  if (dup) {
    if (dup.done) {
      dup.done = false;
      save();
      toast(`「${dup.name}」重新加回行程`);
    }
    return dup;
  }
  const p = makePlace(r);
  t.places.push(p);
  // 手动排过顺序的话，新地点先放最后
  if (isMulti(t)) {
    p.day = guessDay(t, p);
    if (!t.curDay) refineDay(t, p);
  }
  const mo = getManual(t, isMulti(t) ? p.day : null);
  if (mo) mo.push(p.id);
  save();
  fillDetails(p);
  return p;
}

function setHome(r) {
  T().home = { name: r.name, address: r.address || '', lat: r.lat, lon: r.lon };
  T().settings.startFrom = 'home';
  save();
}

// 搜索时以哪里为中心：住的地方 > 城市中心 > 已添加的地点 > 上次的位置
function searchCenter() {
  const t = T();
  if (t?.home) return t.home;
  if (t?.dest) return t.dest;
  const p = t?.places.find((x) => !x.done);
  if (p) return p;
  return lastGps;
}
const cityBbox = () => T()?.dest?.bbox || null;

/* ================= 住宿：每晚住哪里、建议住哪一区 ================= */

// 第 n 晚住哪里（多天行程可以换酒店）。trip.home = 第 1 晚；trip.stays = [{ from: 第几晚开始, hotel }]
function hotelForNight(t, n) {
  let h = t.home || null;
  for (const s of [...(t.stays || [])].sort((a, b) => a.from - b.from)) if (s.from <= n) h = s.hotel;
  return h;
}
// 某一天从哪间出发、晚上回哪间
const startHotel = (t, day) => (day == null ? t.home : hotelForNight(t, day === 1 ? 1 : day - 1));
const endHotel = (t, day) => (day == null ? t.home : day > nights(t) ? null : hotelForNight(t, day));
const sameHotel = (a, b) => (!a && !b) || (a && b && Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5);
// 4 天 = 3 晚（最后一天退房后去玩，不用回酒店）；勾了「最后一天也住」就是 4 晚
const nights = (t) => Math.max(1, (t.days || 1) > 1 && !t.stayLastNight ? t.days - 1 : t.days || 1);
// 入住 / 退房时间（只是提醒，不会硬性排进路线）
const DEFAULT_IN = '15:00';
const DEFAULT_OUT = '12:00';
const checkInOf = (h) => h?.checkIn || DEFAULT_IN;
const checkOutOf = (h) => h?.checkOut || DEFAULT_OUT;
// 同一间酒店的每一晚都一起改
function setHotelTimes(t, hotel, field, value) {
  for (const h of [t.home, ...(t.stays || []).map((x) => x.hotel)]) if (h && sameHotel(h, hotel)) h[field] = value;
  save();
}
// 换酒店时保留原本填的时间；新的酒店给常见的 15:00 入住、12:00 退房
function withTimes(t, hotel) {
  if (!hotel) return hotel;
  const old = [t.home, ...(t.stays || []).map((x) => x.hotel)].find((h) => h && sameHotel(h, hotel));
  return { ...hotel, checkIn: hotel.checkIn || old?.checkIn || DEFAULT_IN, checkOut: hotel.checkOut || old?.checkOut || DEFAULT_OUT };
}
const hasAnyHotel = (t) => Array.from({ length: nights(t) }, (_, i) => hotelForNight(t, i + 1)).some(Boolean);
// 所有不同的酒店（地图上显示用）
function allHotels(t) {
  const out = [];
  for (let n = 1; n <= nights(t); n++) {
    const h = hotelForNight(t, n);
    if (h && !out.some((x) => sameHotel(x, h))) out.push(h);
  }
  return out;
}

// 设定第 n 晚开始住 hotel；之后原本跟第 n 晚住同一间的晚上也一起换
function setHotelFrom(t, n, hotel) {
  hotel = withTimes(t, hotel);
  const N = nights(t);
  const before = Array.from({ length: N }, (_, i) => hotelForNight(t, i + 1));
  const after = [...before];
  for (let k = n; k <= N && sameHotel(before[k - 1], before[n - 1]); k++) after[k - 1] = hotel;
  // 重新写成 home + stays
  t.home = after[0];
  t.stays = [];
  for (let k = 2; k <= N; k++) if (!sameHotel(after[k - 1], after[k - 2])) t.stays.push({ from: k, hotel: after[k - 1] });
  if (hotel) t.settings.startFrom = 'home';
  save();
}

// 这几晚设成同一间（建议用）
function setHotelRange(t, from, to, hotel) {
  hotel = withTimes(t, hotel);
  const N = nights(t);
  const after = Array.from({ length: N }, (_, i) => hotelForNight(t, i + 1));
  for (let k = from; k <= to; k++) after[k - 1] = hotel;
  t.home = after[0];
  t.stays = [];
  for (let k = 2; k <= N; k++) if (!sameHotel(after[k - 1], after[k - 2])) t.stays.push({ from: k, hotel: after[k - 1] });
  t.settings.startFrom = 'home';
  save();
}

/* ---- 住宿列表（第 3 步） ---- */

let stayTarget = 1; // 正在帮第几晚选酒店

function renderStays() {
  const t = T();
  const N = nights(t);
  const rows = [];
  for (let n = 1; n <= N; n++) {
    const h = hotelForNight(t, n);
    const label = N > 1 ? `第 ${n} 晚 · ${fmtDay(t, n)}` : '住宿';
    const changed = n > 1 && !sameHotel(h, hotelForNight(t, n - 1));
    // 每间酒店的第一晚：填入住、退房时间
    const first = h && (n === 1 || changed);
    rows.push(`<div class="stay-row ${n === stayTarget ? 'on' : ''} ${changed ? 'changed' : ''}" data-night="${n}">
      <div class="sr-ic">${ic('bed', 18)}</div>
      <div class="sr-main"><div class="sr-label">${esc(label)}${changed ? ' <span class="badge">换酒店</span>' : ''}</div>
        <div class="sr-name">${h ? esc(h.name) : '<span class="muted">还没选</span>'}</div>
        ${first ? `<div class="sr-times" data-hn="${n}">
          <label>入住 <input type="time" data-ht="checkIn" value="${esc(checkInOf(h))}"></label>
          <label>退房 <input type="time" data-ht="checkOut" value="${esc(checkOutOf(h))}"></label></div>` : ''}</div>
      <button type="button" class="sr-btn" data-stay="${n}">${h ? '更换' : '选酒店'}</button>
    </div>`);
  }
  if ((t.days || 1) > 1) {
    rows.push(`<label class="check last-night"><input type="checkbox" id="stayLast" ${t.stayLastNight ? 'checked' : ''}>
      <span>第 ${t.days} 天（最后一天）晚上也住<small>不勾 = ${t.days} 天 ${t.days - 1} 晚，最后一天退房后去玩，不用回酒店</small></span></label>`);
  }
  $('#stayList').innerHTML = rows.join('');
  $('#homeSearchLabel').textContent = N > 1
    ? `为第 ${stayTarget} 晚${stayTarget < N ? '（和之后住同一间的晚上）' : ''}选酒店：`
    : '搜索酒店名字或地址：';
  $('#skipHome').hidden = hasAnyHotel(t);
}

$('#stayList').addEventListener('change', (e) => {
  const t = T();
  if (e.target.id === 'stayLast') {
    // 最后一晚没另外选的话，会沿用前一晚的酒店
    t.stayLastNight = e.target.checked;
    if (t.dayPlans) delete t.dayPlans[t.days];
    staySugg = null;
    save();
    renderStays();
    return;
  }
  const field = e.target.dataset.ht;
  const row = e.target.closest('[data-hn]');
  if (!field || !row || !e.target.value) return;
  setHotelTimes(t, hotelForNight(t, Number(row.dataset.hn)), field, e.target.value);
  toast(`${field === 'checkIn' ? '入住' : '退房'}时间：${e.target.value}（只是提醒，不会硬性排）`);
});
$('#stayList').addEventListener('click', (e) => {
  if (e.target.closest('.sr-times, .last-night')) return;
  const b = e.target.closest('[data-stay]') || e.target.closest('.stay-row');
  if (!b) return;
  stayTarget = Number(b.dataset.stay || b.dataset.night);
  renderStays();
  homeSearch.focus();
});

/* ---- 建议住哪一区 ---- */

// 几何中位数（只用来定「方向切段」的中心；真正挑地方都用真实路程）
function medianPoint(ps) {
  if (!ps.length) return null;
  let x = { lat: ps.reduce((a, p) => a + p.lat, 0) / ps.length, lon: ps.reduce((a, p) => a + p.lon, 0) / ps.length };
  for (let it = 0; it < 30; it++) {
    let wl = 0;
    let wa = 0;
    let wo = 0;
    for (const p of ps) {
      const d = Math.max(30, haversine(x, p));
      wl += 1 / d;
      wa += p.lat / d;
      wo += p.lon / d;
    }
    x = { lat: wa / wl, lon: wo / wl };
  }
  return x;
}

let staySugg = null; // { groups: [{from, to, point, anchor, area, hotels}], single, savedMin }

// 建议住哪里：全部用真实路程（开车 / 走路的时间，来自路线服务）
// 候选的中心就是你会去的那些地点（一定在有路的地方），挑「到其他地点来回总时间最短」的那个
async function computeStaySuggestions() {
  const t = T();
  const places = t.places.filter((p) => !p.done);
  if (!places.length) return null;
  const N = nights(t);
  // 多天：先按地区把地点分到每一天
  if (N > 1 && places.some((p) => !(p.day >= 1 && p.day <= N))) await arrangeTrip(t);
  const { leg } = await buildTravel(t, places, false);
  const dur = (i, j) => (i === j ? 0 : leg(i, j).dur);
  const all = places.map((_, i) => i);
  const dayIds = (d) => all.filter((i) => N === 1 || places[i].day === d);
  const center = (ids) => {
    if (!ids.length) return null;
    let best = ids[0];
    let bestSum = Infinity;
    for (const c of ids) {
      const sum = ids.reduce((acc, j) => acc + dur(c, j) + dur(j, c), 0);
      if (sum < bestSum) {
        bestSum = sum;
        best = c;
      }
    }
    return best;
  };
  // 第 n 晚：照顾当天（晚上回去）和隔天（早上出发）
  const nightIds = (n) => [...new Set([...dayIds(n), ...(n < N ? dayIds(n + 1) : [])])];
  // 相邻晚上的中心来回不到 25 分钟，就住同一间
  const groups = [];
  for (let n = 1; n <= N; n++) {
    const c = center(nightIds(n)) ?? center(all);
    const g = groups[groups.length - 1];
    if (g && dur(g.c, c) + dur(c, g.c) < 25 * 60e3) {
      g.to = n;
      g.c = center([...new Set(Array.from({ length: g.to - g.from + 1 }, (_, k) => nightIds(g.from + k)).flat())]);
    } else groups.push({ from: n, to: n, c });
  }
  // 每天：住的地方 → 当天最近的地点，加上 当天最近的地点 → 住的地方（真实时间）
  const cost = (hubOf) => {
    let m = 0;
    for (let d = 1; d <= N; d++) {
      const ids = dayIds(d);
      if (!ids.length) continue;
      const hs = hubOf(d === 1 ? 1 : d - 1);
      const he = hubOf(d);
      m += Math.min(...ids.map((j) => dur(hs, j))) + Math.min(...ids.map((j) => dur(j, he)));
    }
    return m;
  };
  const single = { from: 1, to: N, c: center(all) };
  const savedMin = Math.round((cost(() => single.c) - cost((n) => groups.find((g) => n >= g.from && n <= g.to).c)) / 60e3);
  // 省不到 30 分钟就不建议换（换酒店本身也要时间）
  const useGroups = groups.length > 1 && savedMin >= 30 ? groups : [single];
  const withPoint = (g) => Object.assign(g, { point: { lat: places[g.c].lat, lon: places[g.c].lon }, anchor: places[g.c].name });
  useGroups.forEach(withPoint);
  withPoint(single);
  staySugg = { groups: useGroups, single, savedMin, switching: useGroups.length > 1 };
  // 区域名字
  await Promise.all([...useGroups, single].map(async (g) => (g.area = await areaName(g.point))));
  return staySugg;
}

async function areaName(p) {
  // 「Mukim 17」这种行政编号看不懂：优先用附近的地名（区、街坊）
  const odd = (x) => !x || /mukim|^\d|ward\b|^district\s*\d/i.test(x);
  try {
    const q = `lat=${p.lat.toFixed(5)}&lon=${p.lon.toFixed(5)}&limit=6&radius=3`;
    const res = await fetch(`https://photon.komoot.io/reverse?${q}&layer=locality&layer=district`);
    const fs = (await res.json()).features || [];
    const hit = fs.map((f) => f.properties).find((x) => !odd(x.name));
    if (hit) return hit.city && hit.city !== hit.name && !hit.name.includes(hit.city) ? `${hit.name}（${hit.city}）` : hit.name;
    return fs[0]?.properties?.city || '这一带';
  } catch {
    return '这一带';
  }
}

async function hotelsNear(p) {
  const d = 0.02;
  const params = new URLSearchParams({
    q: 'hotel', lat: p.lat.toFixed(5), lon: p.lon.toFixed(5), limit: '12',
    bbox: [p.lon - d, p.lat - d, p.lon + d, p.lat + d].map((x) => x.toFixed(5)).join(','),
  });
  ['tourism:hotel', 'tourism:guest_house', 'tourism:hostel', 'tourism:apartment'].forEach((tag) => params.append('osm_tag', tag));
  const res = await fetch(`https://photon.komoot.io/api/?${params}`);
  const data = await res.json();
  return data.features
    .map((f) => {
      const q = f.properties;
      return {
        name: q.name || '酒店',
        address: [q.street && [q.street, q.housenumber].filter(Boolean).join(' '), q.district, q.city].filter(Boolean).join(', '),
        lat: f.geometry.coordinates[1],
        lon: f.geometry.coordinates[0],
        osm: q.osm_type && q.osm_id ? `${q.osm_type}${q.osm_id}` : null,
        kind: q.osm_value || 'hotel',
      };
    })
    .filter((h) => h.name)
    .sort((a, b) => haversine(p, a) - haversine(p, b))
    .slice(0, 8);
}

let suggLoading = false;
async function renderStaySuggest(force = false) {
  const t = T();
  const box = $('#staySuggest');
  if (!t.places.some((p) => !p.done)) {
    box.innerHTML = '<div class="sugg-card muted">先在第 2 步添加想去的地方，就能建议住哪一区。</div>';
    return;
  }
  if (!staySugg || force) {
    if (suggLoading) return;
    suggLoading = true;
    box.innerHTML = `<div class="sugg-card"><div class="sugg-loading">${ic('compass', 18)} 正在根据你要去的地方，找最适合住的区域…</div></div>`;
    try {
      await computeStaySuggestions();
    } catch (e) {
      box.innerHTML = `<div class="sugg-card muted">暂时算不出建议（${esc(e.message)}）</div>`;
      return;
    } finally {
      suggLoading = false;
    }
  }
  const s = staySugg;
  const N = nights(t);
  const range = (g) => (N === 1 ? '' : g.from === g.to ? `第 ${g.from} 晚` : `第 ${g.from}–${g.to} 晚`);
  const groupHtml = (g, key) => `<div class="sugg-group" data-g="${key}">
      <div class="sg-head">
        <div class="sg-pin">${ic('pin', 18)}</div>
        <div class="sg-main"><div class="sg-range">${esc(range(g)) || '建议住在'}</div><div class="sg-area">${esc(g.area || '…')} 附近</div>${g.anchor ? `<div class="sg-anchor">靠近 ${esc(g.anchor)}</div>` : ''}</div>
        <button type="button" class="sg-btn" data-hotels="${key}">看附近酒店</button>
      </div>
      <div class="sg-hotels" id="sgh-${key}"></div>
    </div>`;
  let html = `<div class="sugg-card"><div class="sugg-title">${ic('sparkles', 18)} 建议住哪里</div>`;
  if (s.switching) {
    html += `<p class="sugg-text">你的地点分散在不同区域。<b>换 ${s.groups.length - 1} 次酒店</b>，${N} 天大约可以少开 <b>${fmtDur(s.savedMin * 60e3)}</b> 车（按真实路程估计；选好酒店后会再按实际酒店位置重新分配）。</p>`;
    html += s.groups.map((g, i) => groupHtml(g, `m${i}`)).join('');
    html += `<p class="sugg-alt">不想换酒店？全程住在「${esc(s.single.area || '')}」附近最平均。</p>${groupHtml(s.single, 's')}`;
  } else {
    const why = s.savedMin > 0 ? `换酒店只省大约 ${s.savedMin} 分钟车程` : '每天要去的地方开车都不算远';
    html += `<p class="sugg-text">${N > 1 ? `${why}，<b>住一间就好</b>。` : ''}住在这里，去你选的地方最顺（按真实开车时间算）：</p>`;
    html += groupHtml(s.groups[0], 'g0');
  }
  html += `<button type="button" class="link" id="suggRefresh">重新计算建议</button></div>`;
  box.innerHTML = html;
}

$('#staySuggest').addEventListener('click', async (e) => {
  if (e.target.closest('#suggRefresh')) return renderStaySuggest(true);
  const hb = e.target.closest('[data-hotels]');
  if (hb) {
    const key = hb.dataset.hotels;
    const g = key === 's' ? staySugg.single : staySugg.groups[Number(key.slice(1))];
    const box = $(`#sgh-${key}`);
    if (box.dataset.open) {
      box.innerHTML = '';
      delete box.dataset.open;
      return;
    }
    box.dataset.open = '1';
    box.innerHTML = '<div class="smsg">正在找附近的酒店…</div>';
    try {
      g.hotels = await hotelsNear(g.point);
      // 按真实开车时间排（一次请求）
      const rows = await travelRow('car', g.point, g.hotels).catch(() => []);
      g.hotels.forEach((h, i) => (h.road = rows[i] || null));
      g.hotels.sort((a, b) => (a.road?.dur ?? 1e9) - (b.road?.dur ?? 1e9));
    } catch {
      g.hotels = [];
    }
    if (!g.hotels.length) {
      box.innerHTML = '<div class="smsg">附近没找到有资料的酒店，可以在下面自己搜索。</div>';
      return;
    }
    const N = nights(T());
    const lbl = N === 1 ? '选这间' : g.from === g.to ? `选（第 ${g.from} 晚）` : `选（第 ${g.from}–${g.to} 晚）`;
    box.innerHTML = `<div class="sres">${g.hotels.map((h, i) => placeRowHtml(h, i, { label: lbl, done: false }, g.point, '离建议中心')).join('')}</div>`;
    box.dataset.key = key;
    hydrateThumbs(box, g.hotels);
    hydrateRoad(box, g.hotels, g.point, '离建议中心');
    return;
  }
  const pick = e.target.closest('button[data-pick]');
  const prev = e.target.closest('[data-prev]');
  const box = e.target.closest('.sg-hotels');
  if (!box || (!pick && !prev)) return;
  const key = box.dataset.key;
  const g = key === 's' ? staySugg.single : staySugg.groups[Number(key.slice(1))];
  const h = g.hotels[Number((pick || prev).dataset.pick ?? prev.dataset.prev)];
  const choose = (x) => {
    setHotelRange(T(), g.from, g.to, { name: x.name, address: x.address, lat: x.lat, lon: x.lon });
    toast(`已选：${x.name}`);
    renderSetup();
  };
  if (pick) choose(h);
  else openPreview(h, () => ({ label: '选这间', done: false }), choose, g.point, '离建议中心');
});

/* ================= 设置行程（4 步：目的地 → 去哪里 → 住哪里 → 出发） ================= */

let setupStep = 1;
let setupEdit = false;

const homeSearch = createSearch($('#homeSearch'), {
  placeholder: '酒店名字或地址（任何语言都可以）',
  near: searchCenter,
  nearLabel: () => (T()?.home ? '离住的地方' : '离市中心'),
  bbox: cityBbox,
  action: (r) => {
    const on = !!(T()?.home && samePlace(T().home, r));
    return { label: on ? '✓ 已选' : '选这个', done: on };
  },
  onPick: (r) => {
    const t = T();
    setHotelFrom(t, stayTarget, { name: r.name, address: r.address || '', lat: r.lat, lon: r.lon });
    homeSearch.clear();
    // 下一晚如果还没选，自动跳到下一晚
    const next = Array.from({ length: nights(t) }, (_, i) => i + 1).find((n) => !hotelForNight(t, n));
    if (next) stayTarget = next;
    renderSetup();
    toast(`已选：${r.name}`);
  },
});

/* ---- 多选：先选好，再一次确认加入 ---- */

const picked = []; // 已选、还没加入的地点
const inTrip = (r) => !!T()?.places.some((p) => !p.done && samePlace(p, r));
const pickedIndex = (r) => picked.findIndex((x) => samePlace(x, r));

const placeAction = (r) => {
  if (inTrip(r)) return { label: '✓ 已加入', done: true, state: 'in', toggle: true };
  if (pickedIndex(r) >= 0) return { label: '✓ 已选', state: 'sel', toggle: true };
  return { label: '选择', state: '', toggle: true };
};

// 按一下选，再按一下取消；已经在行程里的，再按就移除（可以撤销）
function pickPlace(r) {
  if (inTrip(r)) {
    const t = T();
    const idx = t.places.findIndex((p) => !p.done && samePlace(p, r));
    const p = t.places[idx];
    t.places.splice(idx, 1);
    Object.values(t.manualOrders || {}).forEach((arr) => arr.includes(p.id) && arr.splice(arr.indexOf(p.id), 1));
    save();
    snackbar(`已从行程移除「${p.name}」`, () => {
      t.places.splice(idx, 0, p);
      save();
      refreshPickViews();
    });
  } else {
    const i = pickedIndex(r);
    if (i >= 0) picked.splice(i, 1);
    else picked.push(r);
  }
  refreshPickViews();
}

function refreshPickViews() {
  if (currentView === 'setup') {
    renderSetupPlaces();
    if (setupStep === 2) renderPopular();
  }
  addSearch.redraw();
  if (currentView === 'map') renderMap();
  updatePickUI();
}

function updatePickUI() {
  const n = picked.length;
  $('#pickBar').hidden = !(currentView === 'setup' && setupStep === 2 && n);
  $('#pickCount').textContent = n;
  $('#pickNames').textContent = picked.map((r) => r.name).join('、');
  $('#addDone').textContent = n ? `加入 ${n} 个地点` : '完成';
}

// 弹出确认：要加入这些吗？
let pickAfter = null;
function confirmPicked(after = null, title = null, missing = []) {
  if (!picked.length) return after?.();
  pickAfter = after;
  $('#pkMiss').hidden = !missing.length;
  $('#pkMiss').textContent = missing.length ? `找不到：${missing.join('、')}（可以自己再搜索，或换英文名字）` : '';
  renderPickDialog(title);
  $('#pickDialog').showModal();
}
function renderPickDialog(title) {
  $('#pkTitle').textContent = title || `加入这 ${picked.length} 个地点？`;
  $('#pkList').innerHTML = picked
    .map((r, i) => `<div class="sitem"><div class="si-thumb sm" data-prev="${i}">${kindIcon(r.kind)}</div>
      <div class="si-main"><div class="si-name">${esc(r.name)}</div>${r.alt || r.address ? `<div class="si-addr">${esc(r.alt || r.address)}</div>` : ''}</div>
      <button type="button" class="pi-del" data-unpick="${i}" aria-label="不要这个">${ic('x', 16)}</button></div>`)
    .join('');
  $('#pkOk').textContent = pickAfter ? `加入并继续（${picked.length}）` : `确定加入（${picked.length}）`;
  hydrateThumbs($('#pkList'), picked);
}
$('#pkList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-unpick]');
  if (!b) return;
  picked.splice(Number(b.dataset.unpick), 1);
  refreshPickViews();
  if (!picked.length) return $('#pickDialog').close();
  renderPickDialog();
});
$('#pkCancel').addEventListener('click', () => {
  pickAfter = null;
  $('#pickDialog').close();
});
$('#pkOk').addEventListener('click', () => {
  const list = picked.splice(0);
  list.forEach((r) => addPlaceToTrip(r));
  if ($('#addDialog').open) addedInDialog += list.length;
  $('#pickDialog').close();
  toast(`已加入 ${list.length} 个地点（共 ${T().places.filter((p) => !p.done).length} 个）`);
  staySugg = null;
  refreshPickViews();
  const after = pickAfter;
  pickAfter = null;
  after?.();
});
$('#pickAdd').addEventListener('click', () => confirmPicked());
$('#pickClear').addEventListener('click', () => {
  picked.splice(0);
  refreshPickViews();
});

const placeSearch = createSearch($('#placeSearch'), {
  placeholder: '地名、地址、链接；多个用逗号分开',
  near: searchCenter,
  nearLabel: () => (T()?.home ? '离住的地方' : '离市中心'),
  bbox: cityBbox,
  action: placeAction,
  onPick: pickPlace,
  bulk: true,
});

function openSetup({ edit, step }) {
  picked.splice(0);
  setupEdit = edit;
  setupStep = step || 1;
  homeSearch.clear();
  placeSearch.clear();
  showView('setup');
  renderSetup();
}

function renderSetup() {
  const t = T();
  if (!t) return showView('trips');
  $('#setupTitle').textContent = setupEdit ? `修改：${t.name}` : '规划新行程';
  const okStep = { 1: !!t.dest, 2: t.places.length > 0, 3: hasAnyHotel(t), 4: false };
  document.querySelectorAll('#stepTabs button').forEach((b) => {
    const n = Number(b.dataset.step);
    b.classList.toggle('on', n === setupStep);
    b.classList.toggle('ok', n !== setupStep && okStep[n]);
  });
  document.querySelectorAll('#viewSetup .step').forEach((s) => (s.hidden = Number(s.dataset.step) !== setupStep));

  // 第 1 步：城市
  renderCities();

  // 第 2 步：去哪里
  renderSetupPlaces();
  if (setupStep === 2) renderPopular();

  // 第 3 步：住哪里
  if (setupStep === 3) {
    if (stayTarget > nights(t)) stayTarget = 1;
    renderStays();
    renderStaySuggest();
  }

  // 第 4 步：出发
  fillTripForm();

  // 底部按钮
  $('#setupPrev').hidden = setupStep === 1 && !setupEdit;
  $('#setupPrev').textContent = setupStep === 1 ? '取消' : '上一步';
  if (setupEdit) $('#setupNext').textContent = '完成，看路线';
  else if (setupStep === 3) $('#setupNext').textContent = hasAnyHotel(t) ? '下一步' : '还没订，先跳过';
  else if (setupStep === 4) $('#setupNext').textContent = '开始规划路线';
  else $('#setupNext').textContent = '下一步';
  document.querySelector('#viewSetup .vbody').scrollTop = 0;
  updatePickUI();
}

/* ---- 第 1 步：城市 ---- */

function renderCities() {
  const t = T();
  const d = t.dest;
  $('#destCard').innerHTML = d
    ? `<div class="dest-card"><div class="dc-ic">${ic('pin', 22)}</div><div class="dc-main"><div class="dc-name">${esc(d.name)}</div><div class="dc-sub">${esc(d.sub || '')}</div></div></div>`
    : '';
  $('#cityPresets').innerHTML = CITY_PRESETS.map(
    (c, i) => `<button type="button" data-city="${i}" class="${d && d.name === c.name ? 'on' : ''}"><span class="flag">${c.flag || '🌏'}</span><b>${esc(c.name)}</b><span>${esc(c.sub)}</span></button>`,
  ).join('');
}

function chooseDest(c) {
  const t = T();
  const changed = !t.dest || t.dest.name !== c.name;
  t.dest = { name: c.name, sub: c.sub, lat: c.lat, lon: c.lon, bbox: c.bbox };
  if (changed && !setupEdit && t.name.startsWith('行程 ')) t.name = `${c.name} ${fmtDate(Date.now())}`;
  // 同一个城市之前住过的地方，直接沿用（同一趟旅行通常住同一间）
  if (changed && !t.home) {
    const last = [...state.trips].filter((x) => x !== t && x.home && x.dest?.name === c.name).sort((a, b) => b.updated - a.updated)[0];
    if (last) {
      t.home = { ...last.home };
      t.settings = { ...last.settings };
    }
  }
  save();
  // 选了城市就先在背景找热门景点，到第 3 步时已经准备好
  loadPopular(t.dest);
  $('#cityResults').innerHTML = '';
  $('#cityInput').value = '';
  if (c.bigArea) toast('这个范围很大，热门景点只找中心附近；建议选城市', 3500);
  renderSetup();
  $('#daysGroup').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

$('#cityPresets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-city]');
  if (b) chooseDest(CITY_PRESETS[Number(b.dataset.city)]);
});

let cityResults = [];
$('#cityForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('#cityInput').value.trim();
  if (!q) return;
  $('#cityInput').blur();
  $('#cityResults').innerHTML = '<div class="smsg">搜索中…</div>';
  try {
    cityResults = await searchCities(q);
    $('#cityResults').innerHTML = cityResults.length
      ? cityResults
          .map((c, i) => `<div class="sitem"><div class="si-ic">🏙️</div>
            <div class="si-main"><div class="si-name">${esc(c.name)}</div><div class="si-addr">${esc(c.sub)}</div></div>
            <div class="si-act"><button type="button" class="primary" data-ci="${i}">选这个</button></div></div>`)
          .join('')
      : '<div class="smsg">找不到这个城市，试试英文名字</div>';
  } catch (err) {
    $('#cityResults').innerHTML = `<div class="smsg">搜索失败：${esc(err.message)}</div>`;
  }
});
$('#cityResults').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ci]');
  if (b) chooseDest(cityResults[Number(b.dataset.ci)]);
});

/* ---- 第 3 步：热门景点 ---- */

const popular = { key: null, items: null, error: null, loading: null };
let popularCat = '全部';

function loadPopular(dest) {
  if (!dest?.bbox) return null;
  const key = dest.bbox.join(',');
  if (popular.key === key && (popular.items || popular.loading)) return popular.loading;
  popular.key = key;
  popular.items = null;
  popular.error = null;
  popular.loading = fetchPopular(dest.bbox)
    .then((items) => {
      if (popular.key === key) popular.items = items;
    })
    .catch((e) => {
      console.warn(e);
      if (popular.key === key) popular.error = e.message || '载入失败';
    })
    .finally(() => {
      if (popular.key === key) popular.loading = null;
      if (currentView === 'setup' && setupStep === 2) renderPopular();
    });
  return popular.loading;
}

function renderPopular() {
  const t = T();
  const box = $('#popularList');
  $('#popularBox').hidden = !t.dest;
  if (!t.dest) return;
  $('#popularTitle').textContent = `${t.dest.name} 热门景点`;
  if (popular.key !== t.dest.bbox?.join(',')) loadPopular(t.dest);
  if (popular.loading && !popular.items) {
    $('#popularCats').innerHTML = '';
    box.innerHTML = '<div class="pop-loading">正在找热门景点和照片…（第一次大约 10 秒）</div>';
    return;
  }
  if (popular.error) {
    $('#popularCats').innerHTML = '';
    box.innerHTML = `<div class="pop-loading">热门景点暂时载入失败（${esc(popular.error)}）<br>可以直接在上面搜索 <button type="button" class="link" id="popRetry">再试一次</button></div>`;
    return;
  }
  const items = popular.items || [];
  const cats = ['全部', ...new Set(items.map((x) => categoryOf(x.type)))];
  if (!cats.includes(popularCat)) popularCat = '全部';
  $('#popularCats').innerHTML = cats
    .map((c) => `<button type="button" data-cat="${esc(c)}" class="${c === popularCat ? 'on' : ''}">${esc(c)}</button>`)
    .join('');
  const shown = items.filter((x) => popularCat === '全部' || categoryOf(x.type) === popularCat).slice(0, 40);
  const near = searchCenter();
  const label = t.home ? '离住的地方' : '离市中心';
  box.innerHTML = shown.length
    ? `<div class="pgrid">${shown.map((r, i) => popularCardHtml(r, i, placeAction(r), near, label)).join('')}</div>
       <p class="small muted">排名依据：维基百科有多少种语言介绍它（越多越有名）。照片来自维基共享资源。</p>`
    : '<div class="pop-loading">这个城市没有找到热门景点，请直接在上面搜索</div>';
  popular.shown = shown;
  hydrateRoad(box, shown, near, label);
}

function popularCardHtml(r, i, a, near, label) {
  return `<div class="pcard ${a.state === 'in' ? 'added' : a.state === 'sel' ? 'selected' : ''}">
    <div class="pc-img" data-prev="${i}" style="background-image:url('${esc(r.photo)}')">
      <span class="pc-type">${esc(typeZh(r.type))}</span>
      ${i < 3 ? `<span class="pc-rank">TOP ${i + 1}</span>` : ''}
    </div>
    <div class="pc-body" data-prev="${i}">
      <div class="pc-name">${esc(r.name)}</div>
      ${r.alt ? `<div class="pc-alt">${esc(r.alt)}</div>` : ''}
      ${near ? `<div class="pc-meta" data-rd="${i}">${esc(label)} …</div>` : ''}
      <button type="button" class="pc-info" data-prev="${i}">${ic('info', 14)} 介绍</button>
    </div>
    <button type="button" class="pc-add" data-pick="${i}" aria-label="${esc(a.label)}">${ic(a.state ? 'check' : 'plus', 18)}</button>
  </div>`;
}

$('#popularCats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  popularCat = b.dataset.cat;
  renderPopular();
});
$('#popularList').addEventListener('click', (e) => {
  if (e.target.id === 'popRetry') {
    popular.key = null;
    renderPopular();
    return;
  }
  const shown = popular.shown || [];
  const pick = e.target.closest('button[data-pick]');
  if (pick) {
    pickPlace(shown[Number(pick.dataset.pick)]);
    renderPopular();
    return;
  }
  const prev = e.target.closest('[data-prev]');
  if (prev) {
    openPreview(shown[Number(prev.dataset.prev)], placeAction, (r) => {
      pickPlace(r);
      renderPopular();
    }, searchCenter(), T().home ? '离住的地方' : '离市中心');
  }
});

function renderSetupPlaces() {
  const t = T();
  if (!t) return;
  const active = t.places.filter((p) => !p.done);
  $('#placeCount').textContent = active.length;
  $('#setupPlaces').innerHTML = active.length
    ? active
        .map((p, i) => {
          const h = placeHoursOn(p, new Date());
          const hours = h.known ? (h.windows.length ? `今天 ${h.windows.map(([o, c]) => `${minToHHMM(o)}–${minToHHMM(c)}`).join('，')}` : '今天休息') : '营业时间未知';
          return `<div class="pitem" data-id="${p.id}">
            <div class="si-thumb" data-prev="${i}">${kindIcon(p.kind)}</div>
            <div class="pi-main"><div class="pi-name">${esc(p.name)}</div><div class="pi-sub">${esc(hours)}</div></div>
            <div class="stepper"><button type="button" data-pact="minus">−</button><span>停留 ${p.stayMin} 分</span><button type="button" data-pact="plus">＋</button></div>
            <button type="button" class="pi-info" data-pact="info" title="介绍">${ic('info', 17)}</button>
            <button type="button" class="pi-del" data-pact="del" title="移除">✕</button>
          </div>`;
        })
        .join('')
    : '<div class="empty-box">还没有地点<br>从下面的热门景点挑，或在上面搜索，找到想去的地方就按「＋ 添加」</div>';
  hydrateThumbs($('#setupPlaces'), active);
  placeSearch.redraw();
}

$('#setupPlaces').addEventListener('click', (e) => {
  const t = T();
  const row = e.target.closest('.pitem');
  if (!row) return;
  const p = t.places.find((x) => x.id === row.dataset.id);
  if (!p) return;
  const b = e.target.closest('[data-pact]');
  if (!b) {
    if (e.target.closest('[data-prev]')) {
      openPreview(p, () => ({ label: '✓ 已在行程里', done: true }), () => {}, searchCenter(), T().home ? '离住的地方' : '离市中心');
    }
    return;
  }
  const act = b.dataset.pact;
  if (act === 'info') return openPreview(p, () => ({ label: '✓ 已在行程里', done: true }), () => {}, searchCenter(), T().home ? '离住的地方' : '离市中心');
  if (act === 'del') {
    t.places = t.places.filter((x) => x !== p);
    Object.values(t.manualOrders || {}).forEach((arr) => arr.includes(p.id) && arr.splice(arr.indexOf(p.id), 1));
  }
  if (act === 'plus') p.stayMin = Math.min(600, p.stayMin + 15);
  if (act === 'minus') p.stayMin = Math.max(0, p.stayMin - 15);
  save();
  staySugg = null;
  renderSetupPlaces();
  if (setupStep === 2) renderPopular();
});

/* ---- 第 4 步：出发设置 ---- */

function fillTripForm() {
  const t = T();
  const f = $('#tripForm');
  const s = t.settings;
  f.name.value = t.name;
  f.departMode.value = s.departMode;
  f.departAt.value = s.departAt;
  f.startFrom.value = t.home ? s.startFrom : 'gps';
  f.returnHome.checked = !!t.home && s.returnHome;
  f.querySelector('[name=startFrom][value=home]').disabled = !t.home;
  f.returnHome.disabled = !t.home;
  $('#homeLabel').textContent = t.home ? `（${t.home.name}）` : '（还没设置）';
  f.mode.value = s.mode;
  f.walkMaxM.value = s.walkMaxM;
  f.parkMin.value = s.parkMin;
  f.defaultStay.value = s.defaultStay;
  f.arrangePref.value = s.arrangePref || 'balanced';
  $('#prefGroup').hidden = (t.days || 1) <= 1;
  $('#startDate').value = t.startDate || todayStr();
  f.dayEnd.value = s.dayEnd || '21:00';
  updateDaysUI();
  updateModeHint();
}

// 几天的显示；多天时「现在出发」改成「每天几点出发」
function updateDaysUI() {
  const t = T();
  const n = t.days || 1;
  $('#daysVal').textContent = n;
  $('#dayEndWrap').hidden = n <= 1;
  $('#daysHint').textContent = n > 1
    ? `会自动把地点分到 ${n} 天：同一区的放同一天、避开休息日、每天时间尽量平均。之后也可以自己把地点固定在某一天。`
    : '只玩一天的话，所有地点排成一条路线。';
  $('#nowLabel').textContent = n > 1 ? '行程当天：现在出发' : '现在出发';
}
$('#startDate').addEventListener('change', () => {
  const t = T();
  if ($('#startDate').value) {
    t.startDate = $('#startDate').value;
    t.dayPlans = {};
    save();
  }
});
$('#daysGroup').addEventListener('click', (e) => {
  const b = e.target.closest('[data-days]');
  if (!b) return;
  const t = T();
  t.days = Math.min(14, Math.max(1, (t.days || 1) + Number(b.dataset.days)));
  staySugg = null;
  save();
  updateDaysUI();
});

function updateModeHint() {
  const f = $('#tripForm');
  $('#prefHint').textContent = f.arrangePref.value === 'shortest'
    ? '尽量少开车、少走路；有的天可能比较满，有的天比较轻松'
    : '每天玩的时间差不多；可能会多一点路程';
  const m = f.mode.value;
  $('#modeHint').textContent = {
    auto: '近的地方走路，远的地方开车',
    car: '每一段都开车',
    foot: '每一段都走路',
    transit: '近的地方走路，远的搭巴士、地铁、火车（班次来自免费的 Transitous 公共交通资料）',
  }[m];
  f.walkMaxM.closest('label').hidden = m !== 'auto' && m !== 'transit';
  f.parkMin.closest('label').hidden = m === 'foot' || m === 'transit';
}

function readTripForm() {
  const t = T();
  const f = $('#tripForm');
  t.name = f.name.value.trim() || t.name;
  t.settings = {
    ...t.settings,
    departMode: f.departMode.value || 'now',
    departAt: f.departAt.value || '09:00',
    startFrom: f.startFrom.value || 'gps',
    returnHome: f.returnHome.checked,
    mode: f.mode.value || 'auto',
    walkMaxM: Math.max(0, Number(f.walkMaxM.value) || 1000),
    parkMin: Math.max(0, Number(f.parkMin.value) || 0),
    defaultStay: Math.max(0, Number(f.defaultStay.value) || 60),
    arrangePref: f.arrangePref.value || 'balanced',
    dayEnd: f.dayEnd.value || '21:00',
  };
  save();
}
$('#tripForm').addEventListener('change', () => {
  readTripForm();
  updateModeHint();
});

/* ---- 步骤切换 ---- */

function canGo(n) {
  const t = T();
  if (setupEdit) return true;
  if (n >= 2 && !t.dest) return toast('先选要去的城市'), false;
  if (n >= 3 && !t.places.some((p) => !p.done)) return toast('先添加至少一个想去的地方'), false;
  return true;
}

$('#stepTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-step]');
  if (!b) return;
  const n = Number(b.dataset.step);
  if (!canGo(n)) return;
  if (setupStep === 4) readTripForm();
  setupStep = n;
  renderSetup();
});

$('#skipHome').addEventListener('click', () => {
  T().settings.startFrom = 'gps';
  T().settings.returnHome = false;
  save();
  setupStep = 4;
  renderSetup();
});

$('#setupPrev').addEventListener('click', () => {
  if (setupStep === 4) readTripForm();
  if (setupStep === 1) return setupDone(true);
  setupStep--;
  renderSetup();
});

$('#setupNext').addEventListener('click', () => {
  if (setupStep === 2 && picked.length) {
    return confirmPicked(() => $('#setupNext').click(), `你选了 ${picked.length} 个地点还没加入`);
  }
  if (setupStep === 4) readTripForm();
  if (setupEdit) return setupDone();
  if (setupStep === 4) return setupDone();
  if (!canGo(setupStep + 1)) return;
  if (setupStep === 3 && !hasAnyHotel(T())) {
    T().settings.startFrom = 'gps';
    T().settings.returnHome = false;
    save();
  }
  setupStep++;
  renderSetup();
});

$('#setupBack').addEventListener('click', () => {
  if (setupStep === 4) readTripForm();
  setupDone(true);
});

function setupDone(back = false) {
  const t = T();
  if (!t) return showView('trips');
  if (!t.places.length) {
    // 什么都没加：新行程就不留了
    if (!setupEdit && !back) return toast('先添加至少一个想去的地方');
    if (!setupEdit) state.trips = state.trips.filter((x) => x !== t);
    save();
    return showView('trips');
  }
  if (back && !setupEdit) {
    save();
    return showView('trips');
  }
  t.plan = null;
  // 天数变少了：超出的地点要重新分
  t.places.forEach((p) => {
    if (p.day > t.days) {
      p.day = null;
      p.dayLocked = false;
    }
  });
  save();
  showView('map');
  setTimeout(fitAll, 300);
  if (isMulti(t)) {
    t.curDay = 0;
    // 有还没分到哪天的地点、或是第一次，就自动分配
    const need = t.arrangeSig !== arrangeSig(t) || t.places.some((p) => !p.done && !(p.day >= 1 && p.day <= t.days));
    (need ? arrangeTrip(t) : Promise.resolve()).then(() => replan()).catch((e) => setStatus(`分配失败：${e.message}`, true));
  } else replan();
}

/* ================= 地图 ================= */

let map = null;
let mapReady = false;
let markers = [];
let meMarker = null;
let lastGps = null;

function ensureMap() {
  if (map) return;
  const t = T();
  const c = t?.home || t?.places[0];
  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: c ? [c.lon, c.lat] : state.mapView?.center || [139.767, 35.681],
    zoom: c ? 12 : state.mapView?.zoom ?? 11,
    attributionControl: { compact: true },
  });
  map.on('load', () => {
    mapReady = true;
    map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: 'route-casing', type: 'line', source: 'route',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 },
    });
    map.addLayer({
      id: 'route-car', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'car'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['coalesce', ['get', 'color'], '#2563eb'], 'line-width': 5 },
    });
    map.addLayer({
      id: 'route-foot', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'foot'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['coalesce', ['get', 'color'], '#16a34a'], 'line-width': 5, 'line-dasharray': [1, 1.6] },
    });
    map.addLayer({
      id: 'route-transit', type: 'line', source: 'route', filter: ['==', ['get', 'mode'], 'transit'],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['coalesce', ['get', 'color'], ['get', 'tcolor'], '#7c3aed'], 'line-width': 5 },
    });
    // 路线上的小图标：开车 🚗、走路 🚶
    drawRoute();
  });
  map.on('dragstart', () => {
    if (tour) stopTour();
    if (follow?.center) {
      follow.center = false;
      $('#btnLocate').classList.add('paused');
    }
  });
  map.on('moveend', () => {
    const c = map.getCenter();
    state.mapView = { center: [c.lng, c.lat], zoom: map.getZoom() };
  });
  setupLongPress();
}

// 画一个白底圆圈 + 彩色边框 + 图标，给地图用

function drawRoute() {
  if (!mapReady) return;
  const t = T();
  const feats = [];
  const used = new Set();
  const add = (l, color) => {
    const icon = l.icon || (l.mode === 'foot' ? 'foot' : l.mode === 'transit' ? 'bus' : 'car');
    used.add(icon);
    const props = { mode: l.mode, icon, tcolor: MODE_COLOR[icon] };
    if (color) props.color = color;
    feats.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: l.coords } });
  };
  if (isMulti(t) && !t.curDay) {
    // 总览：每一天一种颜色
    for (let d = 1; d <= t.days; d++) (t.dayPlans?.[d]?.lines || []).forEach((l) => add(l, dayColor(d)));
  } else (t?.plan?.lines || []).forEach((l) => add(l));
  map.getSource('route').setData({ type: 'FeatureCollection', features: feats });
  // 图例：只显示这条路线有用到的交通方式
  $('#mapLegend').innerHTML = ['car', 'foot', 'bus', 'train'].filter((k) => used.has(k))
    .map((k) => `<span class="lg-item" style="--lg:${MODE_COLOR[k]}">${modeIcon(k, 14)}<b>${MODE_NAME[k]}</b></span>`).join('');
  $('#mapLegend').hidden = used.size < 1;
}

function drawMarkers() {
  markers.forEach((m) => m.remove());
  markers = [];
  markerById = new Map();
  const t = T();
  if (!t || !map) return;
  const add = (lon, lat, cls, text, onClick, how = null) => {
    const el = document.createElement('div');
    el.className = `marker ${cls}`;
    el.textContent = text;
    // 小图标：怎么到这里（开车 / 走路 / 巴士 / 地铁火车）
    if (how) el.insertAdjacentHTML('beforeend', `<span class="mk-how" style="background:${MODE_COLOR[how]}">${modeIcon(how, 11)}</span>`);
    if (onClick) el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    markers.push(new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map));
  };
  const day = isMulti(t) && t.curDay ? t.curDay : null;
  const hs = day ? [startHotel(t, day), endHotel(t, day)].filter((h, i, a) => h && a.findIndex((x) => sameHotel(x, h)) === i) : allHotels(t);
  hs.forEach((h) => {
    add(h.lon, h.lat, 'home', '', () => toast(`住宿：${h.name}`));
    markers[markers.length - 1].getElement().innerHTML = ic('bed', 16);
  });
  if (isMulti(t) && !t.curDay) {
    // 总览：号码是那天的第几站，颜色是哪一天
    for (const p of t.places) {
      const plan = t.dayPlans?.[p.day];
      const num = plan ? plan.order.filter((id) => !t.places.find((x) => x.id === id)?.done).indexOf(p.id) + 1 : 0;
      const el = (cls, text) => {
        add(p.lon, p.lat, cls, text, () => focusPlace(p.id));
        markerById.set(p.id, markers[markers.length - 1]);
      };
      if (p.done) el('done', '✓');
      else if (num > 0) {
        el('day', String(num));
        markers[markers.length - 1].getElement().style.background = dayColor(p.day);
      } else el('pending', p.day ? '✕' : '?');
    }
    return;
  }
  const info = stopInfoMap();
  for (const p of t.places) {
    if (isMulti(t) && p.day !== t.curDay) continue;
    const i = info.get(p.id);
    if (p.done) add(p.lon, p.lat, 'done', '✓', () => focusPlace(p.id));
    else if (i) add(p.lon, p.lat, i.cls, String(i.num), () => focusPlace(p.id), legKind(i.legIn));
    else if (t.plan?.closedIds?.includes(p.id)) add(p.lon, p.lat, 'bad', '✕', () => focusPlace(p.id));
    else add(p.lon, p.lat, 'pending', '?', () => focusPlace(p.id));
    markerById.set(p.id, markers[markers.length - 1]);
  }
}

function showMe(pos) {
  if (!map) return;
  if (!meMarker) {
    const el = document.createElement('div');
    el.className = 'me-dot';
    meMarker = new maplibregl.Marker({ element: el });
  }
  meMarker.setLngLat([pos.lon, pos.lat]).addTo(map);
  const el = meMarker.getElement();
  const hasDir = pos.heading != null && !Number.isNaN(pos.heading);
  el.classList.toggle('dir', hasDir);
  if (hasDir) el.style.setProperty('--hd', `${pos.heading}deg`);
}

function fitAll() {
  const t = T();
  if (!t || !map) return;
  const pts = t.places.filter((p) => !p.done && (!isMulti(t) || !t.curDay || p.day === t.curDay)).map((p) => [p.lon, p.lat]);
  if (t.plan?.origin) pts.push([t.plan.origin.lon, t.plan.origin.lat]);
  (isMulti(t) && t.curDay ? [startHotel(t, t.curDay), endHotel(t, t.curDay)] : allHotels(t)).forEach((h) => h && pts.push([h.lon, h.lat]));
  if (!pts.length) return;
  if (pts.length === 1) return map.flyTo({ center: pts[0], zoom: 14 });
  const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
  pts.forEach((p) => b.extend(p));
  // 大屏幕：列表在左边；手机：列表在下面
  const wide = innerWidth >= 900;
  const sheetH = $('#sheet').getBoundingClientRect().height;
  const padding = wide ? { top: 60, left: 400 + 50, right: 90, bottom: 50 } : { top: 90, left: 40, right: 70, bottom: sheetH + 30 };
  map.fitBounds(b, { padding, maxZoom: 15, duration: 600 });
}

/* 地图上长按加地点 */
function setupLongPress() {
  let pressTimer = null;
  let popup = null;
  function at(lngLat) {
    const { lng, lat } = lngLat;
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ closeOnClick: true, maxWidth: '260px' })
      .setLngLat([lng, lat])
      .setHTML('<div class="popup-name">查询中…</div>')
      .addTo(map);
    const pp = popup;
    reverseGeocode(lat, lng)
      .then((r) => {
        if (pp !== popup) return;
        const el = document.createElement('div');
        el.innerHTML = `<div class="popup-name">${esc(r.name)}</div>
          <div class="popup-btns"><button class="primary" data-a="add">＋ 添加</button><button data-a="home">设为住的地方</button></div>`;
        el.addEventListener('click', (ev) => {
          const a = ev.target.closest('[data-a]')?.dataset.a;
          if (!a) return;
          if (a === 'add') {
            addPlaceToTrip(r);
            toast(`已添加：${r.name}`);
          } else {
            setHome(r);
            toast(`住的地方：${r.name}`);
          }
          pp.remove();
          renderMap();
          scheduleReplan();
        });
        pp.setDOMContent(el);
      })
      .catch(() => pp.setHTML('<div class="popup-name">查询失败，请再试一次</div>'));
  }
  map.on('contextmenu', (e) => at(e.lngLat));
  map.on('touchstart', (e) => {
    clearTimeout(pressTimer);
    if (e.originalEvent.touches.length !== 1) return;
    const ll = e.lngLat;
    pressTimer = setTimeout(() => at(ll), 600);
  });
  ['touchend', 'touchcancel', 'movestart', 'zoomstart'].forEach((ev) => map.on(ev, () => clearTimeout(pressTimer)));
  map.on('touchmove', (e) => {
    if (e.originalEvent.touches.length !== 1) clearTimeout(pressTimer);
  });
}

/* ================= 定位 ================= */

function getGps(timeout = 10000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('这个浏览器不支持定位'));
    navigator.geolocation.getCurrentPosition(
      (p) => {
        lastGps = { lat: p.coords.latitude, lon: p.coords.longitude, at: Date.now() };
        showMe(lastGps);
        resolve(lastGps);
      },
      (e) => reject(new Error(e.code === 1 ? '没有定位权限' : '拿不到位置')),
      { enableHighAccuracy: true, timeout, maximumAge: 60e3 },
    );
  });
}

/* ================= 规划路线 ================= */

let planning = false;
let replanQueued = false;
let replanTimer = null;

function setStatus(msg, isErr = false) {
  const el = $('#status');
  el.textContent = msg || '';
  el.classList.toggle('err', isErr);
}

function scheduleReplan(delay = 600) {
  clearTimeout(replanTimer);
  replanTimer = setTimeout(replan, delay);
}

function replanIfStale(force = false) {
  const t = T();
  if (!t || !t.places.some((p) => !p.done)) return;
  if (isMulti(t) && !t.curDay) {
    if (force || Object.keys(t.dayPlans || {}).length < t.days) replan();
    return;
  }
  if (force || !t.plan || Date.now() - t.plan.computedAt > REPLAN_AFTER_MS) replan();
}

/* ---- 多天：日期与小工具 ---- */

const DAY_COLORS = ['#2563eb', '#f97316', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#4f46e5'];
const dayColor = (d) => DAY_COLORS[(d - 1) % DAY_COLORS.length];
const isMulti = (t) => (t?.days || 1) > 1;
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayDate(t, d) {
  const [y, m, dd] = (t.startDate || todayStr()).split('-').map(Number);
  return new Date(y, m - 1, dd + d - 1);
}
function fmtDay(t, d) {
  const x = dayDate(t, d);
  return `${x.getMonth() + 1}月${x.getDate()}日 ${WEEK[x.getDay()]}`;
}
// 哪一天是今天（行程进行中），不是就返回 null
function todayDay(t) {
  if (!isMulti(t)) return null;
  const today = startOfDay(Date.now());
  for (let d = 1; d <= t.days; d++) if (dayDate(t, d).getTime() === today) return d;
  return null;
}
// 某一天在几点出发（按设置的出发时间）
function dayClock(t, d, hhmm) {
  const [h, m] = (hhmm || '09:00').split(':').map(Number);
  const x = dayDate(t, d);
  x.setHours(h, m, 0, 0);
  return x.getTime();
}
const manualKey = (day) => String(day || 1);
const getManual = (t, day) => t.manualOrders?.[manualKey(day)] || null;
function setManual(t, day, order) {
  t.manualOrders ||= {};
  if (order) t.manualOrders[manualKey(day)] = order;
  else delete t.manualOrders[manualKey(day)];
}

// 行程进行中：最后一个打勾的地方（18 小时内；多天行程只看那一天的）
function lastDonePlace(t, day = null) {
  return t.places
    .filter((p) => p.done && p.doneAt && Date.now() - p.doneAt < 18 * 3600e3 && (day == null || p.day === day))
    .sort((a, b) => b.doneAt - a.doneAt)[0] || null;
}

// 这一天（或单日行程）几点开始算
function departTime(t, day = null) {
  const s = t.settings;
  const now = Date.now();
  const live = day == null || day === todayDay(t);
  // 已经去过地方：接着那个地方的离开时间（提前规划时）或现在（真的在路上时）
  const last = live ? lastDonePlace(t, day) : null;
  if (last) return Math.max(now, last.doneDepart || 0);
  // 这天自己改过出发时间（地图页按出发时间改的）
  const over = t.dayDepart?.[manualKey(day)];
  if (day != null) {
    const base = dayClock(t, day, over || s.departAt);
    return live && s.departMode === 'now' && !over ? Math.max(now, base) : live ? Math.max(base, Math.min(now, base + 12 * 3600e3)) : base;
  }
  if (!over && (s.departMode !== 'at' || !s.departAt)) return now;
  const [h, m] = (over || s.departAt).split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() < now - 5 * 60e3) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// 从哪里出发：今天（行程进行中）用 GPS / 刚去过的地方；其他日子从住的地方
async function getOrigin(t, day = null) {
  const s = t.settings;
  const sh = startHotel(t, day);
  const home = sh ? { ...sh, kind: 'home' } : null;
  if (day != null && day !== todayDay(t)) return home;
  const last = lastDonePlace(t, day);
  const fromLast = last ? { name: `刚去过：${last.name}`, lat: last.lat, lon: last.lon, kind: 'done' } : null;
  if (s.startFrom === 'gps' || !home) {
    try {
      const p = await getGps();
      return { name: '我的位置', lat: p.lat, lon: p.lon, kind: 'gps' };
    } catch (e) {
      if (fromLast) return fromLast;
      if (home) {
        toast(`${e.message}，改从住的地方出发`);
        return home;
      }
      toast(`${e.message}，会自动选择最好的第一站`);
      return null;
    }
  }
  return fromLast || home;
}

// 查交通时间表，返回 leg(i, j) = { mode, dur(毫秒), dist(米) }
async function buildTravel(t, pts, firstIsLive) {
  const s = t.settings;
  const profiles = s.mode === 'auto' || s.mode === 'transit' ? ['car', 'foot'] : [s.mode];
  let estimated = false;
  const tables = {};
  await Promise.all(
    profiles.map(async (pr) => {
      if (pts.length < 2) return (tables[pr] = estimateTable(pr, pts));
      try {
        tables[pr] = await travelTable(pr, pts, firstIsLive);
      } catch (e) {
        console.warn(e);
        estimated = true;
        tables[pr] = estimateTable(pr, pts);
      }
    }),
  );
  const parkMs = (Number(s.parkMin) || 0) * 60e3;
  const cache = new Map();
  function leg(i, j) {
    const key = i * 10000 + j;
    if (cache.has(key)) return cache.get(key);
    let r;
    const get = (pr) => {
      const d = tables[pr].durations[i]?.[j];
      const dist = tables[pr].distances[i]?.[j];
      if (d == null || dist == null) {
        // 路线服务算不出这一段（例如找不到走路的路）：用直线距离估计，不要当成 0 米
        const m = haversine(pts[i], pts[j]) * 1.3;
        return { mode: pr, dur: (m / (pr === 'car' ? 30 / 3.6 : 4.5 / 3.6)) * 1000, dist: m, guessed: true };
      }
      return { mode: pr, dur: d * 1000, dist };
    };
    if (i === j) r = { mode: 'foot', dur: 0, dist: 0 };
    else if (s.mode === 'auto' || s.mode === 'transit') {
      const f = get('foot');
      // 只有真的算得出走路路线、而且够近，才走路
      if (!f.guessed && f.dist <= (Number(s.walkMaxM) || 0)) r = f;
      else if (s.mode === 'transit') {
        // 公交先用估计（开车时间 × 1.6 + 等车走路 12 分钟），排好顺序后再查真实班次
        const c = get('car');
        r = { mode: 'transit', dur: c.dur * 1.6 + 12 * 60e3, dist: c.dist, est: true };
      } else r = get('car');
    } else r = get(s.mode);
    if (r.mode === 'car' && i !== j) r = { ...r, dur: r.dur + parkMs };
    cache.set(key, r);
    return r;
  }
  // 走路要多久（公交模式用来比较：公交没比走路快多少，就走路）
  const walk = (i, j) => {
    const d = tables.foot?.durations[i]?.[j];
    const dist = tables.foot?.distances[i]?.[j];
    return d == null || dist == null ? null : { mode: 'foot', dur: d * 1000, dist };
  };
  // 开车要多久（含停车时间），停车 + 步行圈用
  const drive = (i, j) => {
    if (i === j) return { mode: 'car', dur: 0, dist: 0 };
    const d = tables.car?.durations[i]?.[j];
    const dist = tables.car?.distances[i]?.[j];
    if (d == null || dist == null) {
      const m = haversine(pts[i], pts[j]) * 1.3;
      return { mode: 'car', dur: (m / (30 / 3.6)) * 1000 + parkMs, dist: m, guessed: true };
    }
    return { mode: 'car', dur: d * 1000 + parkMs, dist };
  };
  return { leg, walk, drive, estimated };
}

/* ---- 停车 + 步行圈（「自动」模式）：记住车停在哪里 ---- */
//
// 走路到得了的地方分成一组，每组有一个停车点：
//   开车到停车点 → 停车 → 走路逛完这组 → 走回停车点取车 → 开去下一组
// 起点（酒店 / 现在的位置）也是一个停车点：酒店附近走路就到的地方，车根本不用开。
// 这样「走回车子」的时间会算进路线，算法会自动把同一组排在一起。
//
// 返回 legAt(i, j)：pts 下标 i → j 的一段，可能由「走回停车处 + 开车 + 走过去」组成
function parkWalkLegs({ pts, placeIdx, originIdx, endIdx, walk, drive, walkMax }) {
  const near = (i, j) => {
    const w = walk(i, j);
    return w && w.dist <= walkMax ? w : null;
  };
  const entry = new Map(); // pts 下标 → 停车点下标
  const left = new Set(placeIdx);
  // 起点附近的地方：车停在起点
  if (originIdx >= 0) {
    entry.set(originIdx, originIdx);
    for (const p of [...left]) {
      if (near(originIdx, p) && near(p, originIdx)) {
        entry.set(p, originIdx);
        left.delete(p);
      }
    }
  }
  // 其他地方：挑「走路范围内邻居最多」的当停车点，邻居跟它一组
  while (left.size) {
    let best = null;
    let bestN = -1;
    for (const c of left) {
      const nb = [...left].filter((p) => p !== c && near(c, p) && near(p, c)).length;
      if (nb > bestN) {
        bestN = nb;
        best = c;
      }
    }
    entry.set(best, best);
    left.delete(best);
    for (const p of [...left]) {
      if (near(best, p) && near(p, best)) {
        entry.set(p, best);
        left.delete(p);
      }
    }
  }
  // 终点：跟起点是同一个地方（回酒店）就算同一个停车点；不然车要开到终点
  if (endIdx >= 0) {
    const same = originIdx >= 0 && haversine(pts[originIdx], pts[endIdx]) < 40;
    entry.set(endIdx, same ? originIdx : endIdx);
  }

  const cache = new Map();
  const walkLeg = (i, j) => walk(i, j) || { ...drive(i, j), mode: 'foot', guessed: true };
  return function legAt(i, j) {
    const key = i * 10000 + j;
    if (cache.has(key)) return cache.get(key);
    let r;
    const ei = entry.get(i) ?? i;
    const ej = entry.get(j) ?? j;
    if (i === j) r = { mode: 'foot', dur: 0, dist: 0 };
    else if (ei === ej) {
      // 同一组：走路
      r = walkLeg(i, j);
    } else {
      // 不同组：走回停车处 → 开车 → 从停车处走过去
      // 同一个位置（例如停车点就是终点的酒店）不用走
      const same = (a, b) => a === b || haversine(pts[a], pts[b]) < 40;
      const parts = [];
      if (!same(i, ei)) parts.push({ mode: 'foot', from: i, to: ei, ...walkLeg(i, ei) });
      parts.push({ mode: 'car', from: ei, to: ej, ...drive(ei, ej) });
      if (!same(ej, j)) parts.push({ mode: 'foot', from: ej, to: j, ...walkLeg(ej, j) });
      r = {
        mode: 'car',
        dur: parts.reduce((a, x) => a + x.dur, 0),
        dist: parts.reduce((a, x) => a + x.dist, 0),
        parts: parts.length > 1 ? parts.map((x) => ({ mode: x.mode, from: x.from, to: x.to, dur: x.dur, dist: x.dist })) : null,
      };
    }
    cache.set(key, r);
    return r;
  };
}


// 某天的营业时间窗口（绝对时间）
// 自己定的时间（例如「11:00 去」）→ 那一天几点的时间戳
function fixedAt(p, startTime) {
  if (!p.fixedTime || p.checkin) return null;
  const [h, m] = p.fixedTime.split(':').map(Number);
  const d = new Date(startTime);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

function windowsFor(p, startTime) {
  // Check-in：几点起才能入住（早到要等，晚到没关系）
  if (p.checkin && p.fixedTime) {
    const [h, m] = p.fixedTime.split(':').map(Number);
    const day0 = startOfDay(startTime);
    return [[day0 + (h * 60 + m) * 60e3, day0 + 24 * 3600e3]];
  }
  if (p.fixedTime) return null; // 自己定了时间：不管营业时间
  const day0 = startOfDay(startTime);
  const h = placeHoursOn(p, new Date(startTime));
  return h.known ? h.windows.map(([o, c]) => [day0 + o * 60e3, day0 + c * 60e3]) : null;
}

/* ---- 计算一天（或单日行程）的路线 ---- */

async function replan() {
  if (!T()) return;
  if (planning) {
    replanQueued = true;
    return;
  }
  planning = true;
  $('#btnReplan').disabled = true;
  try {
    const t = T();
    if (isMulti(t) && !t.curDay) await replanAllDays(t);
    else await doReplan(t, isMulti(t) ? t.curDay : null);
  } catch (e) {
    console.error(e);
    setStatus(`计算失败：${e.message}`, true);
  } finally {
    planning = false;
    $('#btnReplan').disabled = false;
    if (replanQueued) {
      replanQueued = false;
      replan();
    }
  }
}

// 准备计算资料；返回 null 表示这天没有要去的地方
async function buildDayBundle(trip, day, { quiet = false } = {}) {
  const s = trip.settings;
  const startTime = departTime(trip, day);
  const planDate = new Date(startTime);
  const active = trip.places.filter((p) => !p.done && (day == null || p.day === day));
  // 整天休息的地方不排进路线，另外列出来
  const closedIds = active
    .filter((p) => {
      const h = placeHoursOn(p, planDate);
      return !p.fixedTime && h.known && !h.windows.length;
    })
    .map((p) => p.id);
  const remaining = active.filter((p) => !closedIds.includes(p.id));
  if (!remaining.length) return { empty: true, trip, day, startTime, closedIds, active };

  if (!quiet) setStatus('正在定位和计算路线…');
  const origin = await getOrigin(trip, day);
  const eh = endHotel(trip, day);
  const end = s.returnHome && eh ? { ...eh } : null;
  const pts = [];
  if (origin) pts.push(origin);
  const placeBase = pts.length;
  remaining.forEach((p) => pts.push(p));
  if (end) pts.push(end);
  const endIdx = end ? pts.length - 1 : -1;
  const { leg: rawLeg, walk, drive, estimated } = await buildTravel(trip, pts, origin?.kind === 'gps');
  // 自动模式：记住车停在哪里（走路逛完一组要走回车子）
  const leg = s.mode === 'auto'
    ? parkWalkLegs({
      pts,
      placeIdx: remaining.map((_, k) => placeBase + k),
      originIdx: origin ? 0 : -1,
      endIdx,
      walk,
      drive,
      walkMax: Number(s.walkMaxM) || 0,
    })
    : rawLeg;

  // 节点编号 → pts 下标（没有起点时，0 号是虚拟起点）
  const n = remaining.length;
  const idx = (node) => (node === 0 ? (origin ? 0 : -1) : node === n + 1 ? endIdx : placeBase + node - 1);
  const ov = new Map(); // 查到的公交真实时间 { "i,j": leg }
  const legOf = (a, b) => {
    const i = idx(a);
    const j = idx(b);
    if (i < 0 || j < 0) return null;
    return ov.get(`${i},${j}`) || leg(i, j);
  };
  const stay = [0, ...remaining.map((p) => (Number(p.stayMin) || 0) * 60e3)];
  const windows = [null, ...remaining.map((p) => windowsFor(p, startTime))];
  const fixed = [null, ...remaining.map((p) => fixedAt(p, startTime))];
  const ctx = { n, travel: (a, b) => legOf(a, b)?.dur ?? 0, startTime, stay, windows, fixed, hasEnd: !!end };
  const best = optimize(ctx);
  const baseline = evaluate(ctx, remaining.map((_, i) => i + 1));
  return { trip, day, ctx, legOf, leg, walk, ov, idx, pts, remaining, end, n, origin, startTime, estimated, closedIds, best, baseline };
}

// 公交：按排好的顺序，一段一段查真实班次（每段一次请求），查到就盖掉估计
async function refineTransit(b, order) {
  const res = evaluate(b.ctx, order);
  const seq = [0, ...order, ...(b.end ? [b.n + 1] : [])];
  let changed = false;
  for (let i = 1; i < seq.length; i++) {
    const a = b.idx(seq[i - 1]);
    const c = b.idx(seq[i]);
    if (a < 0 || c < 0) continue;
    const base = b.leg(a, c);
    if (base.mode !== 'transit' || b.ov.has(`${a},${c}`)) continue;
    const depart = i === 1 ? b.startTime : res.stops[i - 2].depart;
    let plan = null;
    try {
      plan = await transitPlan(b.pts[a], b.pts[c], depart);
    } catch (e) {
      console.warn(e);
    }
    const w = b.walk(a, c);
    // 公交没比走路快 5 分钟以上（例如要先走很远去车站），就直接走路
    if (w && w.dur <= (plan ? plan.dur : base.dur) + 5 * 60e3 && w.dist <= 2500) b.ov.set(`${a},${c}`, w);
    else b.ov.set(`${a},${c}`, plan ? { mode: 'transit', dur: plan.dur, dist: base.dist, transit: plan } : { mode: 'transit', dur: base.dur, dist: base.dist, noTransit: true });
    changed = true;
  }
  return changed;
}

function emptyPlan(b) {
  return { computedAt: Date.now(), day: b.day, startTime: b.startTime, origin: null, end: null, order: [], stops: [], legs: [], finish: b.startTime, endArrive: null, saved: 0, estimated: false, lines: [], closedIds: b.closedIds };
}

// 手动顺序 or 最优顺序
function chosenOrder(b) {
  const manual = getManual(b.trip, b.day);
  if (!manual) return { order: b.best.order, manual: false };
  const idToK = new Map(b.remaining.map((p, i) => [p.id, i + 1]));
  const order = manual.filter((id) => idToK.has(id)).map((id) => idToK.get(id));
  // 不在手动顺序里的（新加的）放最后
  b.remaining.forEach((_, i) => !order.includes(i + 1) && order.push(i + 1));
  return { order, manual: true };
}

async function doReplan(trip, day) {
  const b = await buildDayBundle(trip, day);
  if (b.empty) {
    trip.plan = b.active.length ? emptyPlan(b) : null;
    if (day != null) trip.dayPlans[day] = trip.plan;
    save();
    renderMap();
    setStatus('');
    return;
  }
  // 记下这次的计算资料：手动调顺序时可以马上重算时间，不用再上网
  lastBundle = b;
  const { order, manual } = chosenOrder(b);
  applyOrder(b, order, manual);
  // 公交：先显示估计，再查真实班次后更新
  if (trip.settings.mode === 'transit') {
    setStatus('正在查公交班次…');
    if (await refineTransit(b, order)) {
      if (lastBundle === b) applyOrder(b, chosenOrder(b).order, manual);
    } else setStatus(`更新于 ${fmtClock(Date.now())}`);
  }
}

// 用指定顺序算出时间表
function planFromOrder(b, order, manual) {
  const { ctx, legOf, remaining, end, n, origin, startTime, estimated, closedIds, best, baseline, day } = b;
  const res = evaluate(ctx, order);
  const seq = [0, ...order, ...(end ? [n + 1] : [])];
  const legs = [];
  for (let i = 1; i < seq.length; i++) {
    const l = legOf(seq[i - 1], seq[i]);
    const pt = (k) => ({ name: b.pts[k].name || '', lat: b.pts[k].lat, lon: b.pts[k].lon });
    const parts = l?.parts ? l.parts.map((x) => ({ mode: x.mode, dur: x.dur, dist: x.dist, from: pt(x.from), to: pt(x.to) })) : null;
    legs.push(l ? { mode: l.mode, dur: l.dur, dist: l.dist, parts, transit: l.transit || null, noTransit: !!l.noTransit, est: !!l.est } : null);
  }
  const stops = res.stops.map((st) => ({
    id: remaining[st.k - 1].id,
    arrive: st.arrive,
    start: st.start,
    depart: st.depart,
    wait: st.wait,
    flag: st.flag,
    closeAt: st.win ? st.win[1] : null,
    fixed: st.fixed ?? null,
  }));
  const finish = res.endArrive ?? res.finish;
  const bestFinish = best.endArrive ?? best.finish;
  const plan = {
    computedAt: Date.now(),
    day,
    startTime,
    origin,
    end,
    order: stops.map((x) => x.id),
    stops,
    legs,
    finish: res.finish,
    endArrive: res.endArrive,
    saved: Math.max(0, baseline.finish - best.finish),
    manual,
    // 手动顺序比最优顺序多花的时间
    extra: manual ? Math.max(0, finish - bestFinish) : 0,
    estimated,
    lines: [],
    closedIds,
  };
  const ptsOrder = seq.map(b.idx).filter((i) => i >= 0).map((i) => b.pts[i]);
  return { plan, ptsOrder, legs };
}

// 用指定顺序算出时间表，存成行程的计划
function applyOrder(b, order, manual) {
  const { trip, day, estimated } = b;
  const { plan, ptsOrder, legs } = planFromOrder(b, order, manual);
  trip.plan = plan;
  if (day != null) trip.dayPlans[day] = plan;
  save();
  if (T() === trip) {
    renderMap();
    setStatus(`更新于 ${fmtClock(Date.now())}${estimated ? ' · 网络不好，时间是粗略估计' : ''}`, estimated);
    setTimeout(mealCheck, 1500);
  }
  fetchLines(trip, plan, ptsOrder, legs, estimated);
}

// 总览：每一天都算一次
async function replanAllDays(trip) {
  setStatus('正在计算每一天的路线…');
  trip.dayPlans ||= {};
  let estimated = false;
  for (let d = 1; d <= trip.days; d++) {
    const b = await buildDayBundle(trip, d, { quiet: true });
    if (b.empty) {
      trip.dayPlans[d] = b.active.length ? emptyPlan(b) : null;
      continue;
    }
    const { order, manual } = chosenOrder(b);
    const { plan, ptsOrder, legs } = planFromOrder(b, order, manual);
    trip.dayPlans[d] = plan;
    estimated ||= b.estimated;
    fetchLines(trip, plan, ptsOrder, legs, b.estimated);
  }
  trip.plan = null;
  save();
  if (T() === trip) {
    renderMap();
    setStatus(`更新于 ${fmtClock(Date.now())}${estimated ? ' · 网络不好，时间是粗略估计' : ''}`, estimated);
  }
}

/* ---- 多天：把地点分到每一天 ---- */

async function arrangeTrip(trip) {
  const places = trip.places.filter((p) => !p.done);
  if (!places.length) return;
  setStatus(`正在把 ${places.length} 个地点分到 ${trip.days} 天…`);
  const s = trip.settings;
  const N = trip.days;
  // 每天的起点 / 终点酒店（可能每晚不一样）
  const hotels = allHotels(trip);
  const pts = [...hotels, ...places];
  const base = hotels.length;
  const { leg } = await buildTravel(trip, pts, false);
  await Promise.race([loadWeather(trip), new Promise((r) => setTimeout(r, 4000))]);
  const hotelIdx = (h) => (h ? hotels.findIndex((x) => sameHotel(x, h)) : -1);
  const dayHubs = Array.from({ length: N }, (_, i) => ({
    start: hotelIdx(startHotel(trip, i + 1)),
    end: s.returnHome ? hotelIdx(endHotel(trip, i + 1)) : -1,
  }));
  const totalStay = places.reduce((a, p) => a + (Number(p.stayMin) || 0) * 60e3, 0);
  const avgDay = totalStay / N + 3600e3;
  // 「每天平均」时，跟平均时长差很多会加罚分；「总路程最少」时几乎不管
  const balanceW = s.arrangePref === 'shortest' ? 0.03 : 0.3;

  const dayCost = (d, ks) => {
    if (!ks.length) return places.length >= N ? 5 * 3600e3 : 0;
    const day = d + 1;
    const { start, end } = dayHubs[d];
    const startTime = dayClock(trip, day, trip.dayDepart?.[manualKey(day)] || s.departAt);
    // 节点：0 = 起点酒店，1..n = 地点，n+1 = 终点酒店
    const at = (node) => (node === 0 ? start : node === ks.length + 1 ? end : base + ks[node - 1]);
    const ctx = {
      n: ks.length,
      travel: (a, b) => {
        const i = at(a);
        const j = at(b);
        return i < 0 || j < 0 ? 0 : leg(i, j).dur;
      },
      startTime,
      stay: [0, ...ks.map((k) => (Number(places[k].stayMin) || 0) * 60e3)],
      windows: [null, ...ks.map((k) => windowsFor(places[k], startTime))],
      fixed: [null, ...ks.map((k) => fixedAt(places[k], startTime))],
      hasEnd: end >= 0,
    };
    const res = optimize(ctx);
    const finish = res.endArrive ?? res.finish;
    const over = Math.max(0, finish - dayClock(trip, day, s.dayEnd || '21:00'));
    // 雨大的日子：每个户外景点按雨量加罚分（最多 1 小时）
    const w = weatherOn(trip, day);
    const wet = rainy(w) ? ks.filter((k) => isOutdoor(places[k])).length * Math.min(60, w.mm * 2) * 60e3 : 0;
    return res.cost + over * 3 + Math.abs(finish - startTime - avgDay) * balanceW + wet;
  };

  // 起始分法（用真实路程）：
  //   每天住不同酒店 → 每个地点先放到「从那天的酒店来回最快」的那天
  //   每天同一间（或没有酒店）→ 挑 N 个「互相开车最远」的地点当各天中心，其他地点放到来回最快的中心
  // 之后 arrangeDays 还会跟「按方向切段」的分法比较，全部用真实时间算成本，挑最好的
  const center = hotels[0] || medianPoint(places);
  const sameAll = new Set(dayHubs.map((h) => `${h.start}|${h.end}`)).size === 1;
  const real = (a, b) => (a === b ? 0 : leg(a, b).dur); // pts 下标之间的真实时间
  const round = (k, j) => real(base + k, base + j) + real(base + j, base + k); // 两个地点来回
  let affinity; // affinity(k, d) = 地点 k 放第 d 天的「来回时间」
  if (!sameAll) {
    affinity = (k, d) => {
      const { start, end } = dayHubs[d];
      return (start >= 0 ? real(start, base + k) : 0) + (end >= 0 ? real(base + k, end) : start >= 0 ? real(base + k, start) : 0);
    };
  } else {
    const seeds = [];
    // 第一个中心：离其他地点来回总时间最长的（最偏远的）
    seeds.push(places.map((_, k) => k).sort((a, b) => places.reduce((s, _, j) => s + round(b, j), 0) - places.reduce((s, _, j) => s + round(a, j), 0))[0]);
    while (seeds.length < Math.min(N, places.length)) {
      // 下一个中心：离已选中心最远的地点
      const next = places.map((_, k) => k).filter((k) => !seeds.includes(k))
        .sort((a, b) => Math.min(...seeds.map((s) => round(b, s))) - Math.min(...seeds.map((s) => round(a, s))))[0];
      seeds.push(next);
    }
    affinity = (k, d) => (seeds[d] == null ? Infinity : round(k, seeds[d]));
  }
  const target = places.length / N;
  const count = new Array(N).fill(0);
  const init = new Array(places.length).fill(0);
  places
    .map((_, k) => ({ k, order: [...Array(N).keys()].sort((x, y) => affinity(k, x) - affinity(k, y)) }))
    .sort((a, b) => affinity(a.k, a.order[0]) - affinity(b.k, b.order[0]))
    .forEach(({ k, order }) => {
      const d = order.find((x) => count[x] < target * 1.4) ?? order[0];
      init[k] = d;
      count[d]++;
    });

  const assign = arrangeDays({
    n: places.length,
    days: N,
    angle: places.map((p) => Math.atan2(p.lat - center.lat, p.lon - center.lon)),
    load: places.map((p) => (Number(p.stayMin) || 0) * 60e3 + 15 * 60e3),
    locked: places.map((p) => (p.dayLocked && p.day >= 1 && p.day <= N ? p.day - 1 : -1)),
    dayCost,
    init,
  });
  places.forEach((p, k) => (p.day = assign[k] + 1));
  trip.manualOrders = {};
  trip.dayPlans = {};
  trip.arrangeSig = arrangeSig(trip);
  save();
}

// 分配时用到的条件（天数、日期、每晚的酒店）有没有变
function arrangeSig(t) {
  return JSON.stringify([t.days, t.startDate, t.settings.arrangePref, Array.from({ length: nights(t) }, (_, i) => {
    const h = hotelForNight(t, i + 1);
    return h ? `${h.lat.toFixed(4)},${h.lon.toFixed(4)}` : '';
  })]);
}

// 总览时加的地点：等真实路程算好，改放到「离那天的地点开车最近」的那天
async function refineDay(t, p) {
  const others = t.places.filter((x) => x !== p && !x.done && x.day >= 1 && x.day <= t.days);
  if (!others.length) return;
  const rows = await travelRow('car', p, others).catch(() => null);
  if (!rows) return;
  let best = p.day;
  let bestDur = Infinity;
  others.forEach((x, i) => {
    if (rows[i] && rows[i].dur < bestDur) {
      bestDur = rows[i].dur;
      best = x.day;
    }
  });
  if (best !== p.day && !p.dayLocked) {
    delete t.dayPlans[p.day];
    delete t.dayPlans[best];
    p.day = best;
    save();
    if (currentView === 'map') scheduleReplan(300);
  }
}

// 新加的地点放哪一天：正在看某一天就放那天；总览时先放直线最近的那天（之后 refineDay 用真实路程再改）
function guessDay(t, p) {
  if (t.curDay) return t.curDay;
  let best = 1;
  let bestD = Infinity;
  for (let d = 1; d <= t.days; d++) {
    const ps = t.places.filter((x) => x.day === d && x !== p);
    if (!ps.length) return d;
    const c = { lat: ps.reduce((a, x) => a + x.lat, 0) / ps.length, lon: ps.reduce((a, x) => a + x.lon, 0) / ps.length };
    const dist = haversine(c, p);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

/* ---- 手动调整顺序 ---- */

let lastBundle = null;
let reorderMode = false;

function setReorderMode(on) {
  reorderMode = on;
  $('#reorderBar').hidden = !on;
  if (on) setSheet('full');
  renderMap();
}

// 计算资料还能用吗（同一个行程、同一天、剩下的地点没变）
function bundleFits(t) {
  const day = isMulti(t) ? t.curDay : null;
  if (!lastBundle || lastBundle.trip !== t || lastBundle.day !== day) return false;
  const ids = lastBundle.remaining.map((p) => p.id).sort().join();
  const now = t.places
    .filter((p) => !p.done && (day == null || p.day === day) && !(t.plan?.closedIds || []).includes(p.id))
    .map((p) => p.id).sort().join();
  return ids === now;
}

function moveStop(id, dir) {
  const t = T();
  const order = [...t.plan.order];
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  justMoved = id;
  applyManualOrder(order);
}

$('#btnReorder').addEventListener('click', () => {
  if (!T().plan?.order.length) return toast('还没有路线可以调整');
  setReorderMode(true);
  toast('按住「拖动」把地点拖到想要的位置', 3000);
});
$('#btnReorderDone').addEventListener('click', () => setReorderMode(false));
$('#btnAutoOrder').addEventListener('click', () => {
  const t = T();
  setManual(t, isMulti(t) ? t.curDay : null, null);
  save();
  if (bundleFits(t)) applyOrder(lastBundle, lastBundle.best.order, false);
  else replan();
  toast('已恢复成最省时间的顺序');
});

// 画路线：连续同一种交通方式的段合并成一次请求（在背景做，不挡住下一次计算）
async function fetchLines(trip, plan, ptsOrder, legs, estimated) {
  const ls = legs.filter(Boolean);
  const runs = [];
  const addRun = (mode, a, b) => {
    if (runs.length && runs[runs.length - 1].mode === mode && !runs[runs.length - 1].coords) runs[runs.length - 1].pts.push(b);
    else runs.push({ mode, pts: [a, b] });
  };
  for (let i = 0; i < ls.length; i++) {
    if (ls[i].parts) {
      ls[i].parts.forEach((x) => addRun(x.mode, x.from, x.to));
      continue;
    }
    // 没找到公交（建议打车）的那段，照开车的路线画
    const mode = ls[i].mode === 'transit' && ls[i].noTransit ? 'car' : ls[i].mode;
    if (mode === 'transit') {
      // 公交每一段自己画：有查到班次就用真实路线形状
      const coords = ls[i].transit ? ls[i].transit.legs.flatMap((x) => x.coords) : null;
      runs.push({ mode, icon: transitKind(ls[i].transit), pts: [ptsOrder[i], ptsOrder[i + 1]], coords: coords?.length ? coords : null });
    } else if (runs.length && runs[runs.length - 1].mode === mode) runs[runs.length - 1].pts.push(ptsOrder[i + 1]);
    else runs.push({ mode, pts: [ptsOrder[i], ptsOrder[i + 1]] });
  }
  // 这个计划还在用吗（当前这天的，或总览里某一天的）
  const alive = () => trip.plan === plan || (plan.day != null && trip.dayPlans?.[plan.day] === plan);
  const lines = [];
  for (const r of runs) {
    if (!alive()) return;
    let coords = r.coords || null;
    try {
      if (!coords && r.mode !== 'transit') coords = estimated ? null : await routeLine(r.mode, r.pts);
    } catch (e) {
      console.warn(e);
    }
    lines.push({ mode: r.mode, icon: r.icon, coords: coords || r.pts.map((p) => [p.lon, p.lat]) });
  }
  if (alive()) {
    plan.lines = lines;
    save();
    if (T() === trip) drawRoute();
  }
}

/* ================= 地图页列表 ================= */

function stopInfoMap() {
  const m = new Map();
  const t = T();
  const plan = t?.plan;
  if (!plan) return m;
  let num = 0;
  plan.stops.forEach((st, i) => {
    const p = t.places.find((x) => x.id === st.id);
    if (!p || p.done) return;
    const cls = st.flag === 'closed' ? 'bad' : st.flag === 'short' || st.flag === 'late' ? 'warn' : '';
    m.set(st.id, { num: ++num, cls, st, legIn: plan.legs[i] });
  });
  return m;
}

function hoursLine(p) {
  const plan = T().plan;
  const when = plan ? plan.startTime : Date.now();
  const h = placeHoursOn(p, new Date(when));
  if (!h.known) {
    return p.hoursRaw
      ? `<span class="muted">营业时间：${esc(p.hoursRaw)}（看不懂，点这里手动输入）</span>`
      : `<span class="muted">营业时间未知 · 点这里输入</span>`;
  }
  const isToday = startOfDay(when) === startOfDay(Date.now());
  const dayLabel = isToday ? '今天' : '当天';
  if (!h.windows.length) return `<span class="note bad">${dayLabel}休息</span>`;
  const txt = h.windows.map(([o, c]) => `${minToHHMM(o)}–${minToHHMM(c)}`).join('，');
  let extra = '';
  if (isToday) {
    const nowMin = (Date.now() - startOfDay(Date.now())) / 60e3;
    const cur = h.windows.find(([o, c]) => nowMin >= o && nowMin < c);
    const next = h.windows.find(([o]) => o > nowMin);
    if (cur) extra = ` · <span class="note ok">营业中，${fmtDur((cur[1] - nowMin) * 60e3)}后关门</span>`;
    else if (next) extra = ` · ${minToHHMM(next[0])} 开门`;
    else extra = ' · <span class="note bad">今天已关门</span>';
  }
  return `${dayLabel} ${txt}${extra}${h.source === 'manual' ? ' <span class="muted">（手动）</span>' : ''}`;
}

// 这一段主要是怎么去的（地图上的小图标用）
function legKind(l) {
  if (!l) return null;
  if (l.mode === 'transit') return l.noTransit ? 'car' : transitKind(l.transit);
  return l.mode === 'car' ? 'car' : 'foot';
}

// 一段公交主要是搭什么：坐最久的那一程是巴士就是 bus，地铁 / 电车 / 火车就是 train
function transitKind(tr) {
  const rides = (tr?.legs || []).filter((x) => x.mode !== 'WALK');
  if (!rides.length) return 'bus';
  const main = rides.reduce((a, b) => (b.dur > a.dur ? b : a));
  return /BUS|COACH/.test(main.mode) ? 'bus' : 'train';
}

const TRANSIT_ZH = { BUS: '巴士', TRAM: '电车', SUBWAY: '地铁', RAIL: '火车', REGIONAL_RAIL: '火车', HIGHSPEED_RAIL: '高铁', FERRY: '渡轮', METRO: '地铁', COACH: '长途巴士', AIRPLANE: '飞机', CABLE_CAR: '缆车', FUNICULAR: '缆车' };
function transitSteps(tr) {
  return tr.legs
    .filter((x) => x.dur >= 60e3 || x.mode !== 'WALK')
    .map((x) => (x.mode === 'WALK'
      ? `步行 ${fmtDur(x.dur)}`
      : `${TRANSIT_ZH[x.mode] || '公交'} ${x.route}${x.headsign ? `（往 ${x.headsign}）` : ''} ${fmtDur(x.dur)}${x.from ? `，${x.from} 上车` : ''}${x.to ? ` → ${x.to} 下车` : ''}`))
    .join(' → ');
}

// 开车到这里、下一段是走路（或走回停车处）→ 车就停在这里
function parkHere(legIn, nextId) {
  if (!legIn || legIn.mode !== 'car' || legIn.parts?.at(-1)?.mode === 'foot') return false;
  const next = nextId && stopInfoMap().get(nextId)?.legIn;
  return !!next && (next.mode === 'foot' || next.parts?.[0]?.mode === 'foot');
}

function legHtml(l) {
  if (!l) return '';
  if (l.mode === 'transit') {
    const routes = l.transit ? [...new Set(l.transit.legs.filter((x) => x.mode !== 'WALK').map((x) => x.route).filter(Boolean))].join(' / ') : '';
    const kind = l.noTransit ? 'car' : transitKind(l.transit);
    const label = l.noTransit ? '建议打车' : kind === 'bus' ? '巴士' : '地铁 / 火车';
    const detail = l.transit
      ? transitSteps(l.transit)
      : l.noTransit ? `这段没找到公交，打车大约 ${fmtDur(l.dur / 1.6)}` : '估计时间，正在查班次…';
    return `<div class="leg transit m-${kind}"><div class="tl-time"></div><div class="tl-rail"><i></i></div>
      <div class="leg-tr"><span class="leg-pill m-${kind}">${modeIcon(kind, 15)} ${label} ${fmtDur(l.dur)}${routes ? ` · ${esc(routes)}` : ''}</span><div class="leg-detail">${esc(detail)}</div></div></div>`;
  }
  if (l.parts) {
    // 走回停车处 → 开车 → 走过去
    const pill = (x, i) => {
      const k = x.mode === 'car' ? 'car' : 'foot';
      const txt = x.mode === 'car'
        ? `开车 ${fmtDur(x.dur)} · ${fmtDist(x.dist)}${l.parts[i + 1] ? `，停在${x.to.name ? `「${x.to.name.split(' ')[0]}」` : ''}附近` : ''}`
        : i === 0 ? `走回停车处${x.to.name ? `「${x.to.name.split(' ')[0]}」` : ''} ${fmtDur(x.dur)}` : `停好车走过去 ${fmtDur(x.dur)}`;
      return `<span class="leg-pill m-${k}">${modeIcon(k, 15)} ${esc(txt)}</span>`;
    };
    return `<div class="leg car combo"><div class="tl-time"></div><div class="tl-rail"><i></i></div><div class="leg-tr leg-chain">${l.parts.map(pill).join('')}</div></div>`;
  }
  const k = l.mode === 'car' ? 'car' : 'foot';
  return `<div class="leg ${l.mode}"><div class="tl-time"></div><div class="tl-rail"><i></i></div><span class="leg-pill m-${k}">${modeIcon(k, 15)} ${MODE_NAME[k]} ${fmtDur(l.dur)} · ${fmtDist(l.dist)}</span></div>`;
}

function renderMap() {
  const t = T();
  if (!t) return;
  $('#tripTitle').textContent = t.name;
  loadWeather(t);
  updateGeoWatch();
  renderDayTabs(t);
  drawMarkers();
  drawRoute();
  if (isMulti(t) && !t.curDay) return renderOverview(t);
  const list = $('#list');
  const plan = t.plan;
  const inDay = (p) => !isMulti(t) || p.day === t.curDay;
  const active = t.places.filter((p) => !p.done && inDay(p));
  const done = t.places.filter((p) => p.done && inDay(p));

  if (!t.places.length) {
    $('#summary').textContent = '还没有地点';
  } else if (!active.length) {
    $('#summary').textContent = `${done.length} 个地点全部去过了！`;
  } else if (plan) {
    const travel = plan.legs.reduce((a, l) => a + (l?.dur || 0), 0);
    const warnN = plan.stops.filter((x) => x.flag).length + (plan.closedIds?.length || 0);
    $('#summary').innerHTML =
      `${plan.stops.length} 个地点 · ${fmtClock(plan.startTime)} 出发 · 约 ${fmtClock(plan.endArrive ?? plan.finish)} 结束` +
      `<div class="small muted">${wxChip(weatherOn(t, isMulti(t) ? t.curDay : null))}${sunMini(t, plan)} <span class="nw">路上共 ${fmtDur(travel)}</span>` +
      (plan.manual
        ? ` · <span class="badge">你的顺序</span>${plan.extra > 60e3 ? ` 比最优路线多 ${fmtDur(plan.extra)}` : ' 已经是最省时间的'}`
        : plan.saved > 60e3 ? ` · 比按添加顺序省 ${fmtDur(plan.saved)}` : '') +
      (warnN ? ` · <span class="note warn">${warnN} 个地点有时间问题</span>` : '') +
      `</div>`;
  } else {
    $('#summary').textContent = `${active.length} 个地点 · 计算中…`;
  }

  if (!t.places.length) {
    list.innerHTML = '<div class="empty">按右上角「＋ 地点」开始添加想去的地方</div>';
    return;
  }

  const info = stopInfoMap();
  let html = '';
  if (plan && plan.stops.length) {
    html += dayBarHtml(t, plan);
    const rain = rainAdvice(t, isMulti(t) ? t.curDay : null, active);
    if (rain) html += `<div class="rain-note">${ic('rain', 16)} ${rain}</div>`;
    const navName = NAV_APPS[state.navApp || 'google'];
    html += `<button type="button" class="nav-all">${ic('route', 18)}<span>${state.navApp && state.navApp !== 'google' ? `用 ${navName} 导航到下一站` : `用 Google Maps 导航${isMulti(t) ? '这天' : ''}全程`}</span>${ic('chevron', 16)}</button>`;
    const o = plan.origin;
    const tips = hotelTips(t, plan);
    html += `<div class="endpoint${tips.out ? ' has-tip' : ''}"><div class="tl-time tl-edit${T().dayDepart?.[manualKey(isMulti(t) ? t.curDay : null)] ? ' fixed' : ''}" data-daytime="1" title="改出发时间"><b>${fmtClock(plan.startTime)}</b><i>${ic('edit', 11)}</i></div><div class="tl-rail"><div class="ep-dot">${ic(o?.kind === 'home' ? 'bed' : o?.kind === 'done' ? 'check' : 'pin', 15)}</div></div><div class="ep-text">${o ? esc(o.name) : '从第一站开始'}<span>出发</span>${tips.out || ''}</div></div>`;
  }
  const planned = plan ? plan.order.filter((id) => info.has(id)) : [];
  const sun = sunForPlan(t, plan);
  for (const id of planned) {
    const p = t.places.find((x) => x.id === id);
    const i = info.get(id);
    const st = i.st;
    html += legHtml(i.legIn);
    let note = '';
    if (st.flag === 'closed') note = `<div class="note bad closed-note">${ic('alert', 14)} ${fmtClock(st.arrive)} 到的时候已经关门，建议跳过或改天</div>${moveDayBtns(t, p)}`;
    else if (st.flag === 'short') note = `<div class="note warn">${ic('clock', 14)} ${fmtClock(st.closeAt)} 关门，只能待 ${fmtDur(st.closeAt - st.start)}</div>`;
    else if (st.flag === 'late') note = `<div class="note warn">${ic('clock', 14)} 比你定的 ${fmtClock(st.fixed)} 晚 ${fmtDur(st.arrive - st.fixed)} 到（前面太赶，可以改晚一点或少停留）</div>`;
    if (st.wait > (st.fixed ? 10 : 1) * 60e3) {
      note += p.checkin
        ? `<div class="note warn">${ic('clock', 14)} ${esc(p.fixedTime)} 才能入住，早到 ${fmtDur(st.wait)}：可以先寄放行李</div>`
        : st.fixed
          ? `<div class="note ok">${ic('clock', 14)} 早到 ${fmtDur(st.wait)}，可以在附近走走（你定 ${fmtClock(st.fixed)} 开始）</div>`
          : `<div class="note warn">${ic('clock', 14)} 要等 ${fmtDur(st.wait)} 才开门</div>`;
    }
    const closedNow = st.flag === 'closed';
    html += `<div class="stop ${i.cls}" data-id="${id}">
      <div class="tl-time tl-edit ${p.fixedTime ? 'fixed' : ''}" data-act="time" title="改时间"><b>${fmtClock(closedNow ? st.arrive : st.start)}</b>${closedNow ? '' : `<span>${fmtClock(st.depart)}</span>`}<i>${ic(p.fixedTime ? 'pinned' : 'edit', 11)}</i></div>
      <div class="tl-rail"><div class="num">${i.num}</div></div>
      <div class="tl-card">
        <div class="tl-top" data-act="edit">
          <div class="si-thumb sm" data-prev="${planned.indexOf(id)}">${kindIcon(p.kind)}</div>
          <div class="body">
            <div class="name">${esc(p.name)}</div>
            <div class="chips-row">${p.fixedTime ? `<span class="chip fix-chip" data-act="time">${ic('pinned', 12)} ${p.checkin ? `${esc(p.fixedTime)} 起入住` : `固定 ${esc(p.fixedTime)}`}</span>` : ''}${closedNow ? '' : `<span class="chip">${ic('clock', 12)} 停留 ${fmtDur(st.depart - st.start)}</span>`}${parkHere(i.legIn, planned[planned.indexOf(id) + 1]) ? '<span class="chip park-chip">P 车停这里，走路逛附近</span>' : ''}${legKind(i.legIn) === 'car' && !visibleParkIds().has(id) ? '<span class="chip park-btn" data-act="parking">P 找停车场</span>' : ''}${sunChip(p, st, sun)}</div>
            <div class="hours">${hoursLine(p)}</div>
          </div>
        </div>
        ${note}
        ${p.note ? `<div class="memo">${ic('note', 13)} ${esc(p.note)}</div>` : ''}
        ${legKind(i.legIn) === 'car' && visibleParkIds().has(id) ? `<div class="park-box" data-parkfor="${id}"><div class="pk-msg">正在找附近的停车场…</div></div>` : ''}
        <div class="acts">${reorderMode
          ? `<button class="drag-h" type="button" aria-label="按住拖动">${ic('grip', 18)} 按住拖动</button><button class="mv" data-act="up" ${i.num === 1 ? 'disabled' : ''} aria-label="往前">▲</button><button class="mv" data-act="down" ${i.num === planned.length ? 'disabled' : ''} aria-label="往后">▼</button>`
          : `<button data-act="nav">${ic('nav', 15)} 导航</button><button data-act="info">${ic('info', 15)} 介绍</button><button data-act="done" class="done-btn">${ic('check', 15)} 去过了</button>`}
        </div>
      </div></div>`;
  }
  if (planned.length && !plan.end && isMulti(t) && t.curDay === t.days && !endHotel(t, t.curDay)) {
    html += `<div class="last-day-note">${ic('check', 14)} 最后一天：退房后玩完就结束，不用回酒店</div>`;
  }
  if (plan?.end && planned.length) {
    html += legHtml(plan.legs[plan.legs.length - 1]);
    html += `<div class="endpoint last"><div class="tl-time tl-edit" data-daytime="1" title="改时间"><b>${fmtClock(plan.endArrive)}</b><i>${ic('edit', 11)}</i></div><div class="tl-rail"><div class="ep-dot">${ic('bed', 15)}</div></div><div class="ep-text">${esc(plan.end.name)}<span>${hotelTips(t, plan).in ? '入住' : '回到住的地方'}</span>${hotelTips(t, plan).in || ''}</div></div>`;
  }
  const closedIds = plan?.closedIds || [];
  const closed = active.filter((p) => closedIds.includes(p.id));
  if (closed.length) {
    html += `<div class="section-title">当天休息，没排进路线（${closed.length}）</div>`;
    for (const p of closed) {
      html += `<div class="stop simple bad" data-id="${p.id}"><div class="num">✕</div>
        <div class="body" data-act="edit"><div class="name">${esc(p.name)}</div>
        <div class="hours">${hoursLine(p)}</div>${moveDayBtns(t, p)}</div>
        <div class="acts"><button data-act="info" title="介绍">${ic('info', 15)}</button><button data-act="del" title="删除">✕</button></div></div>`;
    }
  }
  const unplanned = active.filter((p) => !info.has(p.id) && !closedIds.includes(p.id));
  if (unplanned.length) {
    html += `<div class="section-title">等待计算</div>`;
    for (const p of unplanned) {
      html += `<div class="stop simple pending" data-id="${p.id}"><div class="num">?</div>
        <div class="body" data-act="edit"><div class="name">${esc(p.name)}</div>
        <div class="hours">${hoursLine(p)}</div></div>
        <div class="acts"><button data-act="info" title="介绍">${ic('info', 15)}</button><button data-act="del" title="删除">✕</button></div></div>`;
    }
  }
  if (done.length) {
    html += `<div class="section-title">已去过（${done.length}）</div>`;
    for (const p of done) {
      html += `<div class="stop simple done" data-id="${p.id}"><div class="num">✓</div>
        <div class="body" data-act="edit"><div class="name">${esc(p.name)}</div></div>
        <div class="acts"><button data-act="info" title="介绍">${ic('info', 15)}</button><button data-act="undo">恢复</button><button data-act="del" title="删除">✕</button></div></div>`;
    }
  }
  list.innerHTML = html;
  if (justMoved) {
    list.querySelector(`.stop[data-id="${justMoved}"]`)?.classList.add('bump');
    justMoved = null;
  }
  hydrateThumbs(list, planned.map((id) => t.places.find((x) => x.id === id)));
  hydrateParking();
  drawParkMarkers();
}

$('#list').addEventListener('click', (e) => {
  const actEl = e.target.closest('[data-act]');
  const row = e.target.closest('.stop');
  if (!actEl || !row) return;
  const p = T().places.find((x) => x.id === row.dataset.id);
  if (!p) return;
  const act = actEl.dataset.act;
  if (act === 'edit') {
    map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 14) });
    openDetails(p, { inTrip: true });
  } else if (act === 'nav') openNav(p);
  else if (act === 'info') openDetails(p, { inTrip: true });
  else if (act === 'parking') {
    parkOpen.add(p.id);
    renderMap();
  }
  else if (act === 'done') markDone(p.id, true);
  else if (act === 'up') moveStop(p.id, -1);
  else if (act === 'down') moveStop(p.id, 1);
  else if (act === 'undo') markDone(p.id, false);
  else if (act === 'moveday') movePlaceToDay(p, Number(actEl.dataset.day));
  else if (act === 'time') openTimeDialog(p);
  else if (act === 'del') removePlace(p.id);
});

function focusPlace(id) {
  setSheet('peek');
  highlightMarker(id);
  const row = document.querySelector(`.stop[data-id="${id}"]`) || document.querySelector(`.dc-item[data-id="${id}"]`);
  document.querySelectorAll('.stop.hl, .dc-item.hl').forEach((x) => x.classList.remove('hl'));
  if (row) {
    row.classList.add('hl');
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function markDone(id, done) {
  const t = T();
  const p = t.places.find((x) => x.id === id);
  if (!p) return;
  const before = { done: p.done, doneAt: p.doneAt, doneDepart: p.doneDepart };
  p.done = done;
  if (done) {
    // 记下什么时候、预计几点离开：下一段从这里接着算
    const st = t.plan?.stops.find((x) => x.id === id) || t.dayPlans?.[p.day]?.stops.find((x) => x.id === id);
    p.doneAt = Date.now();
    p.doneDepart = st ? st.depart : Date.now();
  } else {
    delete p.doneAt;
    delete p.doneDepart;
  }
  save();
  renderMap();
  scheduleReplan(300);
  snackbar(done ? `${p.name} 去过了，从这里接着排` : `已恢复 ${p.name}`, () => {
    Object.assign(p, before);
    if (!before.doneAt) delete p.doneAt;
    if (!before.doneDepart) delete p.doneDepart;
    save();
    renderMap();
    scheduleReplan(100);
  });
}

function removePlace(id) {
  const t = T();
  const idx = t.places.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const p = t.places[idx];
  t.places.splice(idx, 1);
  save();
  renderMap();
  scheduleReplan();
  snackbar(`已删除「${p.name}」`, () => {
    t.places.splice(idx, 0, p);
    save();
    renderMap();
    scheduleReplan(100);
  });
}

// 底部提示条，带「撤销」按钮（6 秒后消失）
let snackTimer = null;
let snackUndo = null;
function snackbar(msg, undo) {
  $('#snackMsg').textContent = msg;
  snackUndo = undo;
  $('#snackUndo').hidden = !undo;
  $('#snackbar').hidden = false;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => ($('#snackbar').hidden = true), 6000);
}
$('#snackUndo').addEventListener('click', () => {
  $('#snackbar').hidden = true;
  const u = snackUndo;
  snackUndo = null;
  if (u) {
    u();
    toast('已撤销');
  }
});

function openNav(p) {
  const plan = T().plan;
  const l = plan?.legs?.[plan.order.indexOf(p.id)];
  // 要先开车到停车处、再走过去：导航到停车处
  const car = l?.parts?.find((x) => x.mode === 'car');
  if (car && l.parts.at(-1).mode === 'foot') {
    toast(`先开到停车处「${car.to.name.split(' ')[0] || '附近'}」，停好车再走过去`, 3500);
    return goNav(car.to, 'driving');
  }
  const mode = l?.mode === 'foot' ? 'walking' : l?.mode === 'transit' ? 'transit' : 'driving';
  goNav(p, mode);
}

/* 地图页：加地点 */
let addedInDialog = 0;
const addSearch = createSearch($('#addSearch'), {
  placeholder: '地名、地址、链接；多个用逗号分开',
  nearLabel: () => '离地图中心',
  near: () => {
    if (map) {
      const c = map.getCenter();
      return { lat: c.lat, lon: c.lng };
    }
    return searchCenter();
  },
  action: placeAction,
  onPick: pickPlace,
  bulk: true,
  bulkAfter: () => $('#addDialog').close(),
});
$('#btnAdd').addEventListener('click', () => {
  addedInDialog = 0;
  picked.splice(0);
  updatePickUI();
  addSearch.clear();
  $('#addDialog').showModal();
  addSearch.focus();
});
$('#addDone').addEventListener('click', () => {
  if (picked.length) confirmPicked(() => $('#addDialog').close());
  else $('#addDialog').close();
});
$('#addDialog').addEventListener('close', () => {
  renderMap();
  if (addedInDialog) {
    toast(`加了 ${addedInDialog} 个地点，重新排路线`);
    scheduleReplan(100);
    setTimeout(fitAll, 400);
  }
});

/* ---- 一次贴上很多地点：从小红书、文章、聊天复制一整段 ---- */

const MAX_BULK = 30;
const BULK_LABEL = /^(day\s*\d+|d\d+|第[一二三四五六七八九十\d]+[天站]|上午|下午|早上|中午|晚上|傍晚|早餐|午餐|晚餐|宵夜|行程|路线|景点|必去|推荐|打卡|住宿|酒店|stop\s*\d+)$/i;
const BULK_HEADER = /攻略|合集|清单|总结|必去|必玩|必吃|懒人包|itinerary|guide|\d+\s*天\s*\d*\s*夜?$/i;
// 把一段文字拆成一个一个地点名字 / Google Maps 链接
function parseBulk(text) {
  const items = [];
  const seen = new Set();
  const push = (it) => {
    const k = it.url || nameKey(it.q);
    if (!k || seen.has(k)) return;
    seen.add(k);
    items.push(it);
  };
  for (let line of text.split(/[\n\r]+/)) {
    for (const u of line.match(/https?:\/\/\S+/g) || []) {
      push({ url: u.replace(/[)）\]】，。,.!！]+$/, '') });
      line = line.replace(u, ' ');
    }
    // 去掉编号、项目符号、emoji、#标签符号
    line = line
      .replace(/\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, ' ')
      .replace(/^[\s\-–—*•·>]*(?:\d+\s*[.、．)）:：]|\d+\s+(?=[^\x00-\x7F])|[①-⑳]|[一二三四五六七八九十]+\s*[.、．)）:：])?\s*/u, '')
      .replace(/#/g, ' ')
      .trim();
    // 「第2天：」「Day1:」这种开头先拿掉（不然里面的数字会被当成门牌）
    const lm = /^([^:：]{1,12})[:：]\s*/.exec(line);
    if (lm && BULK_LABEL.test(lm[1].trim())) line = line.slice(lm[0].length).trim();
    if (!line) continue;
    // 看起来是门牌地址：整行当一个
    const isAddr = /\d/.test(line) && /jalan|lebuh|lorong|road|street|\brd\b|\bst\b|ave|路|街|号|丁目/i.test(line);
    const parts = isAddr ? [line] : line.split(/[，,、;；|/]+|→|->|➡|＞|>|\s{2,}/);
    for (let x of parts) {
      x = x.trim();
      // 「Day1：升旗山」→ 要冒号后面；「极乐寺：门票 RM10」→ 要冒号前面
      const colon = x.split(/[:：]/);
      if (colon.length > 1) {
        const head = colon[0].trim();
        x = BULK_LABEL.test(head) || head.length < 2 ? colon.slice(1).join(' ').trim() : head;
      }
      // 「槟城3天攻略」这种标题不用找
      if (BULK_HEADER.test(x)) continue;
      // 括号里的另一个名字留着备用：「极乐寺（Kek Lok Si）」
      const m = /^(.+?)\s*[（(]([^）)]+)[）)]\s*$/.exec(x);
      const q = (m ? m[1] : x).trim();
      const alt = m ? m[2].trim() : '';
      if (q.length < 2 || q.length > 60 || /^[\d\s.,]+$/.test(q)) continue;
      push({ q, alt });
    }
  }
  return items.slice(0, MAX_BULK);
}

// 找一个：Google Maps 链接 → 热门景点名单 → 地图搜索 → 输入建议
async function findBulkItem(it) {
  const t = T();
  const bbox = t?.dest?.bbox || null;
  const near = searchCenter();
  if (it.url) {
    if (/goo\.gl|maps\.app/i.test(it.url)) return { fail: '短链接读不到（请在 Google Maps 按「分享」→ 复制完整链接，或直接打名字）' };
    const c = parseCoords(it.url);
    const raw = /\/place\/([^/@?]+)/.exec(it.url)?.[1];
    const name = raw ? decodeURIComponent(raw.replace(/\+/g, ' ')) : '';
    if (name && c) {
      // 同名的车站、公交站排后面，离链接坐标近的排前面
      const STOP = /station|halt|stop|platform|subway_entrance|bus/;
      const r = (await searchPlaces(name, [c.lon - 0.01, c.lat - 0.01, c.lon + 0.01, c.lat + 0.01], true).catch(() => []))
        .sort((a, b) => STOP.test(a.kind) - STOP.test(b.kind) || haversine(a, c) - haversine(b, c));
      return r[0] || { name, alt: '', en: '', address: '', lat: c.lat, lon: c.lon, kind: '', needsDetails: true };
    }
    if (c) return reverseGeocode(c.lat, c.lon).catch(() => null);
    if (!name) return null;
    it = { q: name, alt: '' };
  }
  // 结果要在这个城市附近，而且不能是城市 / 地区本身（例如「吉隆坡必去」这种标题）
  const pad = bbox ? Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 0.3 : 0;
  const inBox = (r) => !bbox || (r.lon >= bbox[0] - pad && r.lon <= bbox[2] + pad && r.lat >= bbox[1] - pad && r.lat <= bbox[3] + pad);
  const okKind = (r) => !/^(city|town|village|state|country|administrative|county|region|province|municipality|suburb)$/.test(r.kind || '');
  // 车站、公交站：除非自己打的就是「…站」
  const STOP = /bus_stop|platform|station|halt|stop_position|stop_area|tram_stop|subway_entrance/;
  const ok = (r, q = '') => r && inBox(r) && okKind(r) && nameKey(r.name).length >= 2 && (!STOP.test(r.kind || '') || /站|station|stesen|terminal|sentral/i.test(q));
  // 输入建议是模糊搜索：名字要有一段连续相同（「双子塔」不能配到「双威金字塔」）
  const similar = (q, r) => [r.name, r.en, r.alt].some((n) => {
    const a = nameKey(q);
    const b = nameKey(n);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    let best = 0;
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (a[i + k] && a[i + k] === b[j + k]) k++;
      best = Math.max(best, k);
    }
    return best >= Math.max(2, Math.ceil(Math.min(a.length, b.length) * 0.6));
  });
  const tryName = async (q) => {
    const key = nameKey(q);
    const pop = popular.items && popular.key === bbox?.join(',') ? popular.items : [];
    const hit = pop.find((x) => [x.name, x.en, x.alt].some((n) => {
      const k = nameKey(n);
      return k && (k === key || (key.length >= 3 && (k.includes(key) || key.includes(k))));
    }));
    if (hit) return hit;
    const res = await smartSearch(q, bbox, near).catch(() => null);
    const r1 = (res?.results || []).find((x) => ok(x, q) && similar(q, x));
    if (r1) return r1;
    const sug = await suggestPlaces(q, near, bbox).catch(() => []);
    return sug.find((x) => ok(x, q) && similar(q, x)) || null;
  };
  return (await tryName(it.q)) || (it.alt ? await tryName(it.alt) : null);
}

let bulkAfter = null;
let bulkRun = 0;
function openBulk(after = null) {
  bulkAfter = after;
  $('#bulkStatus').textContent = '';
  $('#bulkGo').disabled = false;
  $('#bulkPaste').hidden = !navigator.clipboard?.readText;
  $('#bulkDialog').showModal();
}
$('#bulkPaste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) $('#bulkText').value = text;
    else toast('剪贴板是空的');
  } catch {
    toast('读不到剪贴板，请长按输入框选「贴上」');
  }
});
$('#bulkCancel').addEventListener('click', () => {
  bulkRun++;
  $('#bulkDialog').close();
});
// 一个一个找（地图搜索每秒只能问一次）；返回 null = 中途取消了
async function runBulk(items, progress, alive) {
  const found = [];
  const missing = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    progress(`正在找 ${i + 1}/${items.length}：${it.q || '链接'}…`);
    const r = await findBulkItem(it).catch(() => null);
    if (!alive()) return null;
    if (r && !r.fail) {
      if (!found.some((x) => samePlace(x, r))) found.push(r);
    } else missing.push(r?.fail ? `链接 ${i + 1}（${r.fail}）` : it.q);
  }
  return { found, missing };
}
// 找到的放进「已选」，弹出确认；全部都没有新的就返回说明文字
function offerBulk({ found, missing }, after) {
  const fresh = found.filter((r) => !inTrip(r) && pickedIndex(r) < 0);
  fresh.forEach((r) => picked.push(r));
  refreshPickViews();
  if (!fresh.length) return found.length ? '这些地点都已经在行程里了' : `一个都找不到：${missing.join('、')}`;
  const already = found.length - fresh.length;
  confirmPicked(after, `找到 ${fresh.length} 个地点${already ? `（另外 ${already} 个已在行程里）` : ''}，加入吗？`, missing);
  return null;
}

$('#bulkGo').addEventListener('click', async () => {
  const items = parseBulk($('#bulkText').value);
  if (!items.length) return toast('没有认出地点名字，请一行一个，或用逗号分开');
  const my = ++bulkRun;
  $('#bulkGo').disabled = true;
  const res = await runBulk(items, (msg) => ($('#bulkStatus').textContent = msg), () => my === bulkRun);
  $('#bulkGo').disabled = false;
  if (!res) return; // 按了取消
  $('#bulkDialog').close();
  const msg = offerBulk(res, bulkAfter);
  if (msg) {
    $('#bulkDialog').showModal();
    $('#bulkStatus').textContent = msg;
    return;
  }
  $('#bulkText').value = '';
});

/* ================= 多天：分页与总览 ================= */

function renderDayTabs(t) {
  const multi = isMulti(t);
  $('#dayTabs').hidden = !multi;
  const overview = multi && !t.curDay;
  $('#btnReorder').hidden = overview;
  $('#btnArrange').hidden = !multi;
  $('#tripSub').textContent = !multi ? (t.dest?.name || '') : overview ? `${t.days} 天 · ${fmtDay(t, 1)} 起` : `第 ${t.curDay} 天 · ${fmtDay(t, t.curDay)}`;
  if (!multi) return;
  const today = todayDay(t);
  $('#dayTabs').innerHTML =
    `<button data-day="0" class="${!t.curDay ? 'on' : ''}">总览</button>` +
    Array.from({ length: t.days }, (_, i) => {
      const d = i + 1;
      const x = dayDate(t, d);
      return `<button data-day="${d}" class="${t.curDay === d ? 'on' : ''}" style="--dc:${dayColor(d)}">
        <i></i>第${d}天<small>${x.getMonth() + 1}/${x.getDate()}${d === today ? ' 今天' : ''}</small></button>`;
    }).join('');
  $('#dayTabs .on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function switchDay(d) {
  const t = T();
  if (reorderMode) setReorderMode(false);
  t.curDay = d;
  t.plan = d ? t.dayPlans?.[d] || null : null;
  save();
  renderMap();
  setTimeout(fitAll, 50);
  if (d) {
    // 这天还没算、或是今天（要按现在的位置重算）
    if (!t.plan || d === todayDay(t)) replan();
  } else replanIfStale();
}

$('#dayTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-day]');
  if (b) switchDay(Number(b.dataset.day));
});

function renderOverview(t) {
  const list = $('#list');
  const active = t.places.filter((p) => !p.done);
  const s = t.settings;
  let totalTravel = 0;
  let html = '';
  let warnDays = 0;
  for (let d = 1; d <= t.days; d++) {
    const plan = t.dayPlans?.[d];
    const ps = t.places.filter((p) => p.day === d);
    const left = ps.filter((p) => !p.done);
    const travel = plan ? plan.legs.reduce((a, l) => a + (l?.dur || 0), 0) : 0;
    totalTravel += travel;
    const end = plan ? plan.endArrive ?? plan.finish : null;
    const late = plan && end > dayClock(t, d, s.dayEnd || '21:00');
    const warn = late || plan?.stops.some((x) => x.flag) || plan?.closedIds?.length;
    if (warn) warnDays++;
    const items = plan
      ? plan.stops
          .map((st) => {
            const p = t.places.find((x) => x.id === st.id);
            if (!p) return '';
            const flag = st.flag === 'closed' ? '<span class="dc-flag bad">已关门</span>' : st.flag === 'short' ? '<span class="dc-flag">快关门</span>' : '';
            return `<div class="dc-item ${p.done ? 'done' : ''}" data-id="${p.id}"><span class="dc-time">${fmtClock(st.start)}</span><span class="dc-dot"></span><span class="dc-name">${esc(p.name)}</span>${flag}<span class="dc-info" aria-label="介绍">${ic('info', 16)}</span></div>`;
          })
          .join('')
      : left.map((p) => `<div class="dc-item" data-id="${p.id}"><span class="dc-time">--:--</span><span class="dc-dot"></span><span class="dc-name">${esc(p.name)}</span></div>`).join('');
    const closed = (plan?.closedIds || []).map((id) => t.places.find((x) => x.id === id)).filter(Boolean);
    const doneHere = ps.filter((p) => p.done);
    html += `<div class="day-card" style="--dc:${dayColor(d)}">
      <div class="dc-head" data-goday="${d}">
        <span class="dc-badge">第${d}天</span>
        <div class="dc-h-main"><b>${esc(fmtDay(t, d))} ${wxChip(weatherOn(t, d))}</b>
          <span>${left.length ? `${left.length} 个地点${plan?.stops.length ? ` · ${fmtClock(plan.startTime)}–${fmtClock(end)} · 路上 ${fmtDur(travel)}` : ''}` : doneHere.length ? '全部去过了' : '这天还没有安排'}</span>
          ${(() => {
            const a = startHotel(t, d);
            const b = endHotel(t, d);
            if (!a && !b) return '';
            if (a && !b) return `<span class="dc-hotel">${ic('bed', 13)} ${esc(a.name)} · ${esc(checkOutOf(a))} 前退房，不用回酒店</span>`;
            if (sameHotel(a, b)) return `<span class="dc-hotel">${ic('bed', 13)} ${esc(a.name)}</span>`;
            return `<span class="dc-hotel">${ic('bed', 13)} ${esc(a?.name || '—')} → ${esc(b?.name || '—')}</span>
              <span class="dc-hotel dc-swap">${a ? `${esc(checkOutOf(a))} 前退房` : ''}${a && b ? ' · ' : ''}${b ? `${esc(checkInOf(b))} 起入住新酒店` : ''}</span>`;
          })()}
          ${ticketTotal(t, d) ? `<span class="dc-hotel">${ic('ticket', 13)} 门票约 ${esc(money(t, ticketTotal(t, d)))}（${t.people || 1} 人）</span>` : ''}</div>
        <span class="dc-go">看路线 ›</span>
      </div>
      ${dayBarHtml(t, plan, true)}
      ${items ? `<div class="dc-list">${items}</div>` : ''}
      ${closed.map((p) => `<div class="dc-warn" data-closedid="${p.id}">${ic('alert', 14)} <span>「${esc(p.name)}」这天休息${openDaysFor(t, p).length ? '' : '（建议换到别天）'}${moveDayBtns(t, p)}</span></div>`).join('')}
      ${(() => {
        const a = rainAdvice(t, d, ps);
        return a ? `<div class="dc-warn">${ic('rain', 14)} ${a}</div>` : '';
      })()}
      ${late ? `<div class="dc-warn">${ic('clock', 14)} 这天太满，预计 ${fmtClock(end)} 才回到住的地方，可以把一些地点换到别天</div>` : ''}
      ${doneHere.length && left.length ? `<div class="dc-done">${ic('check', 13)} 已去过 ${doneHere.length} 个</div>` : ''}
    </div>`;
  }
  const unassigned = active.filter((p) => !(p.day >= 1 && p.day <= t.days));
  if (unassigned.length) {
    html += `<div class="day-card" style="--dc:#94a3b8"><div class="dc-head"><span class="dc-badge">未分配</span><div class="dc-h-main"><b>${unassigned.length} 个地点还没分到哪一天</b><span>右上角 ⋯ →「重新分配每一天」</span></div></div>
      <div class="dc-list">${unassigned.map((p) => `<div class="dc-item" data-id="${p.id}"><span class="dc-time"></span><span class="dc-dot"></span><span class="dc-name">${esc(p.name)}</span></div>`).join('')}</div></div>`;
  }
  html += `<p class="small muted center">分配方法：同一区的地点放同一天，避开休息日，每天时间尽量平均。<br>想把某个地点固定在某一天：点它 → 编辑 → 「安排在」</p>`;
  list.innerHTML = html;

  $('#summary').innerHTML = active.length
    ? `${t.days} 天 · ${active.length} 个地点` +
      `<div class="small muted">${fmtDay(t, 1)} – ${fmtDay(t, t.days)} · 路上共 ${fmtDur(totalTravel)}${warnDays ? ` · <span class="note warn">${warnDays} 天要注意</span>` : ''}</div>`
    : `${t.places.length} 个地点全部去过了！`;
}

$('#list').addEventListener('click', (e) => {
  if (e.target.closest('.nav-all')) return openNavAll();
  if (e.target.closest('[data-daytime]')) return openDayTimeDialog();
  const mv = e.target.closest('[data-closedid] [data-act="moveday"]');
  if (mv) {
    const p = T().places.find((x) => x.id === mv.closest('[data-closedid]').dataset.closedid);
    if (p) movePlaceToDay(p, Number(mv.dataset.day));
    return;
  }
  const bar = e.target.closest('[data-barid]');
  if (bar) return focusPlace(bar.dataset.barid);
  const go = e.target.closest('[data-goday]');
  if (go) return switchDay(Number(go.dataset.goday));
  const item = e.target.closest('.dc-item');
  if (item) {
    const p = T().places.find((x) => x.id === item.dataset.id);
    if (p) openDetails(p, { inTrip: true });
  }
});

/* ================= 吃饭提醒：到了吃饭时间，找附近吃的，问要不要安排 ================= */

const MEALS = [
  { kind: 'lunch', label: '午餐', from: '11:45', to: '13:30', stay: 60 },
  { kind: 'dinner', label: '晚餐', from: '18:00', to: '19:45', stay: 75 },
];
const MEAL_KEY = 'shunlu:meal:v1';
const hmToMin = (hm) => {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
};
const nowMin = () => (Date.now() - startOfDay(Date.now())) / 60e3;
// 这个地方是不是吃饭的地方（餐厅、小贩中心、夜市、咖啡店…）
const FOOD_KIND = /restaurant|food|cafe|hawker|marketplace|fast_food|bakery|ice_cream|pub|bar\b/;
const FOOD_NAME = /小贩|美食|夜市|餐|饭|食|面|咖啡|茶室|hawker|food|kopitiam|café|cafe|restaurant|night market|pasar malam/i;
const isFood = (p) => FOOD_KIND.test(`${p.kind || ''} ${p.type || ''}`.toLowerCase()) || FOOD_NAME.test(p.name || '');

function mealState() {
  try {
    return JSON.parse(localStorage.getItem(MEAL_KEY)) || {};
  } catch {
    return {};
  }
}
function setMealState(key, value) {
  const st = mealState();
  st[key] = value;
  // 只留最近的记录
  Object.keys(st).sort().slice(0, -30).forEach((k) => delete st[k]);
  try {
    localStorage.setItem(MEAL_KEY, JSON.stringify(st));
  } catch {}
}

// 每分钟检查一次（地图页开着时）
function mealCheck() {
  const t = T();
  if (!t || currentView !== 'map' || document.visibilityState !== 'visible') return;
  if ($('#mealDialog').open || document.querySelector('dialog[open]')) return;
  // 只在「今天」的行程：多天看今天那一页；单日看计划是不是今天
  const day = isMulti(t) ? t.curDay : null;
  if (isMulti(t) ? !day || day !== todayDay(t) : !t.plan || startOfDay(t.plan.startTime) !== startOfDay(Date.now())) return;
  if (!t.places.some((p) => !p.done && (day == null || p.day === day))) return;
  const m = MEALS.find((x) => nowMin() >= hmToMin(x.from) && nowMin() <= hmToMin(x.to));
  if (!m) return;
  const key = `${todayStr()}|${t.id}|${m.kind}`;
  const st = mealState()[key];
  if (st === 'no' || st === 'done' || (typeof st === 'number' && Date.now() < st)) return;
  // 那天吃饭时间前后已经安排了吃的地方（或刚去过）→ 不用问
  const lo = startOfDay(Date.now()) + (hmToMin(m.from) - 75) * 60e3;
  const hi = startOfDay(Date.now()) + (hmToMin(m.to) + 75) * 60e3;
  const planned = (t.plan?.stops || []).some((s) => {
    const p = t.places.find((x) => x.id === s.id);
    return p && isFood(p) && s.start >= lo && s.start <= hi;
  });
  const ate = t.places.some((p) => p.done && isFood(p) && p.doneAt >= lo && p.doneAt <= hi);
  if (planned || ate) return;
  openMealPrompt(m, key);
}

let mealCtx = null; // { meal, key, list }
async function openMealPrompt(meal, key = null) {
  const t = T();
  mealCtx = { meal, key, list: [] };
  $('#mlTitle').textContent = key ? `到${meal.label}时间了，要安排吃饭的地方吗？` : '附近吃的';
  $('#mlSub').textContent = '正在找你附近的餐厅…';
  $('#mlList').innerHTML = '';
  $('#mealDialog').showModal();
  // 用哪里当中心：刚拿到的 GPS → 刚去过的地方 → 下一站 → 地图中心
  let center = lastGps && Date.now() - lastGps.at < 10 * 60e3 ? lastGps : null;
  if (!center) {
    try {
      center = await getGps(6000);
    } catch {
      const day = isMulti(t) ? t.curDay : null;
      const last = lastDonePlace(t, day);
      const next = t.plan?.stops[0] && t.places.find((p) => p.id === t.plan.stops[0].id);
      const c = map?.getCenter();
      center = last || next || (c ? { lat: c.lat, lon: c.lng } : searchCenter());
    }
  }
  let radius = 0.8;
  try {
    let features = [];
    // 先找 800 米内；太少就放宽到 3 公里
    for (radius of [0.8, 3]) {
      const params = new URLSearchParams({ lat: center.lat.toFixed(6), lon: center.lon.toFixed(6), limit: '20', radius: String(radius) });
      ['amenity:restaurant', 'amenity:food_court', 'amenity:fast_food', 'amenity:cafe'].forEach((x) => params.append('osm_tag', x));
      features = (await fetch(`https://photon.komoot.io/reverse?${params}`).then((r) => r.json())).features;
      if (features.filter((f) => f.properties.name).length >= 3) break;
    }
    const seen = new Set();
    mealCtx.list = features
      .filter((f) => f.properties.name)
      .map((f) => {
        const q = f.properties;
        return {
          name: q.name,
          address: [q.street && [q.street, q.housenumber].filter(Boolean).join(' '), q.district || q.city].filter(Boolean).join(', '),
          lat: f.geometry.coordinates[1],
          lon: f.geometry.coordinates[0],
          osm: q.osm_type && q.osm_id ? `${q.osm_type}${q.osm_id}` : null,
          kind: q.osm_value || 'restaurant',
          needsDetails: true,
        };
      })
      .filter((r) => !seen.has(r.name) && seen.add(r.name))
      .sort((a, b) => haversine(center, a) - haversine(center, b))
      .slice(0, 12);
    // 按真实走路时间重新排（直线近不代表走过去近，例如隔着河或大路）
    const rows = await travelRow('foot', center, mealCtx.list).catch(() => []);
    mealCtx.list.forEach((r, i) => (r.road = rows[i] || null));
    mealCtx.list = mealCtx.list.sort((a, b) => (a.road?.dur ?? 1e9) - (b.road?.dur ?? 1e9)).slice(0, 10);
  } catch {
    mealCtx.list = [];
  }
  if (!$('#mealDialog').open) return;
  const list = mealCtx.list;
  $('#mlSub').textContent = list.length
    ? `你附近 ${radius < 1 ? '800 米' : `${radius} 公里`}内的 ${list.length} 个地方，按距离排：`
    : '附近没找到有资料的餐厅，可以用「＋ 地点」自己搜索。';
  $('#mlList').innerHTML = list.map((r, i) => placeRowHtml(r, i, { label: '去这里吃' }, center, '离你')).join('');
  hydrateThumbs($('#mlList'), list);
  hydrateRoad($('#mlList'), list, center, '离你', 'foot');
}

// 选了一家：加进今天的行程，排成下一站
function chooseMeal(r) {
  const t = T();
  const day = isMulti(t) ? t.curDay : null;
  const p = addPlaceToTrip({ ...r, stayMin: mealCtx.meal.stay });
  p.stayMin = mealCtx.meal.stay;
  if (day) {
    p.day = day;
    p.dayLocked = true;
  }
  const rest = (t.plan?.order || []).filter((id) => id !== p.id);
  setManual(t, day, [p.id, ...rest]);
  if (mealCtx.key) setMealState(mealCtx.key, 'done');
  save();
  $('#mealDialog').close();
  toast(`已把「${r.name}」排成下一站`);
  replan();
}

$('#mlList').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-pick]');
  const prev = e.target.closest('[data-prev]');
  if (!pick && !prev) return;
  const r = mealCtx.list[Number(pick ? pick.dataset.pick : prev.dataset.prev)];
  if (pick) chooseMeal(r);
  else openPreview(r, () => ({ label: '去这里吃' }), chooseMeal);
});
$('#mlLater').addEventListener('click', () => {
  if (mealCtx?.key) setMealState(mealCtx.key, Date.now() + 30 * 60e3);
  $('#mealDialog').close();
  if (mealCtx?.key) toast('30 分钟后再问你');
});
$('#mlNo').addEventListener('click', () => {
  if (mealCtx?.key) setMealState(mealCtx.key, 'no');
  $('#mealDialog').close();
});
$('#btnFood').addEventListener('click', () => {
  const m = MEALS.find((x) => nowMin() <= hmToMin(x.to)) || MEALS[1];
  openMealPrompt(m);
});
setInterval(mealCheck, 60e3);

/* ================= 一键导航整天（Google Maps） ================= */

// 手机浏览器打开 Google Maps 网址时，最多带 3 个途经点；超过就分成好几段
const NAV_WAYPOINTS = 3;
const ll = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;

function navSegments() {
  const t = T();
  const plan = t.plan;
  if (!plan?.stops.length) return [];
  const stops = plan.stops.map((s) => t.places.find((p) => p.id === s.id)).filter((p) => p && !p.done);
  // 今天在路上：从「我现在的位置」开始（不填起点，Google Maps 会用目前位置）
  const day = isMulti(t) ? t.curDay : null;
  const live = startOfDay(plan.startTime) === startOfDay(Date.now()) && (day == null || day === todayDay(t));
  const pts = [...(live || !plan.origin ? [null] : [plan.origin]), ...stops, ...(plan.end ? [plan.end] : [])];
  const walking = plan.legs.every((l) => !l || l.mode === 'foot');
  const transit = plan.legs.some((l) => l?.mode === 'transit');
  const segs = [];
  let i = 0;
  while (i < pts.length - 1) {
    // Google Maps 的公交导航不能带途经点：每一站一段
    const chunk = pts.slice(i, i + (transit ? 2 : NAV_WAYPOINTS + 2));
    const from = chunk[0];
    const to = chunk[chunk.length - 1];
    const via = chunk.slice(1, -1);
    const params = new URLSearchParams({ api: '1', destination: ll(to), travelmode: transit ? 'transit' : walking ? 'walking' : 'driving' });
    if (from) params.set('origin', ll(from));
    if (via.length) params.set('waypoints', via.map(ll).join('|'));
    segs.push({ from: from ? from.name : '我的位置', to: to.name, count: chunk.length - 1, url: `https://www.google.com/maps/dir/?${params}` });
    i += chunk.length - 1;
  }
  return segs;
}

function openNavAll() {
  if (!state.navApp) return askNavApp(openNavAll);
  // Waze / Apple 地图不能一次带很多站：导航到下一站
  if (state.navApp !== 'google') {
    const t = T();
    const id = t.plan?.order.find((x) => stopInfoMap().has(x));
    const p = id && t.places.find((x) => x.id === id);
    if (!p) return toast('这天没有要去的地方');
    toast(`${NAV_APPS[state.navApp]} 一次导航一站：先去「${p.name.split(' ')[0]}」`, 3000);
    return openNav(p);
  }
  const segs = navSegments();
  if (!segs.length) return toast('这天没有要去的地方');
  if (segs.length === 1) return window.open(segs[0].url, '_blank');
  $('#navSegs').innerHTML = segs
    .map((s, i) => `<a class="nav-seg" href="${esc(s.url)}" target="_blank" rel="noopener">
      <span class="ns-num">${i + 1}</span>
      <div class="ns-main"><b>${esc(s.from)} → ${esc(s.to)}</b><span>${s.count} 站</span></div>${ic('chevron', 18)}</a>`)
    .join('');
  $('#navDialog').showModal();
}
$('#navSegs').addEventListener('click', (e) => {
  const a = e.target.closest('.nav-seg');
  if (a) a.classList.add('opened');
});
$('#navClose').addEventListener('click', () => $('#navDialog').close());

/* ================= 天气（Open-Meteo，免费、不用申请） ================= */

const WX_KEY = 'shunlu:wx:v1';
const WX_TTL = 3 * 3600e3;
let wxCache = (() => {
  try {
    return JSON.parse(localStorage.getItem(WX_KEY)) || {};
  } catch {
    return {};
  }
})();
const wxLoading = {};

// 天气代码 → 图标和中文
function wxInfo(code) {
  if (code === 0) return { icon: 'sun', text: '晴' };
  if (code <= 3) return { icon: 'cloud', text: '多云' };
  if (code <= 48) return { icon: 'cloud', text: '有雾' };
  if (code <= 67 || (code >= 80 && code <= 82)) return { icon: 'rain', text: code >= 80 ? '阵雨' : '下雨' };
  if (code <= 77 || code === 85 || code === 86) return { icon: 'cloud', text: '下雪' };
  return { icon: 'storm', text: '雷雨' };
}

function wxPoint(t) {
  return t.dest || t.home || t.places[0] || null;
}

// 拿行程那几天的天气（存 3 小时）；拿到后重画画面
function loadWeather(t) {
  const p = wxPoint(t);
  if (!p) return Promise.resolve(null);
  const key = `${p.lat.toFixed(2)},${p.lon.toFixed(2)}`;
  const c = wxCache[key];
  if (c && Date.now() - c.at < WX_TTL) return Promise.resolve(c.days);
  if (wxLoading[key]) return wxLoading[key];
  const params = new URLSearchParams({
    latitude: p.lat.toFixed(3), longitude: p.lon.toFixed(3), timezone: 'auto', forecast_days: '16',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum',
  });
  wxLoading[key] = fetch(`https://api.open-meteo.com/v1/forecast?${params}`)
    .then((r) => r.json())
    .then((data) => {
      const d = data.daily;
      const days = {};
      d.time.forEach((date, i) => {
        days[date] = { code: d.weather_code[i], tmax: d.temperature_2m_max[i], tmin: d.temperature_2m_min[i], prob: d.precipitation_probability_max[i], mm: d.precipitation_sum[i] };
      });
      wxCache[key] = { at: Date.now(), days };
      try {
        localStorage.setItem(WX_KEY, JSON.stringify(wxCache));
      } catch {}
      if (currentView === 'map' && T() === t) renderMap();
      return days;
    })
    .catch(() => null)
    .finally(() => delete wxLoading[key]);
  return wxLoading[key];
}

// 某一天的天气；还没拿到或太远（超过 16 天）就是 null
function weatherOn(t, day) {
  const p = wxPoint(t);
  if (!p) return null;
  const c = wxCache[`${p.lat.toFixed(2)},${p.lon.toFixed(2)}`];
  if (!c) return null;
  const x = day ? dayDate(t, day) : new Date(t.plan?.startTime || Date.now());
  const date = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return c.days[date] || null;
}

const rainy = (w) => w && w.prob >= 60 && w.mm >= 5;

function wxChip(w) {
  if (!w) return '';
  const info = wxInfo(w.code);
  return `<span class="wx-chip ${rainy(w) ? 'wet' : ''}">${ic(info.icon, 14)} ${info.text} ${Math.round(w.tmax)}°/${Math.round(w.tmin)}°${w.prob >= 30 ? ` · 雨 ${w.prob}%` : ''}</span>`;
}

// 户外景点（下雨会影响的）
const OUTDOOR_KIND = /park|garden|beach|nature|reserve|viewpoint|zoo|theme_park|water_park|mountain|hill|peak|waterfall|marketplace|jetty|island|trail|botanical|protected_area/;
// 只用明确的字眼（「龙山堂」这种名字里的「山」不算）
const OUTDOOR_NAME = /公园|海滩|沙滩|夜市|植物园|瀑布|升旗山|壁画街|national park|beach|\bhill\b|garden|night market|jetty|waterfall/i;
const isOutdoor = (p) => OUTDOOR_KIND.test(`${p.kind || ''} ${p.type || ''}`.toLowerCase()) || OUTDOOR_NAME.test(p.name || '');

// 下雨提醒：这天雨大、又有户外景点 → 建议换到雨小的那天；每天都下雨 → 建议早上去
function rainAdvice(t, day, places) {
  const w = weatherOn(t, day);
  if (!rainy(w)) return '';
  const out = places.filter((p) => !p.done && isOutdoor(p));
  if (!out.length) return '';
  let better = null;
  if (isMulti(t)) {
    for (let d = 1; d <= t.days; d++) {
      const x = weatherOn(t, d);
      if (d !== day && x && x.mm + 5 <= w.mm && (!better || x.mm < better.w.mm)) better = { d, w: x };
    }
  }
  const names = out.slice(0, 3).map((p) => p.name.split(' ')[0]).join('、') + (out.length > 3 ? ' 等' : '');
  return better
    ? `可能下大雨（约 ${Math.round(w.mm)} 毫米）：户外的 ${esc(names)} 可以换到第 ${better.d} 天（约 ${Math.round(better.w.mm)} 毫米）`
    : `可能下雨（约 ${Math.round(w.mm)} 毫米）：户外的 ${esc(names)} 建议早上去，带伞`;
}

/* ================= 日出日落、拍照黄金时段（自己算，不用网络） ================= */

// 天文公式：某一天、某个位置的日出、日落，和太阳只剩 6° 高的时间（黄金时段开始）
function sunTimes(dayMs, lat, lon) {
  const rad = Math.PI / 180;
  const toJ = (ms) => ms / 864e5 + 2440587.5;
  const fromJ = (j) => (j - 2440587.5) * 864e5;
  const n = Math.round(toJ(dayMs) - 2451545 - 0.0009 + lon / 360);
  const js = n - lon / 360 + 0.0009;
  const M = (357.5291 + 0.98560028 * js) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360;
  const jt = 2451545 + js + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const dec = Math.asin(Math.sin(L * rad) * Math.sin(23.4397 * rad));
  const w = (h) => {
    const c = (Math.sin(h * rad) - Math.sin(lat * rad) * Math.sin(dec)) / (Math.cos(lat * rad) * Math.cos(dec));
    return c < -1 || c > 1 ? null : Math.acos(c) / rad;
  };
  const w0 = w(-0.833);
  const w6 = w(6);
  if (w0 == null || w6 == null) return null; // 极地：不显示
  return { rise: fromJ(jt - w0 / 360), set: fromJ(jt + w0 / 360), gold: fromJ(jt + w6 / 360) };
}

function sunForPlan(t, plan) {
  if (!plan) return null;
  const first = plan.stops?.[0] ? t.places.find((x) => x.id === plan.stops[0].id) : null;
  const pt = first || plan.origin || t.dest || t.places[0];
  if (!pt) return null;
  const noon = new Date(plan.startTime);
  noon.setHours(12, 0, 0, 0);
  return sunTimes(noon.getTime(), pt.lat, pt.lon);
}
function sunMini(t, plan) {
  const sun = sunForPlan(t, plan);
  return sun ? ` <span class="sun-mini">${ic('sunset', 12)} 日落 ${fmtClock(sun.set)}</span>` : '';
}

// 适合拍照 / 看日落的地方
// 「山」只算真的山：龙山堂、山寺这种名字不算
const PHOTO_SPOT = /viewpoint|beach|peak|hill|mountain|jetty|pier|bridge|tower|lighthouse|bay\b|(?<!龙)山(?!堂|寺|庙|公司|会馆|门)|海滩|海边|沙滩|桥|观景|日落|码头|灯塔|塔/i;
const isPhotoSpot = (p) => PHOTO_SPOT.test(`${p.kind || ''} ${p.type || ''} ${p.name || ''}`);

function sunChip(p, st, sun) {
  if (!sun || !isPhotoSpot(p) || st.flag === 'closed') return '';
  const range = `${fmtClock(sun.gold)}–${fmtClock(sun.set)}`;
  if (st.start < sun.set && st.depart > sun.gold) return `<span class="chip gold-chip">${ic('sunset', 12)} 刚好黄金时段 ${range}</span>`;
  return `<span class="chip sun-chip">${ic('sunset', 12)} 拍照最美 ${range}</span>`;
}

/* ================= 每一天的时间条：开车、走路、逛景点各花多少时间 ================= */

function dayStats(plan) {
  const r = { car: 0, carMs: 0, foot: 0, footMs: 0, transitMs: 0 };
  for (const l of plan?.legs || []) {
    if (!l) continue;
    for (const x of l.parts || [l]) {
      if (x.mode === 'car' || (x.mode === 'transit' && l.noTransit)) {
        r.car += x.dist || 0;
        r.carMs += x.dur || 0;
      } else if (x.mode === 'foot') {
        r.foot += x.dist || 0;
        r.footMs += x.dur || 0;
      } else r.transitMs += x.dur || 0;
    }
  }
  return r;
}

const BAR_NAME = { car: '开车', foot: '走路', bus: '巴士', train: '地铁火车', visit: '逛', wait: '等开门' };
function dayBarHtml(t, plan, compact = false) {
  if (!plan?.stops?.length) return '';
  const t0 = plan.startTime;
  const t1 = plan.endArrive ?? plan.finish;
  if (!(t1 > t0)) return '';
  const segs = [];
  // 一段路：按每一小段（走回停车处 / 开车 / 走过去）的时间比例切开
  const legSegs = (l, a, b) => {
    if (!l || b <= a) return;
    const parts = l.parts || [l];
    const tot = parts.reduce((x, y) => x + (y.dur || 0), 0) || 1;
    for (const x of parts) {
      const k = x === l ? legKind(l) : x.mode === 'car' ? 'car' : 'foot';
      segs.push({ k, ms: ((b - a) * (x.dur || 0)) / tot });
    }
  };
  let prev = t0;
  plan.stops.forEach((st, i) => {
    legSegs(plan.legs[i], prev, st.arrive);
    if (st.start > st.arrive) segs.push({ k: 'wait', ms: st.start - st.arrive });
    if (st.flag !== 'closed') segs.push({ k: 'visit', ms: st.depart - st.start, id: st.id });
    prev = Math.max(st.depart, st.arrive);
  });
  if (plan.end) legSegs(plan.legs[plan.legs.length - 1], prev, t1);
  const track = segs
    .filter((x) => x.ms > 0)
    .map((x) => `<i class="db-${x.k}" style="flex-grow:${Math.max(1, Math.round(x.ms / 60e3))}"${x.id ? ` data-barid="${x.id}"` : ''} title="${BAR_NAME[x.k]} ${fmtDur(x.ms)}"></i>`)
    .join('');
  const s = dayStats(plan);
  const stats = [
    s.car > 50 ? `<span class="s-car">${modeIcon('car', 13)} 开车 ${fmtDist(s.car)} · ${fmtDur(s.carMs)}</span>` : '',
    s.foot > 50 ? `<span class="s-foot">${modeIcon('foot', 13)} 走路 ${fmtDist(s.foot)} ≈ ${Math.round(s.foot / 0.72).toLocaleString('en')} 步</span>` : '',
    s.transitMs > 0 ? `<span class="s-bus">${modeIcon('bus', 13)} 公交 ${fmtDur(s.transitMs)}</span>` : '',
  ].filter(Boolean).join('');
  return `<div class="daybar${compact ? ' compact' : ''}">
    <div class="db-track">${track}</div>
    ${compact ? '' : `<div class="db-scale"><span>${fmtClock(t0)} 出发</span><span class="db-legend"><i class="db-visit"></i>逛 <i class="db-car"></i>开车 <i class="db-foot"></i>走路</span><span>${fmtClock(t1)} ${plan.end ? '回到住处' : '结束'}</span></div>`}
    ${stats ? `<div class="db-stats">${stats}</div>` : ''}
  </div>`;
}

/* ---- 换酒店那天：退房、入住时间（只是提醒，不硬性排） ---- */

const hmOn = (ms, hm) => {
  const [h, m] = hm.split(':').map(Number);
  const d = new Date(ms);
  d.setHours(h, m, 0, 0);
  return d.getTime();
};
function hotelTips(t, plan) {
  const out = {};
  if (!isMulti(t) || !t.curDay || !plan) return out;
  const d = t.curDay;
  const a = startHotel(t, d);
  const b = endHotel(t, d);
  // 今天要离开原本的酒店（换酒店、或最后一天）
  if (a && d > 1 && (!b || !sameHotel(a, b))) {
    const co = hmOn(plan.startTime, checkOutOf(a));
    out.out = plan.startTime > co
      ? `<em class="hotel-tip warn">${ic('alert', 12)} ${esc(checkOutOf(a))} 要退房，但 ${fmtClock(plan.startTime)} 才出发：记得先退房（行李放车上）</em>`
      : `<em class="hotel-tip">${ic('bed', 12)} 今天退房 · ${esc(checkOutOf(a))} 前（行李带上车）</em>`;
  }
  // 今晚住新的酒店（第一天，或换酒店）
  if (b && plan.end && (d === 1 || !a || !sameHotel(a, b))) {
    const ci = hmOn(plan.startTime, checkInOf(b));
    const arrive = plan.endArrive ?? plan.finish;
    out.in = arrive < ci
      ? `<em class="hotel-tip warn">${ic('clock', 12)} ${esc(checkInOf(b))} 才能入住（约 ${fmtClock(arrive)} 到）：可以先寄放行李，或多逛一下</em>`
      : `<em class="hotel-tip ok">${ic('check', 12)} ${esc(checkInOf(b))} 起可以入住 ✓</em>`;
  }
  return out;
}

/* ---- 关门 / 休息的地方：告诉你哪一天有开，一键换过去 ---- */

function openDaysFor(t, p) {
  if (!isMulti(t)) return [];
  const out = [];
  for (let d = 1; d <= t.days; d++) {
    if (d === p.day) continue;
    const h = placeHoursOn(p, dayDate(t, d));
    if (h.known && h.windows.length) out.push(d);
  }
  return out;
}
function moveDayBtns(t, p) {
  const ds = openDaysFor(t, p).slice(0, 3);
  if (!ds.length) return '';
  return `<div class="move-days">${ds.map((d) => `<button type="button" data-act="moveday" data-day="${d}" style="--dc:${dayColor(d)}">换到第 ${d} 天（${esc(fmtDay(t, d))} 有开）</button>`).join('')}</div>`;
}
function movePlaceToDay(p, d) {
  const t = T();
  const old = p.day;
  p.day = d;
  p.dayLocked = true;
  delete t.dayPlans[old];
  delete t.dayPlans[d];
  Object.values(t.manualOrders || {}).forEach((arr) => arr.includes(p.id) && arr.splice(arr.indexOf(p.id), 1));
  if (t.curDay) t.plan = t.dayPlans[t.curDay] || null;
  save();
  renderMap();
  toast(`「${shortName(p)}」换到第 ${d} 天，重新排路线`);
  replan();
}

/* ================= 到达 / 离开景点的提醒（只在今天的行程、App 开着时） ================= */

const ARRIVE_M = 120; // 走进这个距离 = 到了
const LEAVE_M = 350; // 离开这么远 = 走了
const MIN_STAY = 5 * 60e3; // 至少待 5 分钟才算去过
let watchId = null;
const visitState = { at: null, since: 0, asked: new Set() };

// 现在是不是「行程进行中」：看今天那一天（或单日行程是今天）
function isLiveNow(t) {
  if (!t?.plan?.stops.length || currentView !== 'map' || document.visibilityState !== 'visible') return false;
  if (startOfDay(t.plan.startTime) !== startOfDay(Date.now())) return false;
  return !isMulti(t) || (t.curDay && t.curDay === todayDay(t));
}

// 开始 / 停止追踪位置（在画地图页时顺便检查）
function updateGeoWatch() {
  const live = isLiveNow(T());
  if (live && watchId == null && navigator.geolocation) {
    watchId = navigator.geolocation.watchPosition(onPosition, () => {}, { enableHighAccuracy: true, maximumAge: 20e3, timeout: 30e3 });
  } else if (!live && watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function onPosition(pos) {
  const t = T();
  if (!isLiveNow(t)) return;
  const me = { lat: pos.coords.latitude, lon: pos.coords.longitude, at: Date.now() };
  lastGps = me;
  showMe(me);
  if (pos.coords.accuracy > 150) return; // 定位太不准就先不判断
  maybeParkReminder(me);
  const stops = t.plan.stops.map((s) => t.places.find((p) => p.id === s.id)).filter((p) => p && !p.done);
  const near = stops
    .map((p) => ({ p, d: haversine(me, p) }))
    .filter((x) => x.d <= ARRIVE_M)
    .sort((a, b) => a.d - b.d)[0]?.p;
  if (near && visitState.at !== near.id) {
    visitState.at = near.id;
    visitState.since = Date.now();
    toast(`到了「${near.name}」`);
    return;
  }
  if (!near && visitState.at) {
    const p = t.places.find((x) => x.id === visitState.at);
    if (!p || p.done) {
      visitState.at = null;
      return;
    }
    if (haversine(me, p) > LEAVE_M) {
      const stayed = Date.now() - visitState.since >= MIN_STAY;
      visitState.at = null;
      if (stayed && !visitState.asked.has(p.id)) {
        visitState.asked.add(p.id);
        askLeft(p);
      }
    }
  }
}

let leftPlace = null;
function askLeft(p) {
  leftPlace = p;
  $('#gpText').textContent = `刚离开「${p.name}」，标记为去过了吗？`;
  $('#geoPrompt').hidden = false;
}
$('#gpYes').addEventListener('click', () => {
  $('#geoPrompt').hidden = true;
  if (leftPlace && !leftPlace.done) markDone(leftPlace.id, true);
  leftPlace = null;
});
$('#gpNo').addEventListener('click', () => {
  $('#geoPrompt').hidden = true;
  leftPlace = null;
});

/* ================= 分享行程（整个行程压缩后放在网址里，不用服务器） ================= */

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function packText(text) {
  const bytes = new TextEncoder().encode(text);
  if (!window.CompressionStream) return `0${b64url(bytes)}`;
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  return `1${b64url(new Uint8Array(out))}`;
}
async function unpackText(code) {
  const bytes = unb64url(code.slice(1));
  if (code[0] === '0') return new TextDecoder().decode(bytes);
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  return new TextDecoder().decode(out);
}

// 只放需要的资料（不放算好的路线、照片网址），网址才不会太长
function tripToShare(t) {
  const pt = (h) => h && { name: h.name, address: h.address || '', lat: +h.lat.toFixed(5), lon: +h.lon.toFixed(5) };
  return {
    v: 1,
    name: t.name,
    dest: t.dest,
    days: t.days,
    startDate: t.startDate,
    home: pt(t.home),
    stays: (t.stays || []).map((s) => ({ from: s.from, hotel: pt(s.hotel) })),
    settings: t.settings,
    places: t.places.map((p) => ({
      name: p.name, en: p.en || undefined, lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), stayMin: p.stayMin,
      hoursRaw: p.hoursRaw || undefined, manual: p.manual || undefined, day: p.day || undefined, dayLocked: p.dayLocked || undefined,
      wikidata: p.wikidata || undefined, osm: p.osm || undefined, kind: p.kind || undefined, type: p.type || undefined, note: p.note || undefined,
      ticket: p.ticket ?? undefined,
    })),
  };
}

$('#btnShare').addEventListener('click', async () => {
  const t = T();
  try {
    const code = await packText(JSON.stringify(tripToShare(t)));
    const url = `${location.origin}${location.pathname}#share=${code}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `顺路行程：${t.name}`, text: `${t.name}（${t.days > 1 ? `${t.days} 天，` : ''}${t.places.length} 个地点）`, url });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const ok = await copyText(url);
    toast(ok ? '分享链接已复制，贴给朋友就可以' : '复制失败', 3500);
  } catch (e) {
    toast(`分享失败：${e.message}`);
  }
});

// 打开别人分享的链接：问要不要加进自己的行程
let sharedTrip = null;
async function checkSharedLink() {
  const m = /#share=([\w-]+)/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const data = JSON.parse(await unpackText(m[1]));
    if (!Array.isArray(data.places)) throw new Error('格式不对');
    sharedTrip = data;
    $('#siTitle').textContent = `朋友分享了「${data.name}」`;
    $('#siSub').textContent = `${data.dest?.name ? `${data.dest.name} · ` : ''}${data.days > 1 ? `${data.days} 天 · ` : ''}${data.places.length} 个地点${data.home ? ` · 住 ${data.home.name}` : ''}`;
    $('#siList').innerHTML = data.places.slice(0, 8).map((p) => `<div class="si-row">${ic('pin', 14)} ${esc(p.name)}</div>`).join('') +
      (data.places.length > 8 ? `<div class="si-row muted">…还有 ${data.places.length - 8} 个</div>` : '');
    $('#shareInDialog').showModal();
  } catch (e) {
    toast(`分享链接打不开：${e.message}`, 3500);
  }
}
$('#siNo').addEventListener('click', () => $('#shareInDialog').close());
$('#siYes').addEventListener('click', () => {
  const d = sharedTrip;
  const t = newTrip(d.name);
  Object.assign(t, {
    dest: d.dest || null,
    days: d.days || 1,
    startDate: d.startDate || todayStr(),
    home: d.home || null,
    stays: d.stays || [],
    settings: { ...defaultSettings(), ...d.settings },
    places: d.places.map((p) => ({ ...makePlaceShared(p) })),
  });
  state.trips.push(t);
  state.currentId = t.id;
  save();
  $('#shareInDialog').close();
  toast(`已加入「${t.name}」`);
  openTrip(t.id);
});
function makePlaceShared(p) {
  return { id: uid(), address: '', manual: null, note: '', done: false, needsDetails: !p.hoursRaw, ...p };
}

/* ================= 门票和花费 ================= */

const EXP_CATS = [
  { id: 'ticket', label: '门票' },
  { id: 'food', label: '吃饭' },
  { id: 'transport', label: '交通' },
  { id: 'hotel', label: '住宿' },
  { id: 'shopping', label: '购物' },
  { id: 'other', label: '其他' },
];
// 按国家猜货币符号（可以自己改）
function guessCurrency(t) {
  const c = `${t.dest?.sub || ''}${t.dest?.name || ''}`;
  if (/马来西亚|Malaysia/.test(c)) return 'RM';
  if (/新加坡|Singapore/.test(c)) return 'S$';
  if (/泰国|Thailand/.test(c)) return '฿';
  if (/日本|Japan/.test(c)) return '¥';
  if (/韩国|Korea/.test(c)) return '₩';
  if (/台湾|Taiwan/.test(c)) return 'NT$';
  if (/香港|Hong Kong/.test(c)) return 'HK$';
  if (/中国|China/.test(c)) return '¥';
  return '';
}
const cur = (t) => t.currency ?? guessCurrency(t);
const money = (t, n) => `${cur(t)} ${Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`.trim();

// 门票的说明文字（详情页、编辑页用）
function ticketText(t, p) {
  if (p.ticket != null && p.ticket !== '') return Number(p.ticket) === 0 ? '免费（你填的）' : `每人 ${money(t, p.ticket)}（你填的）`;
  if (p.fee === 'no') return '免费（地图资料）';
  if (p.fee === 'yes') return `要收费${p.charge ? `（${p.charge}）` : ''}（地图资料，价格请自己填）`;
  if (p.charge) return `${p.charge}（地图资料）`;
  return '';
}
// 某天（或整个行程）预计门票：每人票价 × 人数
function ticketTotal(t, day = null) {
  const people = t.people || 1;
  return t.places.filter((p) => day == null || p.day === day).reduce((a, p) => a + (Number(p.ticket) || 0), 0) * people;
}

let expDay = 0; // 新增花费时选的天

function openBudget() {
  const t = T();
  t.expenses ||= [];
  $('#bdCurrency').value = cur(t);
  $('#bdPeople').textContent = t.people || 1;
  renderBudget();
  $('#budgetDialog').showModal();
}

function renderBudget() {
  const t = T();
  const N = t.days || 1;
  const spent = t.expenses.reduce((a, e) => a + e.amount, 0);
  const tickets = ticketTotal(t);
  const withPrice = t.places.filter((p) => p.ticket != null && p.ticket !== '').length;
  $('#bdSummary').innerHTML = `
    <div class="bd-stat"><span>已花</span><b>${esc(money(t, spent))}</b></div>
    <div class="bd-stat"><span>预计门票（${t.people || 1} 人）</span><b>${esc(money(t, tickets))}</b><small>${withPrice}/${t.places.length} 个地点有填票价</small></div>`;
  // 按类别
  const byCat = EXP_CATS.map((c) => ({ ...c, sum: t.expenses.filter((e) => e.cat === c.id).reduce((a, e) => a + e.amount, 0) })).filter((c) => c.sum);
  $('#bdCats').innerHTML = byCat.length
    ? byCat.map((c) => `<div class="bd-cat"><span>${c.label}</span><div class="bd-bar"><i style="width:${Math.round((c.sum / spent) * 100)}%"></i></div><b>${esc(money(t, c.sum))}</b></div>`).join('')
    : '';
  // 新增：哪一天
  $('#bdDay').innerHTML = (N > 1 ? Array.from({ length: N }, (_, i) => `<option value="${i + 1}">第 ${i + 1} 天</option>`).join('') : '') + '<option value="0">不分天</option>';
  $('#bdDay').value = String(expDay || (N > 1 ? todayDay(t) || 1 : 0));
  $('#bdCat').innerHTML = EXP_CATS.map((c) => `<option value="${c.id}">${c.label}</option>`).join('');
  // 列表（新的在上面），按天分组
  const groups = new Map();
  [...t.expenses].sort((a, b) => b.at - a.at).forEach((e) => {
    const k = e.day || 0;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  });
  $('#bdList').innerHTML = t.expenses.length
    ? [...groups.entries()]
        .sort((a, b) => (a[0] || 99) - (b[0] || 99))
        .map(([d, es]) => `<div class="bd-group"><div class="bd-gh"><span>${d ? `第 ${d} 天${isMulti(t) ? ` · ${fmtDay(t, d)}` : ''}` : '不分天'}</span><b>${esc(money(t, es.reduce((a, e) => a + e.amount, 0)))}</b></div>
          ${es.map((e) => `<div class="bd-item"><span class="chip">${EXP_CATS.find((c) => c.id === e.cat)?.label || '其他'}</span><span class="bd-title">${esc(e.title || '')}</span><b>${esc(money(t, e.amount))}</b><button type="button" class="pi-del" data-del="${e.id}" aria-label="删除">${ic('x', 15)}</button></div>`).join('')}</div>`)
        .join('')
    : '<div class="smsg">还没有记录。上面填金额，按「记一笔」。</div>';
}

$('#bdAdd').addEventListener('click', () => {
  const t = T();
  const amount = Number($('#bdAmount').value);
  if (!(amount > 0)) return toast('请填金额');
  expDay = Number($('#bdDay').value);
  t.expenses.push({ id: uid(), amount, title: $('#bdTitle').value.trim(), cat: $('#bdCat').value, day: expDay || null, at: Date.now() });
  $('#bdAmount').value = '';
  $('#bdTitle').value = '';
  save();
  renderBudget();
});
$('#bdList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  const t = T();
  t.expenses = t.expenses.filter((x) => x.id !== b.dataset.del);
  save();
  renderBudget();
});
$('#bdCurrency').addEventListener('change', () => {
  T().currency = $('#bdCurrency').value.trim();
  save();
  renderBudget();
});
$('#bdPeopleBox').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pp]');
  if (!b) return;
  const t = T();
  t.people = Math.max(1, Math.min(30, (t.people || 1) + Number(b.dataset.pp)));
  $('#bdPeople').textContent = t.people;
  save();
  renderBudget();
});
$('#bdClose').addEventListener('click', () => {
  $('#budgetDialog').close();
  if (currentView === 'map') renderMap();
});
$('#btnBudget').addEventListener('click', openBudget);

/* ================= 离线地图：把行程范围的地图先存在手机里 ================= */

const MAP_CACHE = 'shunlu-map'; // 跟 sw.js 用同一个名字
const OFF_KEY = 'shunlu:offline:v1';
const TILE_KB = 45; // 每块地图平均大约多大（估计用）
const OFF_ZOOMS = [8, 9, 10, 11, 12, 13, 14];

function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return [x, y];
}

// 行程范围：所有地点和酒店，四周多留一点
function offlineArea(t) {
  const pts = [...t.places, ...allHotels(t)];
  if (!pts.length) return null;
  const m = 0.02;
  return {
    w: Math.min(...pts.map((p) => p.lon)) - m,
    e: Math.max(...pts.map((p) => p.lon)) + m,
    s: Math.min(...pts.map((p) => p.lat)) - m,
    n: Math.max(...pts.map((p) => p.lat)) + m,
  };
}

function offlineTiles(a) {
  const list = [];
  for (const z of OFF_ZOOMS) {
    const [x0, y0] = tileXY(a.n, a.w, z);
    const [x1, y1] = tileXY(a.s, a.e, z);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) list.push([z, x, y]);
  }
  return list;
}

const offState = () => {
  try {
    return JSON.parse(localStorage.getItem(OFF_KEY)) || {};
  } catch {
    return {};
  }
};

let offBusy = false;
function openOffline() {
  const t = T();
  const a = offlineArea(t);
  const n = a ? offlineTiles(a).length : 0;
  const done = offState()[t.id];
  $('#ofInfo').innerHTML = a
    ? `范围：这个行程的 ${t.places.length} 个地点和住宿附近<br>大约 <b>${n}</b> 块地图，约 <b>${Math.max(1, Math.round((n * TILE_KB) / 1024))} MB</b>（建议连 Wi-Fi 下载）`
    : '还没有地点。';
  $('#ofStatus').textContent = done ? `已经下载过（${fmtDate(done.at)} ${fmtClock(done.at)}，${done.ok} 个文件）。地点有变的话可以再下载一次。` : '';
  $('#ofBar').hidden = true;
  $('#ofGo').disabled = !a || offBusy;
  $('#ofGo').textContent = done ? '重新下载' : '下载离线地图';
  $('#offlineDialog').showModal();
}

async function downloadOffline() {
  const t = T();
  const a = offlineArea(t);
  if (!a || offBusy) return;
  offBusy = true;
  $('#ofGo').disabled = true;
  $('#ofBar').hidden = false;
  const cache = await caches.open(MAP_CACHE);
  let ok = 0;
  let fail = 0;
  try {
    // 地图样式、图标、字体（常用的几段）也一起存
    const style = await (await fetch('https://tiles.openfreemap.org/styles/liberty')).json();
    const tilejson = await (await fetch(style.sources.openmaptiles.url)).json();
    const tpl = tilejson.tiles[0];
    const extra = [
      'https://tiles.openfreemap.org/styles/liberty',
      style.sources.openmaptiles.url,
      `${style.sprite}.json`, `${style.sprite}.png`, `${style.sprite}@2x.json`, `${style.sprite}@2x.png`,
      ...['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'].flatMap((f) =>
        ['0-255', '256-511', '512-767', '768-1023', '8192-8447'].map((r) => style.glyphs.replace('{fontstack}', encodeURIComponent(f)).replace('{range}', r))),
    ];
    const urls = [...extra, ...offlineTiles(a).map(([z, x, y]) => tpl.replace('{z}', z).replace('{x}', x).replace('{y}', y))];
    let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const url = urls[i++];
        try {
          if (!(await cache.match(url))) {
            const res = await fetch(url);
            if (!res.ok) throw new Error(res.status);
            await cache.put(url, res);
          }
          ok++;
        } catch {
          fail++;
        }
        const pct = Math.round(((ok + fail) / urls.length) * 100);
        $('#ofBar i').style.width = `${pct}%`;
        $('#ofStatus').textContent = `下载中… ${pct}%（${ok + fail}/${urls.length}）`;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const st = offState();
    st[t.id] = { at: Date.now(), ok, fail };
    localStorage.setItem(OFF_KEY, JSON.stringify(st));
    $('#ofStatus').textContent = fail ? `完成：${ok} 个文件，${fail} 个失败（可以再按一次补下载）` : `完成！${ok} 个地图文件已经存在手机里，没网络也能看。`;
  } catch (e) {
    $('#ofStatus').textContent = `下载失败：${e.message}，请检查网络`;
  } finally {
    offBusy = false;
    $('#ofGo').disabled = false;
    $('#ofGo').textContent = '重新下载';
  }
}

$('#ofGo').addEventListener('click', downloadOffline);
$('#ofDel').addEventListener('click', async () => {
  await caches.delete(MAP_CACHE);
  localStorage.removeItem(OFF_KEY);
  $('#ofStatus').textContent = '已删除离线地图。';
  $('#ofGo').textContent = '下载离线地图';
});
$('#ofClose').addEventListener('click', () => $('#offlineDialog').close());
$('#btnOffline').addEventListener('click', openOffline);

/* ================= 导航 App：Google Maps / Waze / Apple 地图 ================= */

const NAV_APPS = { google: 'Google Maps', waze: 'Waze', apple: 'Apple 地图' };

function navUrl(target, mode, app) {
  const ll = `${target.lat.toFixed(6)},${target.lon.toFixed(6)}`;
  if (app === 'waze') return `https://waze.com/ul?ll=${ll}&navigate=yes`;
  if (app === 'apple') return `https://maps.apple.com/?daddr=${ll}&dirflg=${mode === 'walking' ? 'w' : mode === 'transit' ? 'r' : 'd'}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=${mode}`;
}

// 用你选的导航 App 打开；第一次会问用哪个
function goNav(target, mode = 'driving') {
  const app = state.navApp;
  if (!app) return askNavApp(() => goNav(target, mode));
  // Waze 只能开车：走路 / 公交那段改用 Google Maps
  const use = app === 'waze' && mode !== 'driving' ? 'google' : app;
  if (use !== app) toast('Waze 不支持走路和公交，这段用 Google Maps', 3000);
  window.open(navUrl(target, mode, use), '_blank');
}

let navAppAfter = null;
function askNavApp(after = null) {
  navAppAfter = after;
  $('#naList').innerHTML = Object.entries(NAV_APPS)
    .map(([k, v]) => `<button type="button" data-app="${k}" class="${state.navApp === k ? 'on' : ''}">${esc(v)}${k === 'waze' ? '<span>只能开车；一次导航到一站</span>' : k === 'apple' ? '<span>iPhone 自带</span>' : '<span>开车、走路、公交都可以</span>'}</button>`)
    .join('');
  $('#navAppDialog').showModal();
}
$('#naList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-app]');
  if (!b) return;
  state.navApp = b.dataset.app;
  save();
  $('#navAppDialog').close();
  toast(`导航改用 ${NAV_APPS[state.navApp]}`);
  if (currentView === 'map') renderMap();
  const after = navAppAfter;
  navAppAfter = null;
  after?.();
});
$('#naClose').addEventListener('click', () => $('#navAppDialog').close());
$('#btnNavApp').addEventListener('click', () => askNavApp());

/* ================= 停车场：只自动显示「下一站」的，其他按了才找 ================= */

const parkCache = new Map(); // 停车目标（坐标）→ 停车场列表
const parkOpen = new Set(); // 打开了停车场列表的地点 id

// 车要停在哪里：「开车到停车处再走过去」就是那个停车处，不然就是景点本身
function parkTarget(id) {
  const t = T();
  const p = t.places.find((x) => x.id === id);
  const l = stopInfoMap().get(id)?.legIn;
  const car = l?.parts?.find((x) => x.mode === 'car');
  const to = car && l.parts.at(-1).mode === 'foot' ? car.to : p;
  return { key: `${to.lat.toFixed(5)},${to.lon.toFixed(5)}`, name: to.name || p.name, lat: to.lat, lon: to.lon, other: to !== p };
}

// 附近 600 米内的停车场，按「停好车走到那里」的真实走路时间排
async function parkingNear(p) {
  if (parkCache.has(p.key)) return parkCache.get(p.key);
  const params = new URLSearchParams({ lat: p.lat.toFixed(6), lon: p.lon.toFixed(6), limit: '25', radius: '0.6' });
  params.append('osm_tag', 'amenity:parking');
  params.append('osm_tag', 'amenity:parking_entrance');
  let list = [];
  try {
    const data = await fetch(`https://photon.komoot.io/reverse?${params}`).then((r) => r.json());
    for (const f of data.features) {
      const q = f.properties;
      const it = { name: q.name || (q.osm_value === 'parking_entrance' ? '停车场入口' : '停车场'), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], street: q.street || '' };
      // 同一个停车场常有好几个点（入口、范围），太近的只留一个
      if (!list.some((x) => haversine(x, it) < 40)) list.push(it);
    }
    const rows = await travelRow('foot', p, list).catch(() => []);
    list.forEach((x, i) => (x.walk = rows[i] ? rows[i].dur : null));
    list = list.filter((x) => x.walk == null || x.walk < 15 * 60e3).sort((a, b) => (a.walk ?? 1e9) - (b.walk ?? 1e9)).slice(0, 4);
  } catch {
    list = null;
  }
  parkCache.set(p.key, list);
  return list;
}

function parkListHtml(p, list) {
  if (list == null) return '<div class="pk-msg">找不到停车场资料（网络问题），等一下再试</div>';
  if (!list.length) return '<div class="pk-msg">地图资料里附近 600 米没有停车场，可能要找路边停车</div>';
  return list
    .map((x, i) => `<div class="pk-row"><span class="pk-p">P</span><div class="pk-main"><b>${esc(x.name)}</b><span>${x.walk != null ? `停好车走 ${fmtDur(x.walk)}` : ''}${x.street ? ` · ${esc(x.street)}` : ''}</span></div>
      <button type="button" data-parknav="${p.key}|${i}">${ic('nav', 14)} 导航</button></div>`)
    .join('');
}

// 列表里的停车场区块（画完列表后补上）
function hydrateParking() {
  const t = T();
  document.querySelectorAll('[data-parkfor]').forEach(async (el) => {
    if (!t.places.some((x) => x.id === el.dataset.parkfor)) return;
    const target = parkTarget(el.dataset.parkfor);
    const list = await parkingNear(target);
    if (!el.isConnected) return;
    const head = target.other ? `车停在「${esc(target.name.split(' ')[0])}」附近，再走过来；那边的停车场` : '附近停车场';
    el.innerHTML = `<div class="pk-head">${ic('car', 14)} ${head}</div>${parkListHtml(target, list)}`;
    if (map && list?.length) drawParkMarkers();
  });
}

// 地图上只画打开了的停车场
let parkMarkers = [];
function drawParkMarkers() {
  parkMarkers.forEach((m) => m.remove());
  parkMarkers = [];
  for (const id of visibleParkIds()) {
    if (!stopInfoMap().has(id)) continue;
    for (const x of parkCache.get(parkTarget(id).key) || []) {
      const el = document.createElement('div');
      el.className = 'park-marker';
      el.textContent = 'P';
      el.title = x.name;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        toast(`${x.name}${x.walk != null ? `：停好车走 ${fmtDur(x.walk)}` : ''}`);
      });
      parkMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([x.lon, x.lat]).addTo(map));
    }
  }
}

// 下一站（开车去的）自动显示；其他按了才显示
function nextCarStopId() {
  const t = T();
  const info = stopInfoMap();
  const id = t.plan?.order.find((x) => info.has(x));
  return id && legKind(info.get(id).legIn) === 'car' ? id : null;
}
function visibleParkIds() {
  const ids = new Set(parkOpen);
  const n = nextCarStopId();
  if (n) ids.add(n);
  return ids;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-parknav]');
  if (!b) return;
  const [key, i] = b.dataset.parknav.split('|');
  const x = parkCache.get(key)?.[Number(i)];
  if (x) goNav(x, 'driving');
});

/* ---- 快到下一站时，提醒停车场（行程当天、App 开着时） ---- */
const parkReminded = new Set();
async function maybeParkReminder(me) {
  const id = nextCarStopId();
  if (!id || parkReminded.has(id)) return;
  const p = parkTarget(id);
  const d = haversine(me, p);
  if (d > 1500 || d < 150) return;
  parkReminded.add(id);
  const list = await parkingNear(p);
  const best = list?.[0];
  const where = p.other ? `停车处「${esc(p.name.split(' ')[0])}」` : `「${esc(p.name.split(' ')[0])}」`;
  $('#ppText').innerHTML = best
    ? `快到${where}了。最近的停车场：<b>${esc(best.name)}</b>${best.walk != null ? `（停好车走 ${fmtDur(best.walk)}）` : ''}`
    : `快到${where}了。地图资料里附近没有停车场，可能要找路边停车。`;
  $('#ppGo').hidden = !best;
  $('#ppGo').dataset.parknav = best ? `${p.key}|0` : '';
  $('#parkPrompt').hidden = false;
  if (follow) {
    speak(best
      ? `快到${shortName(p)}了。最近的停车场是${best.name}${best.walk != null ? `，停好车走${fmtDur(best.walk)}` : ''}`
      : `快到${shortName(p)}了。附近地图上没有停车场，可能要找路边停车`);
  }
}
$('#ppClose').addEventListener('click', () => ($('#parkPrompt').hidden = true));
$('#ppGo').addEventListener('click', () => ($('#parkPrompt').hidden = true));

/* ================= 跟着我走（像地图 App 一样） ================= */

/* ---- 跟随时：屏幕不熄灭 + 语音提醒 ---- */

// 屏幕保持亮着（锁屏后浏览器就拿不到位置）；切出去再回来要重新要
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && follow) keepAwake(true);
});

// 语音：用手机自带的朗读（免费、不用网络）。默认开，HUD 上可以关
const voiceOn = () => state.voice !== false;
function speak(text) {
  if (!voiceOn() || !('speechSynthesis' in window)) return;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    const v = speechSynthesis.getVoices().find((x) => /^zh(-|_)?(CN|Hans)?/i.test(x.lang));
    if (v) u.voice = v;
    u.rate = 1.02;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}
function updateVoiceBtn() {
  $('#fhVoice').innerHTML = ic(voiceOn() ? 'volume' : 'mute', 18);
  $('#fhVoice').classList.toggle('off', !voiceOn());
}
$('#fhVoice').addEventListener('click', () => {
  state.voice = !voiceOn();
  save();
  updateVoiceBtn();
  if (voiceOn()) speak('语音提醒已打开');
  else window.speechSynthesis?.cancel();
  toast(voiceOn() ? '语音提醒：开' : '语音提醒：关');
});
// 「极乐寺 Kek Lok Si」→「极乐寺」；英文名字（Hard Rock Hotel）就整个用
const shortName = (p) => (hasCJK((p?.name || '').split(' ')[0]) ? p.name.split(' ')[0] : p?.name || '');

let follow = null; // { watch, center, last, speed, eta, etaAt, said:Set }
function startFollow() {
  if (!navigator.geolocation) return toast('这个浏览器不支持定位');
  follow = { center: true, last: null, speed: null, eta: '', etaAt: 0, said: new Set() };
  keepAwake(true);
  updateVoiceBtn();
  // 第一次朗读要在按按钮的当下（iPhone 的规定），之后才能自动讲
  const t = T();
  const info = stopInfoMap();
  const nid = t?.plan?.order.find((x) => info.has(x));
  const np = nid && t.places.find((x) => x.id === nid);
  speak(np ? `开始跟着你走。下一站，${shortName(np)}` : '开始跟着你走');
  follow.watch = navigator.geolocation.watchPosition(onFollow, (e) => {
    toast(e.code === 1 ? '没有定位权限' : '拿不到位置');
    stopFollow();
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  $('#btnLocate').classList.add('on');
  $('#followHud').hidden = false;
  $('#fhText').textContent = '正在定位…';
}
function stopFollow() {
  if (follow?.watch != null) navigator.geolocation.clearWatch(follow.watch);
  follow = null;
  keepAwake(false);
  $('#btnLocate').classList.remove('on', 'paused');
  $('#followHud').hidden = true;
}

function onFollow(pos) {
  if (!follow) return;
  const c = pos.coords;
  const me = { lat: c.latitude, lon: c.longitude, at: Date.now(), heading: c.heading };
  // 速度：有就用手机给的，没有就用两次位置算
  let kmh = c.speed != null && c.speed >= 0 ? c.speed * 3.6 : null;
  if (kmh == null && follow.last) {
    const dt = (me.at - follow.last.at) / 1000;
    if (dt > 0.5) kmh = (haversine(follow.last, me) / dt) * 3.6;
  }
  follow.last = me;
  lastGps = me;
  showMe(me);
  if (follow.center && map) map.easeTo({ center: [me.lon, me.lat], zoom: Math.max(map.getZoom(), 15), duration: 600 });
  // 到下一站还要多久：每 45 秒问一次真实路程
  const t = T();
  const info = stopInfoMap();
  const nextId = t?.plan?.order.find((x) => info.has(x));
  const next = nextId && t.places.find((x) => x.id === nextId);
  if (next && Date.now() - follow.etaAt > 45e3) {
    follow.etaAt = Date.now();
    const kind = legKind(info.get(nextId).legIn);
    travelRow(kind === 'foot' ? 'foot' : 'car', me, [next]).then(([r]) => {
      if (!follow || !r) return;
      follow.eta = `到「${shortName(next)}」约 ${fmtDur(r.dur)} · ${fmtDist(r.dist)}`;
      // 每一站只讲一次：要去哪里、多久
      if (!follow.said.has(`go:${next.id}`) && r.dist > 300) {
        follow.said.add(`go:${next.id}`);
        speak(`前往${shortName(next)}，大约${fmtDur(r.dur)}`);
      }
    }).catch(() => {});
  }
  // 快到了：讲一次
  if (next && !follow.said.has(`near:${next.id}`)) {
    const d = haversine(me, next);
    if (d < (legKind(info.get(nextId).legIn) === 'foot' ? 80 : 250)) {
      follow.said.add(`near:${next.id}`);
      follow.said.add(`go:${next.id}`); // 已经快到了，就不用再讲「前往…」
      speak(`快到${shortName(next)}了`);
    }
  }
  $('#fhSpeed').textContent = kmh != null ? Math.round(kmh) : '–';
  $('#fhText').textContent = follow.eta || (next ? `下一站：${next.name.split(' ')[0]}` : '跟着你的位置');
  maybeParkReminder(me);
}

$('#btnLocate').addEventListener('click', () => {
  if (tour) stopTour();
  if (!follow) return startFollow();
  if (!follow.center) {
    // 手动拖过地图：再按一下回到你的位置
    follow.center = true;
    $('#btnLocate').classList.remove('paused');
    if (follow.last) map.easeTo({ center: [follow.last.lon, follow.last.lat], zoom: Math.max(map.getZoom(), 15) });
    return;
  }
  stopFollow();
  toast('已停止跟随');
});
$('#fhStop').addEventListener('click', stopFollow);

/* ================= 调整顺序：按住拖动 ================= */

const buzz = (ms = 12) => {
  try {
    navigator.vibrate?.(ms);
  } catch {}
};
let justMoved = null; // 刚拖过的地点：号码跳一下

// 用新的顺序重算时间（跟 ▲ ▼ 一样）
function applyManualOrder(order) {
  const t = T();
  setManual(t, isMulti(t) ? t.curDay : null, order);
  save();
  if (bundleFits(t)) {
    const idToK = new Map(lastBundle.remaining.map((p, k) => [p.id, k + 1]));
    applyOrder(lastBundle, order.map((x) => idToK.get(x)), true);
  } else replan();
}

(function dragReorder() {
  const list = $('#list');
  let d = null;
  const rowsNow = () => [...list.querySelectorAll('.stop[data-id]:not(.simple)')];
  list.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.drag-h');
    if (!h || !reorderMode) return;
    e.preventDefault();
    const row = h.closest('.stop');
    const rows = rowsNow();
    d = { row, rows, idx: rows.indexOf(row), target: rows.indexOf(row), y0: e.clientY, scroll0: list.scrollTop, lastY: e.clientY };
    row.classList.add('dragging');
    list.classList.add('drag-on');
    try {
      h.setPointerCapture(e.pointerId);
    } catch {}
    buzz();
  });
  const mark = () => {
    d.rows.forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    if (d.target === d.idx) return;
    d.rows[d.target].classList.add(d.target < d.idx ? 'drop-before' : 'drop-after');
  };
  list.addEventListener('pointermove', (e) => {
    if (!d) return;
    d.lastY = e.clientY;
    // 靠近上下边缘：列表自己滚
    const lr = list.getBoundingClientRect();
    if (e.clientY < lr.top + 40) list.scrollTop -= 10;
    else if (e.clientY > lr.bottom - 40) list.scrollTop += 10;
    const dy = e.clientY - d.y0 + (list.scrollTop - d.scroll0);
    d.row.style.transform = `translateY(${dy}px)`;
    // 手指现在在哪一张卡片上
    let target = d.idx;
    d.rows.forEach((r, i) => {
      if (i === d.idx) return;
      const rr = r.getBoundingClientRect();
      const mid = rr.top + rr.height / 2;
      if (i < d.idx && e.clientY < mid) target = Math.min(target, i);
      if (i > d.idx && e.clientY > mid) target = Math.max(target, i);
    });
    if (target !== d.target) {
      d.target = target;
      buzz(6);
    }
    mark();
  });
  const end = () => {
    if (!d) return;
    const { row, rows, idx, target } = d;
    d = null;
    row.classList.remove('dragging');
    row.style.transform = '';
    list.classList.remove('drag-on');
    rows.forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    if (target === idx) return;
    const order = rows.map((r) => r.dataset.id);
    const [id] = order.splice(idx, 1);
    order.splice(target, 0, id);
    // 保留没显示出来的（例如已关门的）在原来的计划里
    const t = T();
    const rest = (t.plan?.order || []).filter((x) => !order.includes(x));
    justMoved = id;
    buzz(18);
    applyManualOrder([...order, ...rest]);
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
})();

/* ================= 地图和列表连动 ================= */

let markerById = new Map(); // 地点 id → 地图上的标记

function highlightMarker(id, pan = false) {
  markerById.forEach((m, k) => m.getElement().classList.toggle('hl', k === id));
  if (!pan || !id || !map) return;
  const m = markerById.get(id);
  if (!m || tour || follow?.center) return;
  // 标记被列表挡住 / 在画面外：轻轻移过去
  const wide = innerWidth >= 900;
  const sheetH = wide ? 0 : $('#sheet').getBoundingClientRect().height;
  const pt = map.project(m.getLngLat());
  const r = map.getContainer().getBoundingClientRect();
  const left = wide ? 400 + 30 : 30;
  if (pt.x > left && pt.x < r.width - 30 && pt.y > 80 && pt.y < r.height - sheetH - 30) return;
  map.easeTo({ center: m.getLngLat(), offset: wide ? [200, 0] : [0, -sheetH / 2 + 20], duration: 500 });
}

(function listFollowsMap() {
  const list = $('#list');
  let raf = 0;
  let idle = 0;
  let cur = null;
  list.addEventListener('scroll', () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if ($('#sheet').dataset.state === 'full' || list.classList.contains('drag-on')) return;
      const top = list.getBoundingClientRect().top + 8;
      const cards = [...list.querySelectorAll('.stop[data-id]:not(.simple), .dc-item[data-id]')];
      const first = cards.find((c) => c.getBoundingClientRect().bottom > top + 30);
      const id = first?.dataset.id || null;
      if (id === cur) return;
      cur = id;
      highlightMarker(id);
      clearTimeout(idle);
      idle = setTimeout(() => highlightMarker(cur, true), 350);
    });
  }, { passive: true });
})();

/* ================= 预览路线：镜头沿着路线一站一站飞过去 ================= */

let tour = null;
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2);
function bearingOf(a, b) {
  const rad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
  const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
const llDist = (a, b) => haversine({ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] });

function startTour() {
  const t = T();
  if (!map || !mapReady) return;
  if (isMulti(t) && !t.curDay) return toast('先选一天（上面的「第 1 天」…），再按 ▶ 预览那天的路线', 3500);
  const plan = t.plan;
  const info = stopInfoMap();
  const stops = (plan?.order || []).filter((id) => info.has(id)).map((id) => t.places.find((x) => x.id === id));
  if (!stops.length) return toast('还没有路线可以预览');
  if (follow) stopFollow();
  // 整条路线的点：有真实路线就用，没有就直线
  const pts = [];
  (plan.lines || []).forEach((l) => l.coords.forEach((c) => pts.push(c)));
  const origin = plan.origin;
  const way = [...(origin ? [origin] : []), ...stops, ...(plan.end ? [plan.end] : [])];
  if (pts.length < 2) way.forEach((p) => pts.push([p.lon, p.lat]));
  // 每一站在路线上的位置（从上一站往后找最近的点）
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + llDist(pts[i - 1], pts[i]));
  const at = [];
  let from = 0;
  for (const p of way) {
    let best = from;
    let bd = Infinity;
    for (let i = from; i < pts.length; i++) {
      const dd = llDist(pts[i], [p.lon, p.lat]);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    at.push(best);
    from = best;
  }
  // 每一段的时间：短的 2.5 秒，长的最多 7 秒；每一站停一下
  const legs = [];
  for (let i = 1; i < way.length; i++) {
    const len = cum[at[i]] - cum[at[i - 1]];
    legs.push({ a: cum[at[i - 1]], b: cum[at[i]], len, ms: Math.min(7000, 2500 + len / 4), to: way[i] });
  }
  if (!legs.length) legs.push({ a: 0, b: 0, len: 0, ms: 600, to: stops[0] });
  const posAt = (dist) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < dist) i++;
    const k = cum[i] === cum[i - 1] ? 0 : (dist - cum[i - 1]) / (cum[i] - cum[i - 1]);
    return [lerp(pts[i - 1][0], pts[i][0], Math.max(0, Math.min(1, k))), lerp(pts[i - 1][1], pts[i][1], Math.max(0, Math.min(1, k)))];
  };
  const dot = document.createElement('div');
  dot.className = 'tour-dot';
  tour = {
    legs, li: 0, phase: 'move', t0: performance.now(), bearing: map.getBearing(), zoom: map.getZoom(),
    marker: new maplibregl.Marker({ element: dot }).setLngLat(pts[0]).addTo(map),
    prev: { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() },
    sheet: $('#sheet').dataset.state, total: legs.reduce((a, l) => a + l.ms + 1400, 0), done: 0,
  };
  document.body.classList.add('touring');
  setSheet('min');
  $('#tourBar').hidden = false;
  $('#tbTitle').textContent = '出发';
  $('#tbSub').textContent = origin ? origin.name : '';
  map.easeTo({ center: pts[0], zoom: 15, pitch: 55, duration: 900 });
  setTimeout(() => {
    if (!tour) return;
    tour.t0 = performance.now();
    tour.raf = requestAnimationFrame(tourFrame);
  }, 950);

  function tourFrame(now) {
    if (!tour) return;
    const L = tour.legs[tour.li];
    const el = now - tour.t0;
    if (tour.phase === 'move') {
      const k = Math.min(1, el / L.ms);
      const dist = lerp(L.a, L.b, ease(k));
      const p = posAt(dist);
      const ahead = posAt(Math.min(L.b, dist + Math.max(60, L.len * 0.08)));
      if (llDist(p, ahead) > 5) {
        let want = bearingOf(p, ahead);
        let diff = ((want - tour.bearing + 540) % 360) - 180;
        tour.bearing = (tour.bearing + diff * 0.06 + 360) % 360;
      }
      // 长的路拉远一点看，短的走路贴近一点
      const zWant = L.len > 8000 ? 12.6 : L.len > 2500 ? 13.6 : L.len > 600 ? 14.8 : 16;
      tour.zoom = lerp(tour.zoom, k > 0.85 ? 16 : zWant, 0.05);
      map.jumpTo({ center: p, bearing: tour.bearing, pitch: 55, zoom: tour.zoom });
      tour.marker.setLngLat(p);
      $('#tbProg').style.width = `${Math.min(100, ((tour.done + el) / tour.total) * 100)}%`;
      if (k >= 1) {
        tour.phase = 'stay';
        tour.done += L.ms;
        tour.t0 = now;
        const isLast = tour.li === tour.legs.length - 1;
        const nm = L.to.name || '';
        const st = plan.stops.find((x) => x.id === L.to.id);
        $('#tbTitle').textContent = L.to.id ? `第 ${stops.indexOf(L.to) + 1} 站 · ${shortName(L.to)}` : isLast && plan.end ? '回到住的地方' : nm;
        $('#tbSub').textContent = st ? `${fmtClock(st.start)}–${fmtClock(st.depart)} · 停留 ${fmtDur(st.depart - st.start)}` : nm;
        if (L.to.id) highlightMarker(L.to.id);
        buzz(8);
      }
    } else if (el > 1400) {
      tour.done += 1400;
      tour.li++;
      if (tour.li >= tour.legs.length) return stopTour(true);
      tour.phase = 'move';
      tour.t0 = now;
    }
    tour.raf = requestAnimationFrame(tourFrame);
  }
}

function stopTour(finished = false) {
  if (!tour) return;
  cancelAnimationFrame(tour.raf);
  tour.marker.remove();
  const sheet = tour.sheet;
  tour = null;
  document.body.classList.remove('touring');
  $('#tourBar').hidden = true;
  highlightMarker(null);
  setSheet(sheet === 'min' ? 'peek' : sheet);
  map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
  setTimeout(fitAll, 650);
  if (finished) toast('预览完毕');
}

$('#btnPreview').addEventListener('click', () => (tour ? stopTour() : startTour()));
$('#tbStop').addEventListener('click', () => stopTour());

/* ================= 行程图片：路线地图 + 每一站，一张图分享出去 ================= */

const PW = 1080;
const PH = 1350;
const MAP_H = 820;
let posterBlob = null;

function waitIdle(ms = 8000) {
  return new Promise((res) => {
    const timer = setTimeout(res, ms);
    map.once('idle', () => {
      clearTimeout(timer);
      res();
    });
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}

// 这张图要放哪些点：[{lon, lat, label, color, kind}]
function posterPoints(t) {
  const out = [];
  const overview = isMulti(t) && !t.curDay;
  if (overview) {
    for (let d = 1; d <= t.days; d++) {
      const plan = t.dayPlans?.[d];
      (plan?.stops || []).forEach((st, i) => {
        const p = t.places.find((x) => x.id === st.id);
        if (p && !p.done) out.push({ lon: p.lon, lat: p.lat, label: String(i + 1), color: dayColor(d), p, st, day: d });
      });
    }
  } else {
    const info = stopInfoMap();
    (t.plan?.order || []).forEach((id) => {
      const i = info.get(id);
      const p = t.places.find((x) => x.id === id);
      if (i && p) out.push({ lon: p.lon, lat: p.lat, label: String(i.num), color: '#0b1220', p, st: i.st, day: t.curDay || null });
    });
  }
  return out;
}

async function makePoster() {
  const t = T();
  const pts = posterPoints(t);
  if (!pts.length) return toast('还没有排好的路线');
  if (!mapReady) return toast('地图还在载入，等一下再试');
  posterBlob = null;
  $('#posterBox').innerHTML = '<div class="pop-loading">正在画图…（要等地图载入，大约几秒）</div>';
  $('#posterDialog').showModal();
  const dpr = window.devicePixelRatio || 1;
  const cont = map.getContainer().getBoundingClientRect();
  const W = cont.width;
  const H = cont.height;
  // 地图截图要用的范围（跟图片上面的地图一样比例）
  const A = PW / MAP_H;
  const cw = W / H > A ? H * A : W;
  const ch = W / H > A ? H : W / A;
  const cx = (W - cw) / 2;
  const cy = (H - ch) / 2;
  const prev = { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  const hotels = (isMulti(t) && t.curDay ? [startHotel(t, t.curDay), endHotel(t, t.curDay)] : allHotels(t)).filter(Boolean);
  const b = new maplibregl.LngLatBounds([pts[0].lon, pts[0].lat], [pts[0].lon, pts[0].lat]);
  [...pts, ...hotels].forEach((p) => b.extend([p.lon, p.lat]));
  map.fitBounds(b, { padding: { left: cx + 50, right: W - cx - cw + 50, top: cy + ch * 0.2, bottom: H - cy - ch + 50 }, maxZoom: 15, duration: 0, bearing: 0, pitch: 0 });
  await waitIdle();
  const cv = document.createElement('canvas');
  cv.width = PW;
  cv.height = PH;
  const ctx = cv.getContext('2d');
  const k = PW / cw; // 截图的一个 CSS 像素 = 图片上几个像素
  // 地图本身（在画面刚画好的那一刻复制）
  await new Promise((res) => {
    map.once('render', () => {
      try {
        ctx.drawImage(map.getCanvas(), cx * dpr, cy * dpr, cw * dpr, ch * dpr, 0, 0, PW, MAP_H);
      } catch (e) {
        console.warn(e);
      }
      res();
    });
    map.triggerRepaint();
  });
  const proj = (p) => {
    const q = map.project([p.lon, p.lat]);
    return [(q.x - cx) * k, (q.y - cy) * k];
  };
  const font = (w, px) => `${w} ${px}px "Plus Jakarta Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", sans-serif`;
  // 住的地方
  for (const h of hotels) {
    const [x, y] = proj(h);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#0b1220';
    ctx.lineWidth = 5;
    roundRect(ctx, x - 26, y - 26, 52, 52, 14);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#0b1220';
    ctx.font = font(800, 26);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('住', x, y + 1);
  }
  // 每一站的号码
  for (const q of pts) {
    const [x, y] = proj(q);
    ctx.beginPath();
    ctx.arc(x, y, 26, 0, Math.PI * 2);
    ctx.fillStyle = q.color;
    ctx.shadowColor = 'rgba(0,0,0,.35)';
    ctx.shadowBlur = 10;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = font(800, 25);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(q.label, x, y + 1);
  }
  map.jumpTo(prev);
  // 上面的标题（深色渐层上写白字）
  const g = ctx.createLinearGradient(0, 0, 0, 300);
  g.addColorStop(0, 'rgba(11,18,32,.82)');
  g.addColorStop(1, 'rgba(11,18,32,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PW, 300);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.font = font(800, 64);
  const day = isMulti(t) && t.curDay ? t.curDay : null;
  ctx.fillText(fitText(ctx, day ? `${t.dest?.name || t.name} · 第 ${day} 天` : t.name, PW - 120), 60, 110);
  ctx.font = font(600, 32);
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  const sub = day ? fmtDay(t, day) : isMulti(t) ? `${fmtDay(t, 1)} – ${fmtDay(t, t.days)} · ${t.days} 天` : fmtDay(t, 1);
  ctx.fillText(`${sub} · ${pts.length} 个地点`, 62, 165);
  // 下面白色的部分
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 0, MAP_H - 40, PW, PH - MAP_H + 40, 40);
  ctx.fill();
  // 统计
  const plans = day || !isMulti(t) ? [t.plan] : Array.from({ length: t.days }, (_, i) => t.dayPlans?.[i + 1]);
  const s = plans.filter(Boolean).map(dayStats).reduce((a, x) => ({ car: a.car + x.car, foot: a.foot + x.foot, transitMs: a.transitMs + x.transitMs }), { car: 0, foot: 0, transitMs: 0 });
  const chips = [
    s.car > 50 ? [`开车 ${fmtDist(s.car)}`, '#2563eb'] : null,
    s.foot > 50 ? [`走路 ${fmtDist(s.foot)} ≈ ${Math.round(s.foot / 0.72).toLocaleString('en')} 步`, '#059669'] : null,
    s.transitMs > 0 ? [`公交 ${fmtDur(s.transitMs)}`, '#7c3aed'] : null,
    day || !isMulti(t) ? t.plan ? [`${fmtClock(t.plan.startTime)} – ${fmtClock(t.plan.endArrive ?? t.plan.finish)}`, '#0b1220'] : null : null,
  ].filter(Boolean);
  let x = 60;
  ctx.font = font(700, 28);
  ctx.textBaseline = 'middle';
  for (const [txt, col] of chips) {
    const w = ctx.measureText(txt).width + 44;
    if (x + w > PW - 60) break;
    ctx.fillStyle = `${col}18`;
    roundRect(ctx, x, MAP_H + 6, w, 54, 27);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.fillText(txt, x + 22, MAP_H + 34);
    x += w + 14;
  }
  // 地点清单
  const top = MAP_H + 100;
  const bottom = PH - 80;
  ctx.textBaseline = 'alphabetic';
  if (day || !isMulti(t)) {
    const cols = pts.length > 7 ? 2 : 1;
    const rows = Math.ceil(pts.length / cols);
    const lh = Math.min(rows <= 5 ? 74 : 62, (bottom - top) / Math.max(1, rows));
    const colW = (PW - 120) / cols;
    pts.forEach((q, i) => {
      const cx2 = 60 + Math.floor(i / rows) * colW;
      const y = top + (i % rows) * lh + lh * 0.6;
      ctx.beginPath();
      ctx.arc(cx2 + 18, y - 10, 18, 0, Math.PI * 2);
      ctx.fillStyle = '#0b1220';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = font(800, 19);
      ctx.textAlign = 'center';
      ctx.fillText(q.label, cx2 + 18, y - 3);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#6b7280';
      ctx.font = font(600, 24);
      ctx.fillText(fmtClock(q.st.start), cx2 + 48, y);
      ctx.fillStyle = '#111827';
      ctx.font = font(700, 27);
      ctx.fillText(fitText(ctx, q.p.name, colW - 140), cx2 + 124, y);
    });
  } else {
    // 多天：每一天一栏
    const days = Array.from({ length: t.days }, (_, i) => i + 1).filter((d) => pts.some((q) => q.day === d));
    const cols = Math.min(days.length, 4);
    const colW = (PW - 120) / cols;
    days.slice(0, 8).forEach((d, ci) => {
      const col = ci % cols;
      const rowBlock = Math.floor(ci / cols);
      const blockH = (bottom - top) / Math.ceil(Math.min(days.length, 8) / cols);
      const x0 = 60 + col * colW;
      let y = top + rowBlock * blockH + 30;
      ctx.fillStyle = dayColor(d);
      roundRect(ctx, x0, y - 30, 110, 42, 21);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = font(800, 24);
      ctx.textAlign = 'center';
      ctx.fillText(`第 ${d} 天`, x0 + 55, y - 1);
      ctx.textAlign = 'left';
      const items = pts.filter((q) => q.day === d);
      const lh = Math.min(50, (blockH - 60) / Math.max(1, items.length));
      ctx.font = font(600, Math.min(28, lh * 0.62));
      ctx.fillStyle = '#111827';
      items.forEach((q, i) => {
        y = top + rowBlock * blockH + 60 + (i + 1) * lh - 8;
        ctx.fillText(fitText(ctx, `${q.label}. ${q.p.name.split(' ')[0]}`, colW - 20), x0, y);
      });
    });
  }
  // 页脚
  ctx.fillStyle = '#9ca3af';
  ctx.font = font(600, 22);
  ctx.textAlign = 'center';
  ctx.fillText('用「顺路」排的路线 · vean05.github.io/shunlu · 地图 © OpenStreetMap', PW / 2, PH - 34);
  posterBlob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.92));
  if (!posterBlob) {
    $('#posterBox').innerHTML = '<div class="pop-loading">画图失败，请再试一次</div>';
    return;
  }
  const url = URL.createObjectURL(posterBlob);
  $('#posterBox').innerHTML = `<img src="${url}" alt="行程图片">`;
}

const posterName = () => `${(T()?.name || '行程').replace(/[\\/:*?"<>|]/g, '')}.jpg`;
$('#btnPoster').addEventListener('click', makePoster);
$('#posterClose').addEventListener('click', () => $('#posterDialog').close());
$('#posterSave').addEventListener('click', () => {
  if (!posterBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(posterBlob);
  a.download = posterName();
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('已存到手机（在「下载」或相簿里）');
});
$('#posterShare').addEventListener('click', async () => {
  if (!posterBlob) return;
  const file = new File([posterBlob], posterName(), { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: T()?.name || '行程' });
    } catch {}
  } else $('#posterSave').click();
});

/* ================= 加进手机日历（自己选的，不会自动加） ================= */

function icsFold(line) {
  // 日历格式规定每行最多 75 个字节，中文一个字 3 个字节
  const enc = new TextEncoder();
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 73 : 74)) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function buildICS(t) {
  const plans = isMulti(t) ? Array.from({ length: t.days }, (_, i) => t.dayPlans?.[i + 1]).filter(Boolean) : [t.plan].filter(Boolean);
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//shunlu//trip//ZH', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsText(t.name)}`];
  let n = 0;
  const now = icsTime(Date.now());
  for (const plan of plans) {
    plan.stops.forEach((st, i) => {
      const p = t.places.find((x) => x.id === st.id);
      if (!p || p.done || st.flag === 'closed') return;
      const leg = plan.legs[i];
      const how = leg ? `${legKind(leg) === 'foot' ? '走路' : legKind(leg) === 'car' ? '开车' : '搭公交'}约 ${fmtDur(leg.dur)}` : '';
      const desc = [how && `从上一站${how}`, p.note, `导航：https://www.google.com/maps/dir/?api=1&destination=${p.lat.toFixed(6)},${p.lon.toFixed(6)}`].filter(Boolean).join('\n');
      const remind = Math.max(10, Math.round((leg?.dur || 0) / 60e3) + 10);
      L.push(
        'BEGIN:VEVENT',
        `UID:${t.id}-${p.id}@shunlu`,
        `DTSTAMP:${now}`,
        `DTSTART:${icsTime(st.start)}`,
        `DTEND:${icsTime(Math.max(st.depart, st.start + 5 * 60e3))}`,
        `SUMMARY:${icsText(p.name)}`,
        `LOCATION:${icsText(p.address || p.name)}`,
        `GEO:${p.lat.toFixed(6)};${p.lon.toFixed(6)}`,
        `DESCRIPTION:${icsText(desc)}`,
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `TRIGGER:-PT${remind}M`,
        `DESCRIPTION:${icsText(`该出发去「${shortName(p)}」了`)}`,
        'END:VALARM',
        'END:VEVENT',
      );
      n++;
    });
  }
  L.push('END:VCALENDAR');
  return { text: L.map(icsFold).join('\r\n') + '\r\n', n };
}

$('#btnCalendar').addEventListener('click', async () => {
  const t = T();
  const { text, n } = buildICS(t);
  if (!n) return toast('还没有排好时间的地点');
  if (!confirm(`把 ${n} 个地点加进手机日历？\n每一站会在出发前提醒你。之后行程改了，要再加一次。`)) return;
  const name = `${t.name.replace(/[\\/:*?"<>|]/g, '')}.ics`;
  // iPhone：直接打开就会问要不要加进日历
  if (isIOS()) {
    location.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(text)}`;
    return;
  }
  const file = new File([text], name, { type: 'text/calendar' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: t.name });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('已下载日历文件：打开它就会加进日历', 4000);
});

/* ================= 自己改时间：某个地点几点去、这天几点出发、酒店 Check-in ================= */

let timeCtx = null; // { kind: 'stop', id } 或 { kind: 'day', day }

function timeRow(id, label, value, sub = '') {
  return `<div class="tm-row"><label for="${id}">${label}${sub ? `<small>${sub}</small>` : ''}</label>
    <div class="tm-in"><input type="time" id="${id}" value="${esc(value || '')}">
    <div class="tm-quick" data-for="${id}"><button type="button" data-shift="-30">−30分</button><button type="button" data-shift="30">+30分</button><button type="button" data-shift="60">+1小时</button></div></div></div>`;
}

function openTimeDialog(p) {
  const t = T();
  const st = t.plan?.stops.find((x) => x.id === p.id);
  timeCtx = { kind: 'stop', id: p.id };
  $('#tmTitle').textContent = `几点去「${shortName(p)}」？`;
  $('#tmHint').textContent = '定好后会照这个时间去，其他地点自动排在前后；早到会提醒你，晚到会告诉你晚多少。';
  $('#tmRows').innerHTML = timeRow('tmA', '开始时间', p.fixedTime || (st ? fmtClock(st.start) : ''));
  $('#tmClear').hidden = !p.fixedTime;
  $('#timeDialog').showModal();
}

// 这天住的酒店（Check-in 用）
const checkinHotel = (t, day) => (isMulti(t) ? endHotel(t, day) : t.home);
const checkinOf = (t, day) => t.places.find((p) => p.checkin && !p.done && (day == null || p.day === day));

function openDayTimeDialog() {
  const t = T();
  const day = isMulti(t) ? t.curDay : null;
  const key = manualKey(day);
  const plan = t.plan;
  timeCtx = { kind: 'day', day };
  const hotel = checkinHotel(t, day);
  const ci = checkinOf(t, day);
  $('#tmTitle').textContent = day ? `第 ${day} 天的时间` : '这天的时间';
  $('#tmHint').textContent = '改了会按新的时间重新排这天的路线。';
  $('#tmRows').innerHTML =
    timeRow('tmA', '几点出发', t.dayDepart?.[key] || (plan ? fmtClock(plan.startTime) : t.settings.departAt)) +
    (hotel ? timeRow('tmB', '酒店 Check-in', ci?.fixedTime || '', `中途回「${esc(shortName(hotel))}」办入住、放行李就填（这间 ${esc(checkInOf(hotel))} 起可以入住）；不用就留空`) : '');
  $('#tmClear').hidden = !(t.dayDepart?.[key] || ci);
  $('#timeDialog').showModal();
}

$('#tmRows').addEventListener('click', (e) => {
  const b = e.target.closest('[data-shift]');
  if (!b) return;
  const input = $(`#${b.parentElement.dataset.for}`);
  const [h, m] = (input.value || '09:00').split(':').map(Number);
  const v = Math.min(23 * 60 + 59, Math.max(0, h * 60 + m + Number(b.dataset.shift)));
  input.value = `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
});

function setCheckin(t, day, hhmm) {
  const cur = checkinOf(t, day);
  if (!hhmm) {
    if (cur) t.places.splice(t.places.indexOf(cur), 1);
    return;
  }
  const h = checkinHotel(t, day);
  if (!h) return;
  if (cur) {
    Object.assign(cur, { fixedTime: hhmm, lat: h.lat, lon: h.lon });
    return;
  }
  const p = makePlace({ name: `${h.name.split(' ')[0]} · Check-in`, address: h.address || '', lat: h.lat, lon: h.lon, kind: 'hotel', stayMin: 20 });
  Object.assign(p, { needsDetails: false, checkin: true, fixedTime: hhmm, note: '办入住、放行李' });
  if (day != null) Object.assign(p, { day, dayLocked: true });
  t.places.push(p);
}

function afterTimeChange(msg) {
  const t = T();
  setManual(t, isMulti(t) ? t.curDay : null, null); // 时间变了：重新找最顺的顺序
  save();
  $('#timeDialog').close();
  renderMap();
  toast(msg, 3000);
  replan();
}

$('#tmOk').addEventListener('click', () => {
  const t = T();
  if (!timeCtx) return;
  if (timeCtx.kind === 'stop') {
    const p = t.places.find((x) => x.id === timeCtx.id);
    const v = $('#tmA').value;
    if (!p || !v) return toast('请选一个时间');
    p.fixedTime = v;
    return afterTimeChange(`「${shortName(p)}」固定 ${v} 开始，重新排其他地点`);
  }
  const key = manualKey(timeCtx.day);
  const a = $('#tmA').value;
  t.dayDepart ||= {};
  if (a) t.dayDepart[key] = a;
  if ($('#tmB')) setCheckin(t, timeCtx.day, $('#tmB').value);
  afterTimeChange(`${a ? `${a} 出发` : ''}${$('#tmB')?.value ? `，${$('#tmB').value} 回酒店 Check-in` : ''}，重新排路线`);
});
$('#tmClear').addEventListener('click', () => {
  const t = T();
  if (!timeCtx) return;
  if (timeCtx.kind === 'stop') {
    const p = t.places.find((x) => x.id === timeCtx.id);
    if (p) p.fixedTime = null;
    return afterTimeChange('已恢复自动安排时间');
  }
  if (t.dayDepart) delete t.dayDepart[manualKey(timeCtx.day)];
  setCheckin(t, timeCtx.day, null);
  afterTimeChange('已恢复原本的出发时间');
});
$('#tmCancel').addEventListener('click', () => $('#timeDialog').close());

/* ================= 编辑地点 ================= */

let editingId = null;
function openPlaceDialog(id) {
  const p = T().places.find((x) => x.id === id);
  if (!p) return;
  editingId = id;
  $('#pdName').value = p.name;
  $('#pdAddress').textContent = p.address || '';
  $('#pdStay').value = p.stayMin;
  $('#pdOpen').value = p.manual?.open || '';
  $('#pdClose').value = p.manual?.close || '';
  $('#pdClosed').checked = !!p.manual?.closed;
  $('#pdNote').value = p.note || '';
  $('#pdTicket').value = p.ticket ?? '';
  $('#pdFixed').value = p.fixedTime || '';
  $('#pdTicketCur').textContent = cur(T()) || '金额';
  const osmFee = p.fee === 'yes' ? `地图资料：要收费${p.charge ? `（${p.charge}）` : ''}` : p.fee === 'no' ? '地图资料：免费' : p.charge ? `地图资料：${p.charge}` : '';
  $('#pdTicketHint').textContent = osmFee || '不知道就留空；免费就填 0';
  const known = parseOpeningHours(p.hoursRaw);
  $('#pdHoursInfo').innerHTML = p.hoursRaw
    ? `地图资料：<code>${esc(p.hoursRaw)}</code>${known ? '' : '<br><span class="note warn">这个写法看不懂，请手动输入下面的时间</span>'}`
    : '<span class="muted">地图上没有营业时间资料。知道的话可以手动输入；不输入就当作一直开着。</span>';
  $('#pdDone').textContent = p.done ? '恢复' : '已去过';
  const t = T();
  $('#pdDayWrap').hidden = !isMulti(t);
  if (isMulti(t)) {
    $('#pdDay').innerHTML = `<option value="auto">自动（${p.day ? `现在在第 ${p.day} 天` : '还没分配'}）</option>` +
      Array.from({ length: t.days }, (_, i) => `<option value="${i + 1}">固定在第 ${i + 1} 天（${fmtDay(t, i + 1)}）</option>`).join('');
    $('#pdDay').value = p.dayLocked && p.day ? String(p.day) : 'auto';
  }
  $('#placeDialog').showModal();
}

$('#pdStayChips').addEventListener('click', (e) => {
  const v = e.target.dataset?.v;
  if (v) $('#pdStay').value = v;
});
$('#pdCancel').addEventListener('click', () => $('#placeDialog').close());
$('#pdClearManual').addEventListener('click', () => {
  $('#pdOpen').value = '';
  $('#pdClose').value = '';
  $('#pdClosed').checked = false;
});
$('#pdDelete').addEventListener('click', () => {
  $('#placeDialog').close();
  removePlace(editingId);
});
$('#pdDone').addEventListener('click', () => {
  const p = T().places.find((x) => x.id === editingId);
  $('#placeDialog').close();
  if (p) markDone(p.id, !p.done);
});
$('#pdNav').addEventListener('click', () => {
  const p = T().places.find((x) => x.id === editingId);
  if (p) openNav(p);
});
$('#placeForm').addEventListener('submit', () => {
  const p = T().places.find((x) => x.id === editingId);
  if (!p) return;
  p.name = $('#pdName').value.trim() || p.name;
  p.stayMin = Math.max(0, Number($('#pdStay').value) || 0);
  p.note = $('#pdNote').value.trim();
  p.ticket = $('#pdTicket').value === '' ? null : Math.max(0, Number($('#pdTicket').value) || 0);
  if (($('#pdFixed').value || null) !== (p.fixedTime || null)) {
    p.fixedTime = $('#pdFixed').value || null;
    setManual(T(), isMulti(T()) ? p.day : null, null); // 时间变了：重新排最顺的顺序
  }
  const open = $('#pdOpen').value;
  const close = $('#pdClose').value;
  p.manual = $('#pdClosed').checked ? { closed: true } : open && close ? { open, close } : null;
  const t = T();
  if (isMulti(t)) {
    const v = $('#pdDay').value;
    const old = p.day;
    if (v === 'auto') p.dayLocked = false;
    else {
      p.day = Number(v);
      p.dayLocked = true;
    }
    if (p.day !== old) {
      // 两天的路线都要重算
      delete t.dayPlans[old];
      delete t.dayPlans[p.day];
      toast(`已移到第 ${p.day} 天`);
    }
  }
  save();
  renderMap();
  scheduleReplan(200);
});

/* ================= 问 AI（复制给自己的 AI App，不需要 API） ================= */

function buildAIPrompt() {
  const t = T();
  const plan = t.plan;
  const info = stopInfoMap();
  const lines = [];
  lines.push('我正在旅行，下面是我今天想去的地方和 App 算出来的路线。请给我建议：');
  lines.push('1）顺序是否合理（考虑人潮、日落、用餐时间、景点特色）；2）每个地方建议停留多久；3）有没有应该跳过或换天的；4）附近顺路值得加的地方。请简短回答。');
  lines.push('');
  if (isMulti(t) && !t.curDay) {
    lines[0] = `我在${t.dest?.name || ''}旅行 ${t.days} 天，下面是 App 帮我分配的每天行程。请给我建议：`;
    for (let d = 1; d <= t.days; d++) {
      const dp = t.dayPlans?.[d];
      lines.push(`第${d}天（${fmtDay(t, d)}）：${(dp?.stops || []).map((st) => `${fmtClock(st.start)} ${t.places.find((x) => x.id === st.id)?.name}`).join(' → ') || '还没安排'}`);
    }
  } else if (plan) {
    lines.push(`出发：${plan.origin ? plan.origin.name : '第一站'}，${fmtClock(plan.startTime)}${plan.end ? `，最后回到 ${plan.end.name}` : ''}`);
    plan.order.forEach((id) => {
      const p = t.places.find((x) => x.id === id);
      const i = info.get(id);
      if (!p || !i) return;
      const st = i.st;
      const h = placeHoursOn(p, new Date(plan.startTime));
      const hours = h.known ? (h.windows.length ? h.windows.map(([o, c]) => `${minToHHMM(o)}-${minToHHMM(c)}`).join(',') : '休息') : '未知';
      const legTxt = i.legIn ? `（${i.legIn.mode === 'car' ? '开车' : '走路'}${fmtDur(i.legIn.dur)}）` : '';
      lines.push(`${i.num}. ${p.name}${legTxt}：${fmtClock(st.start)}-${fmtClock(st.depart)}，营业 ${hours}${st.flag === 'closed' ? '，⚠️到时已关门' : st.flag === 'short' ? '，⚠️快关门' : ''}${p.note ? `，备注：${p.note}` : ''}`);
      if (p.address) lines.push(`   地址：${p.address}`);
    });
  } else {
    t.places.filter((p) => !p.done).forEach((p, i) => lines.push(`${i + 1}. ${p.name}（${p.address}）`));
  }
  const done = t.places.filter((p) => p.done);
  if (done.length) lines.push(`已经去过：${done.map((p) => p.name).join('、')}`);
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

$('#btnAI').addEventListener('click', async () => {
  if (!T().places.length) return toast('先加入一些地点');
  const ok = await copyText(buildAIPrompt());
  toast(ok ? '已复制！打开 ChatGPT / Gemini / Claude App 贴上就可以问' : '复制失败', 4000);
});

/* ================= 底部面板拖动 ================= */

const SHEET = { min: 132, peek: 0.38, full: 0.88 };
function sheetPx(st) {
  return st === 'min' ? SHEET.min : Math.round(window.innerHeight * SHEET[st]);
}
function setSheet(st) {
  $('#sheet').dataset.state = st;
  document.documentElement.style.setProperty('--sheet-h', `${sheetPx(st)}px`);
}
setSheet('peek');
window.addEventListener('resize', () => setSheet($('#sheet').dataset.state));

(function sheetDrag() {
  const sheet = $('#sheet');
  let startY = 0;
  let startH = 0;
  let moved = false;
  const onDown = (e) => {
    if (e.target.closest('button')) return;
    startY = e.clientY;
    startH = sheet.getBoundingClientRect().height;
    moved = false;
    sheet.classList.add('dragging');
    sheet.setPointerCapture(e.pointerId);
    sheet.addEventListener('pointermove', onMove);
    sheet.addEventListener('pointerup', onUp, { once: true });
    sheet.addEventListener('pointercancel', onUp, { once: true });
  };
  const onMove = (e) => {
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 5) moved = true;
    const h = Math.min(window.innerHeight * 0.92, Math.max(SHEET.min, startH + dy));
    document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  };
  const onUp = (e) => {
    sheet.removeEventListener('pointermove', onMove);
    sheet.classList.remove('dragging');
    const cur = sheet.dataset.state;
    if (!moved) {
      if (e.target.closest('#sheetGrip')) setSheet(cur === 'full' ? 'peek' : 'full');
      else setSheet(cur);
      return;
    }
    const h = sheet.getBoundingClientRect().height;
    const best = ['min', 'peek', 'full'].reduce((a, b) => (Math.abs(sheetPx(b) - h) < Math.abs(sheetPx(a) - h) ? b : a));
    setSheet(best);
  };
  $('#sheetGrip').addEventListener('pointerdown', onDown);
  $('#sheetHead').addEventListener('pointerdown', onDown);
})();

/* ================= 按钮与自动更新 ================= */

// 「⋯」菜单：按了任何一项就关掉
$('#btnMenu').addEventListener('click', () => {
  const t = T();
  $('#btnArrange').hidden = !isMulti(t);
  $('#btnReorder').hidden = isMulti(t) && !t.curDay;
  $('#menuDialog').showModal();
});
$('#menuDialog').addEventListener('click', (e) => {
  if (e.target.closest('button') || e.target === $('#menuDialog')) $('#menuDialog').close();
});
$('#btnReplan').addEventListener('click', async () => {
  const t = T();
  if (isMulti(t) && !t.curDay) {
    $('#btnReplan').disabled = true;
    try {
      await arrangeTrip(t);
      toast('已重新分配每一天的地点');
    } finally {
      $('#btnReplan').disabled = false;
    }
  }
  replan();
});
$('#btnEdit').addEventListener('click', () => openSetup({ edit: true, step: 2 }));
$('#btnStays').addEventListener('click', () => openSetup({ edit: true, step: 3 }));
$('#btnArrange').addEventListener('click', async () => {
  const t = T();
  if (!isMulti(t)) return toast('只有一天，不用分配；可以在「修改行程」第 1 步加天数');
  await arrangeTrip(t);
  t.curDay = 0;
  t.plan = null;
  toast('已重新分配每一天的地点');
  replan();
});
$('#mapBack').addEventListener('click', () => {
  if (reorderMode) setReorderMode(false);
  if (tour) stopTour();
  showView('trips');
});
$('#btnFit').addEventListener('click', fitAll);

// 每次回到 App：超过 5 分钟就按现在的位置和时间重新算
document.addEventListener('visibilitychange', () => {
  updateGeoWatch();
  if (document.visibilityState !== 'visible' || currentView !== 'map') return;
  replanIfStale();
  renderMap();
});

// 每分钟刷新"还有多久关门"
setInterval(() => {
  if (document.visibilityState === 'visible' && currentView === 'map') renderMap();
}, 60e3);

/* ================= 启动 ================= */

document.querySelectorAll('[data-ic]').forEach((el) => (el.innerHTML = ic(el.dataset.ic, 20)));

// 示例行程只给主人看：用 ?owner=1 打开一次，这支手机就会记住（?owner=0 取消）
// 一般人打开是空的，只有「开始规划新行程」。行程本来就只存在各自的手机里，互相看不到
(() => {
  const q = new URLSearchParams(location.search);
  if (!q.has('owner')) return;
  try {
    if (q.get('owner') === '0') localStorage.removeItem('shunlu:owner');
    else localStorage.setItem('shunlu:owner', '1');
  } catch {}
  q.delete('owner');
  history.replaceState(null, '', location.pathname + (q.toString() ? `?${q}` : '') + location.hash);
  toast(localStorage.getItem('shunlu:owner') ? '这支手机会显示示例行程（测试用）' : '已关闭示例行程');
})();
const isOwner = (() => {
  try {
    return localStorage.getItem('shunlu:owner') === '1';
  } catch {
    return false;
  }
})();
$('#btnDemo').hidden = !isOwner;

// 上次停在某个行程的地图上：直接回到那里并重新计算；否则显示首页
const resumeTrip = T();
if (state.lastView === 'map' && resumeTrip?.places.some((p) => !p.done)) {
  showView('map');
  const plan = resumeTrip.plan;
  if (plan) setStatus(`上次更新 ${fmtClock(plan.computedAt)}，正在重新计算…`);
  setTimeout(fitAll, 400);
  replanIfStale(true);
} else {
  showView('trips');
}

checkSharedLink();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
