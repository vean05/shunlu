// 城市、热门景点、照片：全部来自免费服务（Wikidata、维基百科、OpenStreetMap），不用 API key

// 常用城市：不用搜索，按一下就好。bbox = [西, 南, 东, 北]
export const CITY_PRESETS = [
  { name: '槟城', flag: '🇲🇾', sub: '马来西亚', lat: 5.4141, lon: 100.3288, bbox: [100.17, 5.2, 100.55, 5.5] },
  { name: '吉隆坡', flag: '🇲🇾', sub: '马来西亚', lat: 3.1478, lon: 101.6953, bbox: [101.6, 3.03, 101.76, 3.25] },
  { name: '马六甲', flag: '🇲🇾', sub: '马来西亚', lat: 2.1944, lon: 102.2486, bbox: [102.17, 2.13, 102.32, 2.28] },
  { name: '新加坡', flag: '🇸🇬', sub: '新加坡', lat: 1.2903, lon: 103.8519, bbox: [103.6, 1.22, 104.05, 1.47] },
  { name: '曼谷', flag: '🇹🇭', sub: '泰国', lat: 13.7563, lon: 100.5018, bbox: [100.4, 13.65, 100.7, 13.85] },
  { name: '东京', flag: '🇯🇵', sub: '日本', lat: 35.6812, lon: 139.7671, bbox: [139.55, 35.55, 139.92, 35.8] },
  { name: '大阪', flag: '🇯🇵', sub: '日本', lat: 34.6937, lon: 135.5023, bbox: [135.4, 34.6, 135.6, 34.75] },
  { name: '首尔', flag: '🇰🇷', sub: '韩国', lat: 37.5665, lon: 126.978, bbox: [126.85, 37.45, 127.15, 37.65] },
  { name: '台北', flag: '🇹🇼', sub: '台湾', lat: 25.033, lon: 121.5654, bbox: [121.45, 24.98, 121.62, 25.12] },
  { name: '香港', flag: '🇭🇰', sub: '中国香港', lat: 22.2988, lon: 114.1722, bbox: [113.95, 22.2, 114.3, 22.42] },
];

// 范围太大（例如整个国家）会查得很慢：缩小到中心附近
export function clampBbox(lat, lon, bbox, maxSpan = 0.6) {
  let [w, s, e, n] = bbox;
  if (e - w > maxSpan) [w, e] = [lon - maxSpan / 2, lon + maxSpan / 2];
  if (n - s > maxSpan) [s, n] = [lat - maxSpan / 2, lat + maxSpan / 2];
  return [w, s, e, n].map((x) => +x.toFixed(4));
}

// 搜索城市 / 国家
export async function searchCities(q) {
  const params = new URLSearchParams({ q, format: 'jsonv2', limit: '8', 'accept-language': 'zh-CN,en' });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
  if (!res.ok) throw new Error(`搜索服务出错（${res.status}）`);
  const data = await res.json();
  return data
    .filter((r) => ['boundary', 'place'].includes(r.category) || ['administrative', 'city', 'town', 'state', 'country', 'island'].includes(r.type))
    .map((r) => {
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      const [s, n, w, e] = r.boundingbox.map(Number);
      const parts = r.display_name.split(',').map((x) => x.trim());
      return {
        name: r.name || parts[0],
        sub: parts.slice(1).filter((x) => !/^\d+$/.test(x)).slice(-2).join('，'),
        lat,
        lon,
        bigArea: e - w > 0.6 || n - s > 0.6,
        bbox: clampBbox(lat, lon, [w, s, e, n]),
      };
    });
}

/* ---------------- 热门景点（按维基百科语言版本数量排名，越多越有名） ---------------- */

// 不要的类型：道路、居民区、行政区、公司、医院、车站、学校、事件、水体、岛、机场、体育场
const EXCLUDE = 'wd:Q83620 wd:Q486972 wd:Q56061 wd:Q4830453 wd:Q16917 wd:Q55488 wd:Q3914 wd:Q1190554 wd:Q15324 wd:Q23442 wd:Q7188 wd:Q1248784 wd:Q483110';

