// 路线顺序优化：在手机里计算，不需要任何 API。
//
// 节点编号：0 = 起点，1..n = 要去的地点，n+1 = 终点（只有"回酒店"时才有）
// ctx = {
//   n,                     地点数量
//   travel(i, j),          i 到 j 的交通时间（毫秒）
//   startTime,             出发时间（毫秒时间戳）
//   stay[k],               第 k 个地点（1..n）停留时间（毫秒）
//   windows[k],            第 k 个地点营业窗口 [[openMs, closeMs], ...]，null = 不知道（当作一直开）
//   hasEnd,                是否要回到终点
//   meals,                 （可选）吃饭 [{ kind, start, dur }]，start 是想开始吃的时间
//   deadline,              （可选）最晚要到终点的时间（例如赶飞机），超过会加很重的罚分
// }
//
// 目标：总用时最短，同时尽量在营业时间内到达并玩完。
// 到了已关门的地方、或关门前玩不完，都会加罚分，算法会自动把它们往前排。

const CLOSED_PENALTY = 4 * 3600e3; // 到达时已关门：相当于多花 4 小时
const SHORT_FACTOR = 3; // 关门前玩不完：每少 1 分钟算 3 分钟

export function visit(ctx, k, t) {
  const stay = ctx.stay[k];
  const w = ctx.windows[k];
  const res = { arrive: t, start: t, depart: t + stay, wait: 0, penalty: 0, flag: null, win: null };
  if (!w) return res;
  const win = w.find(([, c]) => c > t);
  if (!win) {
    // 今天已经关门（或今天休息）：不停留，直接跳过
    res.depart = t;
    res.penalty = CLOSED_PENALTY;
    res.flag = 'closed';
    return res;
  }
  res.win = win;
  if (t < win[0]) {
    res.wait = win[0] - t;
    res.start = win[0];
    res.depart = win[0] + stay;
  }
  if (res.depart > win[1]) {
    res.penalty = (res.depart - win[1]) * SHORT_FACTOR;
    res.flag = 'short';
  }
  return res;
}

// 吃饭：上一站离开时间 t0 → 这一站玩完 d，如果跨过吃饭时间（提早 30 分钟也算），就在这一站附近吃
// 返回新的离开时间、罚分（太晚吃）和吃饭的时段
const MEAL_EARLY = 30 * 60e3;
const MEAL_LATE_OK = 90 * 60e3;
export function addMeals(ctx, t0, d) {
  let pen = 0;
  let list = null;
  for (const m of ctx.meals || []) {
    const from = m.start - MEAL_EARLY;
    if (t0 < from && d >= from) {
      const begin = d;
      if (begin > m.start + MEAL_LATE_OK) pen += begin - m.start - MEAL_LATE_OK;
      d = begin + m.dur;
      (list ||= []).push({ kind: m.kind, start: begin, end: d });
    }
  }
  return { d, pen, list };
}

// 赶时间（例如飞机）：最后到终点超过 deadline，每晚 1 分钟算 5 分钟
const LATE_FACTOR = 5;
const latePenalty = (ctx, t) => (ctx.deadline && t > ctx.deadline ? (t - ctx.deadline) * LATE_FACTOR : 0);

// 按给定顺序模拟一遍，算出时间表和总成本
export function evaluate(ctx, order) {
  let t = ctx.startTime;
  let prev = 0;
  let penalty = 0;
  const stops = [];
  for (const k of order) {
    const t0 = t;
    t += ctx.travel(prev, k);
    const v = visit(ctx, k, t);
    const m = addMeals(ctx, t0, v.depart);
    penalty += v.penalty + m.pen;
    stops.push({ k, ...v, meals: m.list });
    t = m.d;
    prev = k;
  }
  let endArrive = null;
  if (ctx.hasEnd) {
    t += ctx.travel(prev, ctx.n + 1);
    endArrive = t;
  }
  penalty += latePenalty(ctx, t);
  return { cost: t - ctx.startTime + penalty, finish: endArrive ?? t, penalty, stops, endArrive };
}

