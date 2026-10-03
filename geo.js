// 免费的地图服务，不需要申请 API key：
//   搜索地点：Nominatim（OpenStreetMap 官方搜索，限制每秒 1 次）
//   开车时间和路线：OSRM 公共服务器（备用：FOSSGIS 的 OSRM）
//   走路时间和路线：FOSSGIS 的 Valhalla 服务器（备用：FOSSGIS 的 OSRM）

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const CAR_SERVERS = ['https://router.project-osrm.org', 'https://routing.openstreetmap.de/routed-car'];
const FOOT_OSRM = 'https://routing.openstreetmap.de/routed-foot';
const VALHALLA = 'https://valhalla1.openstreetmap.de';

// Nominatim 要求每秒最多 1 次请求
let lastNominatim = 0;
async function nominatimFetch(url) {
  // 网络不稳或服务很忙：等一下再试（最多 3 次）
  for (let attempt = 0; ; attempt++) {
    const wait = lastNominatim + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatim = Date.now();
    try {
      const res = await fetch(url);
      if (!res.ok) throw Object.assign(new Error(`搜索服务出错（${res.status}）`), { status: res.status });
      return await res.json();
    } catch (e) {
      const retry = !e.status || e.status === 429 || e.status >= 500;
      if (!retry || attempt >= 2 || !navigator.onLine) throw e;
      await new Promise((r) => setTimeout(r, e.status === 429 ? 4000 : 1500 * (attempt + 1)));
    }
  }
}

// 输入里有中日韩文字吗
export const hasCJK = (s) => /[぀-ヿ㐀-鿿가-힯]/.test(s || '');

// 名字用哪种语言：输入中文就显示中文名，输入其他语言就显示当地名字；另一种语言放在下面当副名
function pickNames(nd, fallback, query) {
  const local = nd?.name || fallback;
  const zh = nd?.['name:zh'] || nd?.['name:zh-Hans'] || nd?.['name:zh-Hant'] || nd?.['name:zh-CN'] || '';
  const en = nd?.['name:en'] || '';
  const main = hasCJK(query) && zh ? zh : local;
  const alt = [local, en, zh].filter((x, i, a) => x && x !== main && a.indexOf(x) === i).slice(0, 2).join(' · ');
  return { name: main, alt, en: en || (hasCJK(local) ? '' : local) };
}

function toPlace(r, query = '') {
  const first = (r.display_name || '').split(',')[0];
  const names = pickNames(r.namedetails, r.name || first, query);
  // 没有名字的（纯地址），用地址前两段当名字
  if (!r.name && !r.namedetails?.name) names.name = (r.display_name || '').split(',').slice(0, 2).join(',').trim();
  return {
    ...names,
    address: r.display_name || '',
    lat: Number(r.lat),
    lon: Number(r.lon),
    hoursRaw: r.extratags?.opening_hours || null,
    osm: r.osm_type && r.osm_id ? `${r.osm_type[0].toUpperCase()}${r.osm_id}` : null,
    kind: r.type || r.category || '',
    wikidata: r.extratags?.wikidata || null,
    website: r.extratags?.website || r.extratags?.['contact:website'] || '',
    phone: r.extratags?.phone || r.extratags?.['contact:phone'] || '',
    fee: r.extratags?.fee || '', // 地图资料：要不要收费（yes / no）
    charge: r.extratags?.charge || '', // 地图资料：收多少（例如「10 MYR」）
  };
}

// bounds = [west, south, east, north]，优先搜索目前地图范围附近
// bounded = true 时只找范围里面的
export async function searchPlaces(q, bounds, bounded = false) {
  const params = new URLSearchParams({
    q, format: 'jsonv2', limit: '8', extratags: '1', namedetails: '1', addressdetails: '0',
    // 地址用跟输入一样的语言显示
    'accept-language': hasCJK(q) ? 'zh-CN,zh,en' : 'en',
  });
  if (bounds) params.set('viewbox', bounds.join(','));
  if (bounds && bounded) params.set('bounded', '1');
  const data = await nominatimFetch(`${NOMINATIM}/search?${params}`);
  return data.map((r) => toPlace(r, q));
}