function popularQuery([w, s, e, n]) {
  return `SELECT ?item ?links ?img ?zh ?en ?coord (SAMPLE(?tl) AS ?type) WHERE {
 SERVICE wikibase:box { ?item wdt:P625 ?coord.
   bd:serviceParam wikibase:cornerSouthWest "Point(${w} ${s})"^^geo:wktLiteral.
   bd:serviceParam wikibase:cornerNorthEast "Point(${e} ${n})"^^geo:wktLiteral. }
 ?item wikibase:sitelinks ?links. FILTER(?links >= 4)
 ?item wdt:P18 ?img.
 ?item wdt:P31 ?t. ?t rdfs:label ?tl FILTER(lang(?tl)="en")
 FILTER NOT EXISTS { ?item wdt:P31/wdt:P279* ?bad. VALUES ?bad { ${EXCLUDE} } }
 OPTIONAL{?item rdfs:label ?zh FILTER(lang(?zh)="zh")}
 OPTIONAL{?item rdfs:label ?en FILTER(lang(?en)="en")}
} GROUP BY ?item ?links ?img ?zh ?en ?coord ORDER BY DESC(?links) LIMIT 60`;
}

// 景点类型 → 分类
export function categoryOf(type = '') {
  const t = type.toLowerCase();
  if (/temple|mosque|church|cathedral|shrine|chapel|pagoda|kongsi|basilica|synagogue|monastery|clan/.test(t)) return '寺庙教堂';
  if (/museum|gallery/.test(t)) return '博物馆';
  if (/mall|shopping|market|outlet|store|shop/.test(t)) return '购物';
  if (/park|garden|mountain|hill|beach|waterfall|lake|dam|nature|reserve|forest|cave|bay|river/.test(t)) return '自然公园';
  return '建筑古迹';
}

const TYPE_ZH = [
  [/buddhist temple/, '佛寺'], [/taoist temple/, '道观'], [/hindu temple/, '印度庙'], [/chinese temple|clan/, '华人庙宇'],
  [/temple/, '寺庙'], [/mosque/, '清真寺'], [/cathedral/, '大教堂'], [/church/, '教堂'], [/shrine/, '神社'],
  [/art museum|gallery/, '美术馆'], [/museum/, '博物馆'], [/mall|shopping/, '商场'], [/outlet/, '奥特莱斯'], [/market/, '市场'],
  [/botanical garden/, '植物园'], [/park/, '公园'], [/mountain|hill/, '山'], [/beach/, '海滩'], [/waterfall/, '瀑布'],
  [/dam/, '水坝'], [/mansion|house/, '故居/大宅'], [/skyscraper|tower/, '高楼/塔'], [/clock tower/, '钟楼'],
  [/memorial|monument|cenotaph/, '纪念碑'], [/fort|castle/, '城堡/堡垒'], [/bridge/, '桥'], [/palace/, '宫殿'],
  [/hall|building/, '建筑'],
];
export function typeZh(type = '') {
  const t = type.toLowerCase();
  return TYPE_ZH.find(([re]) => re.test(t))?.[1] || type;
}

function commonsThumb(url, width = 400) {
  // http://commons.wikimedia.org/wiki/Special:FilePath/xxx.jpg → https + 指定宽度
  return `${url.replace(/^http:/, 'https:')}?width=${width}`;
}

const POP_KEY = 'shunlu:popular:v1';
const POP_TTL = 14 * 24 * 3600e3;