// 动态规划（Held-Karp 的变形）：状态 = (已去过的地点集合, 最后一个地点)
// 15 个点以内在手机上也不到一秒
function solveDP(ctx) {
  const n = ctx.n;
  const FULL = 1 << n;
  const size = FULL * n;
  const cost = new Float64Array(size).fill(Infinity);
  const time = new Float64Array(size);
  const parent = new Int8Array(size).fill(-1);

  for (let j = 0; j < n; j++) {
    const v = visit(ctx, j + 1, ctx.startTime + ctx.travel(0, j + 1));
    const m = addMeals(ctx, ctx.startTime, v.depart);
    const idx = (1 << j) * n + j;
    cost[idx] = m.d - ctx.startTime + v.penalty + m.pen;
    time[idx] = m.d;
  }

  for (let mask = 1; mask < FULL; mask++) {
    for (let last = 0; last < n; last++) {
      if (!(mask & (1 << last))) continue;
      const cur = mask * n + last;
      const c0 = cost[cur];
      if (c0 === Infinity) continue;
      const t0 = time[cur];
      for (let nxt = 0; nxt < n; nxt++) {
        if (mask & (1 << nxt)) continue;
        const v = visit(ctx, nxt + 1, t0 + ctx.travel(last + 1, nxt + 1));
        const m = addMeals(ctx, t0, v.depart);
        const c = c0 + (m.d - t0) + v.penalty + m.pen;
        const ni = (mask | (1 << nxt)) * n + nxt;
        if (c < cost[ni]) {
          cost[ni] = c;
          time[ni] = m.d;
          parent[ni] = last;
        }
      }
    }
  }

  let best = Infinity;
  let bestLast = -1;
  for (let last = 0; last < n; last++) {
    const i = (FULL - 1) * n + last;
    const back = ctx.hasEnd ? ctx.travel(last + 1, n + 1) : 0;
    const c = cost[i] + back + latePenalty(ctx, time[i] + back);
    if (c < best) {
      best = c;
      bestLast = last;
    }
  }

  const order = [];
  let mask = FULL - 1;
  let last = bestLast;
  while (last >= 0) {
    order.push(last + 1);
    const p = parent[mask * n + last];
    mask &= ~(1 << last);
    last = p;
  }
  return order.reverse();
}

// 点很多时：贪心起步 + 局部改良（2-opt 反转、单点搬移），结果接近最优
function solveHeuristic(ctx) {
  const n = ctx.n;
  const remaining = new Set(Array.from({ length: n }, (_, i) => i + 1));
  const order = [];
  while (remaining.size) {
    let bestK = -1;
    let bestC = Infinity;
    for (const k of remaining) {
      const c = evaluate(ctx, [...order, k]).cost;
      if (c < bestC) {
        bestC = c;
        bestK = k;
      }
    }
    order.push(bestK);
    remaining.delete(bestK);
  }

  let cur = order;
  let curCost = evaluate(ctx, cur).cost;
  let improved = true;
  let rounds = 0;
  while (improved && rounds++ < 50) {
    improved = false;
    // 2-opt
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const cand = [...cur.slice(0, i), ...cur.slice(i, j + 1).reverse(), ...cur.slice(j + 1)];
        const c = evaluate(ctx, cand).cost;
        if (c < curCost - 1) {
          cur = cand;
          curCost = c;
          improved = true;
        }
      }
    }
    // 把一个点搬到别的位置
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const cand = [...cur];
        const [x] = cand.splice(i, 1);
        cand.splice(j, 0, x);
        const c = evaluate(ctx, cand).cost;
        if (c < curCost - 1) {
          cur = cand;
          curCost = c;
          improved = true;
        }
      }
    }
  }
  return cur;
}

export function optimize(ctx) {
  if (ctx.n === 0) return { order: [], ...evaluate(ctx, []) };
  const order = ctx.n <= 15 ? solveDP(ctx) : solveHeuristic(ctx);
  return { order, ...evaluate(ctx, order) };
}