// 边打字边出现的建议：Photon（专门为输入建议设计的免费服务，可以频繁请求）
const PHOTON = 'https://photon.komoot.io';

function photonToPlace(f) {
  const p = f.properties;
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  return {
    name: p.name || street || p.city || '未命名地点',
    alt: '',
    en: p.name || '',
    address: [street, p.district, p.city, p.state, p.country].filter((x, i, a) => x && a.indexOf(x) === i).join(', '),
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    hoursRaw: null,
    osm: p.osm_type && p.osm_id ? `${p.osm_type}${p.osm_id}` : null,
    kind: p.osm_value || p.osm_key || '',
    needsDetails: true,
  };
}

// 去掉重复：同一个编号，或同名而且距离 1 公里内（例如一条路被分成好几段）
function dedupe(list) {
  const seen = new Set();
  const kept = [];
  return list.filter((r) => {
    const k = r.osm || `${r.lat},${r.lon}`;
    if (seen.has(k)) return false;
    seen.add(k);
    if (kept.some((x) => x.name === r.name && haversine(x, r) < 1000)) return false;
    kept.push(r);
    return true;
  });
}

let photonCtrl = null;
// bbox = [西, 南, 东, 北]：只建议这个范围里的地方
export async function suggestPlaces(q, near, bbox) {
  if (photonCtrl) photonCtrl.abort();
  photonCtrl = new AbortController();
  const params = new URLSearchParams({ q, limit: '8' });
  if (near) {
    params.set('lat', near.lat.toFixed(4));
    params.set('lon', near.lon.toFixed(4));
  }
  if (bbox) params.set('bbox', bbox.join(','));
  const res = await fetch(`${PHOTON}/api/?${params}`, { signal: photonCtrl.signal });
  if (!res.ok) throw new Error(`搜索服务出错（${res.status}）`);
  const data = await res.json();
  return dedupe(data.features.map(photonToPlace));
}