export async function fetchPopular(bbox) {
  const key = bbox.join(',');
  try {
    const cache = JSON.parse(localStorage.getItem(POP_KEY)) || {};
    if (cache[key] && Date.now() - cache[key].at < POP_TTL) return cache[key].items;
  } catch {}

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  let data;
  try {
    const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(popularQuery(bbox))}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/sparql-results+json' },
    });
    if (!res.ok) throw new Error(`热门景点服务出错（${res.status}）`);
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
  const seen = new Set();
  const items = [];
  for (const b of data.results.bindings) {
    const id = b.item.value.split('/').pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord.value);
    if (!m) continue;
    const zh = b.zh?.value;
    const en = b.en?.value;
    items.push({
      wikidata: id,
      name: zh || en || id,
      alt: zh && en && zh !== en ? en : '',
      en: en || zh || '',
      lat: Number(m[2]),
      lon: Number(m[1]),
      type: b.type?.value || '',
      kind: b.type?.value || '',
      photo: commonsThumb(b.img.value, 400),
      fame: Number(b.links.value),
      address: '',
      needsDetails: true,
    });
  }
  try {
    const cache = JSON.parse(localStorage.getItem(POP_KEY)) || {};
    cache[key] = { at: Date.now(), items };
    // 最多记 6 个城市
    const keys = Object.keys(cache).sort((a, b) => cache[b].at - cache[a].at);
    keys.slice(6).forEach((k) => delete cache[k]);
    localStorage.setItem(POP_KEY, JSON.stringify(cache));
  } catch {}
  return items;
}

/* ---------------- 搜索结果的照片 ---------------- */

const photoCache = new Map();

function tokens(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9一-鿿]+/)
    .filter((x) => x.length > 1 || /[一-鿿]/.test(x));
}

function distM(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lon - a.lon) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function wikidataPhoto(qid) {
  const res = await fetch(`https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=P18&format=json&origin=*`);
  const data = await res.json();
  const file = data.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  return file ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}?width=400` : null;
}

// 在维基百科找这个位置附近、名字相符的条目（拿照片和 Wikidata 编号）
const wikiMatchCache = new Map();
function matchWikiPage(r) {
  const key = `${r.lat.toFixed(5)},${r.lon.toFixed(5)}|${r.name}`;
  if (wikiMatchCache.has(key)) return wikiMatchCache.get(key);
  const job = (async () => {
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*', generator: 'geosearch',
      ggscoord: `${r.lat}|${r.lon}`, ggsradius: '400', ggslimit: '10',
      prop: 'pageimages|coordinates|pageprops', piprop: 'thumbnail', pithumbsize: '400', ppprop: 'wikibase_item',
    });
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
    const data = await res.json();
    const pages = Object.values(data.query?.pages || {}).filter((p) => p.coordinates?.[0]);
    const want = new Set([...tokens(r.name), ...tokens(r.alt || r.en)]);
    let best = null;
    let bestScore = 0;
    for (const p of pages) {
      const tt = tokens(p.title);
      const shared = tt.filter((t) => want.has(t)).length;
      const d = distM(r, { lat: p.coordinates[0].lat, lon: p.coordinates[0].lon });
      const score = (want.size ? shared / Math.min(want.size, tt.length || 1) : 0) + (d < 40 ? 0.5 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (bestScore < 0.5) return null;
    return { thumb: best.thumbnail?.source || null, qid: best.pageprops?.wikibase_item || null, title: best.title };
  })().catch(() => null);
  wikiMatchCache.set(key, job);
  return job;
}

// 返回照片网址，找不到就返回 null（界面会改用地图小图）
export async function findPhoto(r) {
  if (r.photo) return r.photo;
  const key = r.wikidata || r.osm || `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
  if (photoCache.has(key)) return photoCache.get(key);
  const job = (async () => {
    try {
      if (r.wikidata) {
        const p = await wikidataPhoto(r.wikidata);
        if (p) return p;
      }
      return (await matchWikiPage(r))?.thumb || null;
    } catch {
      return null;
    }
  })();
  photoCache.set(key, job);
  return job;
}

/* ---------------- 景点详情：多张照片、维基百科介绍、官网 ---------------- */

const detailCache = new Map();
const IMG_RE = /\.(jpe?g|png|webp)$/i;

async function wikiExtract(lang, title) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', prop: 'extracts', exintro: '1', explaintext: '1', exchars: '600', titles: title,
  });
  if (lang === 'zh') params.set('variant', 'zh-cn');
  const data = await fetch(`https://${lang}.wikipedia.org/w/api.php?${params}`).then((x) => x.json());
  const text = Object.values(data.query?.pages || {})[0]?.extract || '';
  return text.replace(/\n+/g, '\n').trim();
}