// 某个位置附近有名字的地方（店、景点、建筑…）
export async function nearbyPlaces(lat, lon, radiusKm = 0.4) {
  const params = new URLSearchParams({ lat: lat.toFixed(6), lon: lon.toFixed(6), limit: '15', radius: String(radiusKm) });
  const res = await fetch(`${PHOTON}/reverse?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  return dedupe(data.features.filter((f) => f.properties.name).map(photonToPlace))
    .sort((a, b) => haversine({ lat, lon }, a) - haversine({ lat, lon }, b))
    .slice(0, 10);
}

// 从文字里认出坐标：「5.4141, 100.3288」或 Google Maps 网址
export function parseCoords(text) {
  const t = (text || '').trim();
  const pats = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, // Google Maps 地点网址
    /@(-?\d+\.\d+),(-?\d+\.\d+)/, // Google Maps 网址里的 @纬度,经度
    /[?&](?:q|ll|query|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /^(-?\d{1,2}\.\d{3,})\s*[,，\s]\s*(-?\d{1,3}\.\d{3,})$/, // 直接打坐标
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (m) {
      const lat = Number(m[1]);
      const lon = Number(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
    }
  }
  return null;
}

// 地址找不到时，慢慢放宽：去掉门牌 / 单位 / 邮编，再一段一段去掉前面的部分
function looserVariants(q) {
  const segs = q.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  const clean = segs
    .map((s) => s.replace(/^(no\.?|lot|unit|blk|block|#)\s*[\w-]+\s*/i, '').replace(/\b\d{5,6}\b/g, '').replace(/^\d+[\w-]*\s+/, '').trim())
    .filter(Boolean);
  const out = [];
  if (clean.join(', ') !== segs.join(', ')) out.push(clean.join(', '));
  for (let i = 1; i < clean.length - 1 && out.length < 3; i++) out.push(clean.slice(i).join(', '));
  return [...new Set(out)].filter((v) => v && v !== q).slice(0, 3);
}

// 聪明搜索：地名、地址、坐标、Google Maps 网址都可以
// 返回 { results, approx?: {point, label}, nearby? }
export async function smartSearch(q, bbox, near) {
  const c = parseCoords(q);
  if (c) {
    const [here, nearby] = await Promise.all([reverseGeocode(c.lat, c.lon), nearbyPlaces(c.lat, c.lon, 0.3)]);
    here.name = here.name || '这个坐标';
    return { results: [], approx: { point: here, label: `坐标 ${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`, exact: true }, nearby };
  }
  let r = bbox ? await searchPlaces(q, bbox, true) : [];
  if (!r.length) r = await searchPlaces(q, bbox || (near ? [near.lon - 0.5, near.lat - 0.5, near.lon + 0.5, near.lat + 0.5] : null), false);
  // 输入的是门牌地址，但只找到整条街：显示街道 + 附近的地方，让用户挑
  const looksLikeAddress = /\d/.test(q) && /[,，]|jalan|lebuh|lorong|road|street|st\b|rd\b|ave|路|街|号|丁目/i.test(q);
  const ROADS = /residential|primary|secondary|tertiary|trunk|unclassified|service|road|street|pedestrian|living_street|footway/;
  if (r.length && looksLikeAddress && ROADS.test(r[0].kind)) {
    return { results: [], approx: { point: r[0], label: r[0].name }, nearby: await nearbyPlaces(r[0].lat, r[0].lon, 0.4) };
  }
  if (r.length) return { results: r };
  for (const v of looserVariants(q)) {
    const r2 = await searchPlaces(v, bbox, !!bbox);
    if (r2.length) {
      const p = r2[0];
      return { results: [], approx: { point: p, label: v }, nearby: await nearbyPlaces(p.lat, p.lon, 0.4) };
    }
  }
  return { results: [] };
}

// 用 OSM 编号补查营业时间（建议列表本身没有营业时间）
export async function lookupDetails(osm) {
  if (!osm) return null;
  const params = new URLSearchParams({ osm_ids: osm, format: 'jsonv2', extratags: '1', namedetails: '1' });
  const data = await nominatimFetch(`${NOMINATIM}/lookup?${params}`);
  return data[0] ? toPlace(data[0]) : null;
}

export async function reverseGeocode(lat, lon) {
  const params = new URLSearchParams({ lat, lon, format: 'jsonv2', extratags: '1', namedetails: '1', zoom: '18', 'accept-language': 'en' });
  const r = await nominatimFetch(`${NOMINATIM}/reverse?${params}`);
  if (!r || r.error) return { name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, address: '', lat, lon, hoursRaw: null };
  const p = toPlace(r);
  p.lat = lat;
  p.lon = lon;
  return p;
}

function coordStr(points) {
  return points.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
}

// 免费服务器有频率限制：同一个服务器的请求排队，一个一个发，中间至少隔 1 秒
const queues = new Map();
function fetchJSON(url) {
  const host = new URL(url).host;
  const q = queues.get(host) || { chain: Promise.resolve(), last: 0 };
  queues.set(host, q);
  const job = q.chain.then(async () => {
    for (let attempt = 0; ; attempt++) {
      const wait = q.last + 1000 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      q.last = Date.now();
      try {
        return await fetchJSONOnce(url);
      } catch (e) {
        // 没网络就不用等；服务很忙（429）等久一点
        if (attempt >= 2 || !navigator.onLine || (e.status && e.status < 500 && e.status !== 429)) throw e;
        await new Promise((r) => setTimeout(r, e.status === 429 ? 4000 : 1500 * (attempt + 1)));
      }
    }
  });
  q.chain = job.catch(() => {});
  return job;
}

async function fetchJSONOnce(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw Object.assign(new Error(`路线服务出错（${res.status}）`), { status: res.status });
    const data = await res.json();
    if (data.code && data.code !== 'Ok') throw new Error(`路线服务出错（${data.code}）`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// 依次尝试几个服务器，第一个成功的就用
async function firstOk(tries) {
  let err;
  for (const t of tries) {
    try {
      return await t();
    } catch (e) {
      console.warn(e);
      err = e;
    }
  }
  throw err;
}

/* ---- 交通时间表 ---- */

// 返回 { durations, distances }，大小 rows × n（rows = 全部点，或只有第 0 个点）
async function osrmTable(base, points, row0) {
  const data = await fetchJSON(`${base}/table/v1/driving/${coordStr(points)}?annotations=duration,distance${row0 ? '&sources=0' : ''}`);
  return { durations: data.durations, distances: data.distances };
}

async function valhallaTable(points, row0) {
  const locs = points.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) }));
  const body = { sources: row0 ? [locs[0]] : locs, targets: locs, costing: 'pedestrian' };
  const data = await fetchJSON(`${VALHALLA}/sources_to_targets?json=${encodeURIComponent(JSON.stringify(body))}`);
  const rows = data.sources_to_targets;
  return {
    durations: rows.map((r) => r.map((c) => c.time ?? null)),
    distances: rows.map((r) => r.map((c) => (c.distance == null ? null : c.distance * 1000))),
  };
}

function rawTable(profile, points, row0) {
  if (profile === 'car') return firstOk(CAR_SERVERS.map((b) => () => osrmTable(b, points, row0)));
  return firstOk([() => valhallaTable(points, row0), () => osrmTable(FOOT_OSRM, points, row0)]);
}

// 从 origin 到每个地方的真实路程（开车或走路），一次请求最多 90 个；结果存在记忆里
const rowCache = new Map();
export async function travelRow(profile, origin, dests) {
  const key = (d) => `${profile}|${origin.lat.toFixed(5)},${origin.lon.toFixed(5)}|${d.lat.toFixed(5)},${d.lon.toFixed(5)}`;
  const need = dests.filter((d) => !rowCache.has(key(d)));
  for (let i = 0; i < need.length; i += 90) {
    const chunk = need.slice(i, i + 90);
    const data = await rawTable(profile, [origin, ...chunk], true);
    chunk.forEach((d, k) => {
      const dur = data.durations[0][k + 1];
      const dist = data.distances[0][k + 1];
      rowCache.set(key(d), dur == null || dist == null ? null : { dur: dur * 1000, dist });
    });
  }
  return dests.map((d) => rowCache.get(key(d)) || null);
}

// 地点之间的交通时间存在手机里。免费服务器没有实时塞车资料，
// 所以两个固定地点之间的时间不会变，算过一次就不用再问。
const PAIR_KEY = 'shunlu:pairs:v2';
const PAIR_MAX = 6000;
let pairCache;
try {
  pairCache = new Map(JSON.parse(localStorage.getItem(PAIR_KEY)) || []);
} catch {
  pairCache = new Map();
}
function savePairs() {
  try {
    localStorage.setItem(PAIR_KEY, JSON.stringify([...pairCache].slice(-PAIR_MAX)));
  } catch {}
}
const ptKey = (p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`;
const pairKey = (pr, a, b) => `${pr}|${ptKey(a)}|${ptKey(b)}`;

// 所有点两两之间的交通时间（秒）和距离（米）
// firstIsLive = true 表示第 0 个点是现在的 GPS 位置（每次都不一样，不存）
export async function travelTable(profile, points, firstIsLive = false) {
  const n = points.length;
  const durations = points.map(() => new Array(n).fill(null));
  const distances = points.map(() => new Array(n).fill(null));
  const fixedFrom = firstIsLive ? 1 : 0;
  let missingFixed = false;
  for (let i = 0; i < n; i++) {
    durations[i][i] = 0;
    distances[i][i] = 0;
    for (let j = 0; j < n; j++) {
      if (i === j || i < fixedFrom || j < fixedFrom) continue;
      const c = pairCache.get(pairKey(profile, points[i], points[j]));
      if (c) [durations[i][j], distances[i][j]] = c;
      else missingFixed = true;
    }
  }

  if (missingFixed) {
    // 有新地点：整张表问一次。没网络 / 服务挂了：存过的照用，没存过的用直线估计
    let data;
    try {
      data = await rawTable(profile, points, false);
    } catch (e) {
      const est = estimateTable(profile, points);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (durations[i][j] == null) {
            durations[i][j] = est.durations[i][j];
            distances[i][j] = est.distances[i][j];
          }
        }
      }
      return { durations, distances, estimated: true, error: e };
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        durations[i][j] = data.durations[i][j];
        distances[i][j] = data.distances[i][j];
        if (i !== j && i >= fixedFrom && j >= fixedFrom && data.durations[i][j] != null) {
          pairCache.set(pairKey(profile, points[i], points[j]), [data.durations[i][j], data.distances[i][j]]);
        }
      }
    }
    savePairs();
  } else if (firstIsLive && n > 1) {
    // 地点都算过了：只问"现在的位置 → 每个地点"，一次很小的请求（没网络就用直线估计）
    let data;
    try {
      data = await rawTable(profile, points, true);
    } catch (e) {
      const est = estimateTable(profile, points);
      data = { durations: [est.durations[0]], distances: [est.distances[0]] };
      for (let j = 0; j < n; j++) {
        durations[0][j] = data.durations[0][j];
        distances[0][j] = data.distances[0][j];
      }
      return { durations, distances, estimated: true, error: e };
    }
    for (let j = 0; j < n; j++) {
      durations[0][j] = data.durations[0][j];
      distances[0][j] = data.distances[0][j];
      durations[j][0] = data.durations[0][j]; // 不会用到（不会走回 GPS 位置），只是填满
      distances[j][0] = data.distances[0][j];
    }
  }
  return { durations, distances };
}

/* ---- 路线形状 ---- */

async function osrmLine(base, points) {
  const data = await fetchJSON(`${base}/route/v1/driving/${coordStr(points)}?overview=full&geometries=geojson&steps=false`);
  return data.routes[0].geometry.coordinates;
}

// Valhalla 的路线用 polyline6 编码
function decodePolyline6(str) {
  const out = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < str.length) {
    for (let which = 0; which < 2; which++) {
      let shift = 0;
      let result = 0;
      let b;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lon += d;
    }
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

// 任何精度的 polyline（公共交通用精度 7）。用一般加减乘除，不用位运算：
// 精度 7 时第一个点的数字会超过 32 位，位运算会算错
function decodePolyline(str, precision) {
  const out = [];
  const f = 10 ** precision;
  let i = 0;
  let lat = 0;
  let lon = 0;
  while (i < str.length) {
    for (let which = 0; which < 2; which++) {
      let mult = 1;
      let result = 0;
      let b;
      do {
        b = str.charCodeAt(i++) - 63;
        result += (b & 0x1f) * mult;
        mult *= 32;
      } while (b >= 0x20);
      const d = result % 2 ? -(result + 1) / 2 : result / 2;
      if (which === 0) lat += d;
      else lon += d;
    }
    out.push([+(lon / f).toFixed(5), +(lat / f).toFixed(5)]);
  }
  return out;
}

/* ---- 公共交通（Transitous：免费、开源的公共交通路线服务） ---- */

const TRANSIT_KEY = 'shunlu:transit:v1';
let transitCache;
try {
  transitCache = new Map(JSON.parse(localStorage.getItem(TRANSIT_KEY)) || []);
} catch {
  transitCache = new Map();
}

// 从 a 到 b、在 time 出发，搭公共交通怎么走。找不到就返回 null
// 结果按「两点 + 星期几 + 小时」存起来（班次每天差不多）
export async function transitPlan(a, b, time) {
  const d = new Date(time);
  const key = `${a.lat.toFixed(4)},${a.lon.toFixed(4)}|${b.lat.toFixed(4)},${b.lon.toFixed(4)}|${d.getDay()}|${d.getHours()}`;
  if (transitCache.has(key)) return transitCache.get(key);
  const params = new URLSearchParams({ fromPlace: `${a.lat},${a.lon}`, toPlace: `${b.lat},${b.lon}`, time: d.toISOString() });
  const data = await fetchJSON(`https://api.transitous.org/api/v1/plan?${params}`);
  const its = (data.itineraries || []).filter((it) => it.legs.some((l) => l.mode !== 'WALK'));
  let out = null;
  if (its.length) {
    // 最早到的那个
    const best = its.reduce((x, y) => (new Date(y.endTime) < new Date(x.endTime) ? y : x));
    const wait = Math.max(0, new Date(best.startTime) - d);
    out = {
      dur: best.duration * 1000 + wait,
      legs: best.legs.map((l) => ({
        mode: l.mode,
        route: l.routeShortName || l.routeLongName || '',
        headsign: l.headsign || '',
        from: l.from?.name === 'START' ? '' : l.from?.name || '',
        to: l.to?.name === 'END' ? '' : l.to?.name || '',
        dur: l.duration * 1000,
        color: l.routeColor ? `#${l.routeColor}` : null,
        coords: l.legGeometry?.points ? decodePolyline(l.legGeometry.points, l.legGeometry.precision || 7) : [],
      })),
    };
  }
  transitCache.set(key, out);
  while (transitCache.size > 300) transitCache.delete(transitCache.keys().next().value);
  try {
    localStorage.setItem(TRANSIT_KEY, JSON.stringify([...transitCache]));
  } catch {}
  return out;
}

async function valhallaLine(points) {
  const body = {
    locations: points.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })),
    costing: 'pedestrian',
    directions_type: 'none',
  };
  const data = await fetchJSON(`${VALHALLA}/route?json=${encodeURIComponent(JSON.stringify(body))}`);
  return data.trip.legs.flatMap((l) => decodePolyline6(l.shape));
}