async function commonsGallery(category, limit = 12) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'categorymembers', gcmtitle: `Category:${category}`,
    gcmtype: 'file', gcmlimit: '30', prop: 'imageinfo', iiprop: 'url', iiurlwidth: '800',
  });
  const data = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`).then((x) => x.json());
  return Object.values(data.query?.pages || {})
    .filter((p) => IMG_RE.test(p.title))
    .map((p) => p.imageinfo?.[0]?.thumburl)
    .filter(Boolean)
    .slice(0, limit);
}

// 返回 { description, extract, extractLang, wikiUrl, website, gallery[] }，找不到资料时各项为空
export function placeDetails(r) {
  const key = r.wikidata || r.osm || `${r.lat.toFixed(5)},${r.lon.toFixed(5)}`;
  if (detailCache.has(key)) return detailCache.get(key);
  const job = (async () => {
    const out = { description: '', extract: '', extractLang: '', wikiUrl: '', website: '', gallery: [] };
    const qid = r.wikidata || (await matchWikiPage(r))?.qid;
    if (!qid) return out;
    const params = new URLSearchParams({
      action: 'wbgetentities', ids: qid, props: 'sitelinks|claims|descriptions', languages: 'zh|en',
      sitefilter: 'zhwiki|enwiki', format: 'json', origin: '*',
    });
    const ent = (await fetch(`https://www.wikidata.org/w/api.php?${params}`).then((x) => x.json())).entities?.[qid];
    if (!ent) return out;
    const claim = (pid) => ent.claims?.[pid]?.[0]?.mainsnak?.datavalue?.value;
    out.description = ent.descriptions?.zh?.value || ent.descriptions?.en?.value || '';
    out.website = claim('P856') || '';
    const zhTitle = ent.sitelinks?.zhwiki?.title;
    const enTitle = ent.sitelinks?.enwiki?.title;
    const [extract, gallery] = await Promise.all([
      (async () => {
        if (zhTitle) {
          const t = await wikiExtract('zh', zhTitle).catch(() => '');
          if (t) return { text: t, lang: 'zh', url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(zhTitle)}` };
        }
        if (enTitle) {
          const t = await wikiExtract('en', enTitle).catch(() => '');
          if (t) return { text: t, lang: 'en', url: `https://en.wikipedia.org/wiki/${encodeURIComponent(enTitle)}` };
        }
        return null;
      })(),
      claim('P373') ? commonsGallery(claim('P373')).catch(() => []) : Promise.resolve([]),
    ]);
    if (extract) Object.assign(out, { extract: extract.text, extractLang: extract.lang, wikiUrl: extract.url });
    const main = claim('P18');
    const mainUrl = main ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(main)}?width=800` : null;
    out.gallery = [...(mainUrl ? [mainUrl] : []), ...gallery].slice(0, 12);
    return out;
  })().catch(() => ({ description: '', extract: '', extractLang: '', wikiUrl: '', website: '', gallery: [] }));
  detailCache.set(key, job);
  return job;
}

// 地图小图（OpenStreetMap 图块）：用来确认位置
export function tileThumb(lat, lon, z = 16) {
  const n = 2 ** z;
  const xf = ((lon + 180) / 360) * n;
  const latR = (lat * Math.PI) / 180;
  const yf = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  const x = Math.floor(xf);
  const y = Math.floor(yf);
  return { url: `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, px: xf - x, py: yf - y };
}

/* ---------------- 示例行程：槟城（测试用） ---------------- */

export function penangDemo() {
  return {
    name: '槟城 3 天示例（测试）',
    days: 3,
    dest: { ...CITY_PRESETS[0] },
    home: { name: '依恩奥酒店 Eastern & Oriental Hotel', address: '10 Lebuh Farquhar, George Town, Penang', lat: 5.4234635, lon: 100.3355596 },
    places: [
      { name: '极乐寺 Kek Lok Si', lat: 5.3997214, lon: 100.2738891, osm: 'N7175322691', wikidata: 'Q822518', kind: 'place_of_worship', hoursRaw: 'Mo-Su 08:30-18:30', stayMin: 90 },
      { name: '升旗山缆车下站 Penang Hill', lat: 5.4089, lon: 100.2778, wikidata: 'Q7162224', kind: 'attraction', hoursRaw: 'Mo-Su 06:30-23:00', stayMin: 150, note: '营业时间是大约的，出发前请确认' },
      { name: '龙山堂邱公司 Khoo Kongsi', lat: 5.4142654, lon: 100.337592, osm: 'N6832811985', wikidata: 'Q6402268', kind: 'place_of_worship', hoursRaw: 'Mo-Su 09:00-17:00', stayMin: 45 },
      { name: '张弼士故居（蓝屋）Cheong Fatt Tze Mansion', lat: 5.4215176, lon: 100.3347671, osm: 'W247175848', wikidata: 'Q5091627', kind: 'museum', hoursRaw: 'Mo-Su 11:00-16:30', stayMin: 60, note: '导览时间 11:00、14:00、15:30' },
      { name: '甲必丹吉灵清真寺 Kapitan Keling Mosque', lat: 5.4169528, lon: 100.33705, osm: 'W384337966', wikidata: 'Q3281165', kind: 'place_of_worship', stayMin: 20 },
      { name: '侨生博物馆 Pinang Peranakan Mansion', lat: 5.4177917, lon: 100.3411285, osm: 'R12433499', wikidata: 'Q28034427', kind: 'museum', hoursRaw: 'Mo-Su 09:30-17:00', stayMin: 60 },
      { name: '打铜仔街（壁画街）Armenian Street', lat: 5.4157748, lon: 100.3364302, osm: 'W578868861', kind: 'attraction', stayMin: 60 },
      { name: '槟城植物园 Penang Botanic Gardens', lat: 5.4381483, lon: 100.2910103, osm: 'W325187723', wikidata: 'Q7162208', kind: 'garden', hoursRaw: 'Mo-Su 05:00-20:00', stayMin: 60 },
      { name: '康华利斯堡 Fort Cornwallis', lat: 5.420449, lon: 100.34433, osm: 'R5827552', wikidata: 'Q5470991', kind: 'fort', hoursRaw: 'We-Mo 08:00-22:00; Tu 08:00-19:00', stayMin: 45 },
      { name: '姓周桥 Chew Jetty', lat: 5.411966, lon: 100.340031, osm: 'R13314976', kind: 'attraction', stayMin: 40 },
      { name: '槟城国家公园 Penang National Park', lat: 5.450402, lon: 100.197654, osm: 'R11204790', wikidata: 'Q7162231', kind: 'nature_reserve', hoursRaw: 'Mo-Su 07:30-18:00', stayMin: 180, note: '营业时间是大约的' },
      { name: '热带香料园 Tropical Spice Garden', lat: 5.463279, lon: 100.22929, osm: 'W1018568502', kind: 'garden', hoursRaw: 'Mo-Su 09:00-18:00', stayMin: 90, note: '营业时间是大约的' },
      { name: '世外逃园 ESCAPE Penang', lat: 5.448652, lon: 100.216632, osm: 'R13885747', kind: 'theme_park', hoursRaw: 'Tu-Su 10:00-18:00', stayMin: 180, note: '星期一休息' },
      { name: '峇都丁宜夜市 Batu Ferringhi Night Market', lat: 5.475062, lon: 100.250449, osm: 'N6923785585', kind: 'marketplace', hoursRaw: 'Mo-Su 18:00-24:00', stayMin: 90, note: '晚上才开' },
      { name: '新关仔角小贩中心 Gurney Drive Hawker Centre', lat: 5.437, lon: 100.3094, kind: 'food_court', hoursRaw: 'Mo-Su 17:00-24:00', stayMin: 60, note: '晚上才开，适合当晚餐' },
    ],
  };
}