// 同样的一段路线画过就记住（最多 40 段）
const LINE_KEY = 'shunlu:lines:v2';
let lineCache;
try {
  lineCache = new Map(JSON.parse(localStorage.getItem(LINE_KEY)) || []);
} catch {
  lineCache = new Map();
}

// 按顺序经过这些点的路线形状
export async function routeLine(profile, points) {
  const key = `${profile}|${coordStr(points)}`;
  if (lineCache.has(key)) return lineCache.get(key);
  const raw = profile === 'car'
    ? await firstOk(CAR_SERVERS.map((b) => () => osrmLine(b, points)))
    : await firstOk([() => valhallaLine(points), () => osrmLine(FOOT_OSRM, points)]);
  const coords = raw.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]);
  lineCache.delete(key);
  lineCache.set(key, coords);
  while (lineCache.size > 40) lineCache.delete(lineCache.keys().next().value);
  try {
    localStorage.setItem(LINE_KEY, JSON.stringify([...lineCache]));
  } catch {}
  return coords;
}

// 没有网络时的粗略估计：直线距离 × 1.3 的绕路系数
export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function estimateTable(profile, points) {
  const speed = profile === 'car' ? 30 / 3.6 : 4.5 / 3.6; // 米/秒
  const distances = points.map((a) => points.map((b) => haversine(a, b) * 1.3));
  const durations = distances.map((row) => row.map((d) => d / speed));
  return { durations, distances };
}
