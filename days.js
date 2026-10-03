// 多天安排：把地点分到每一天（不需要 AI，是一般的分组 + 改良算法）
//
// 做法：
//   1. 以住的地方为中心，按方向把地点排一圈，切成 N 段 → 同一个方向的地方放同一天
//      （试几个不同的起点，挑总成本最低的）
//   2. 再一个一个试：把某个地点搬到别天、或两天互换一个地点，变好就保留
//   每一天的成本 = 那天走完要多久（已经算好最佳顺序）
//                + 太晚回来的罚分 + 当天休息 / 关门的罚分 + 跟平均差太多的罚分
//
// input = {
//   n,               地点数量（编号 0..n-1）
//   days,            天数
//   angle[k],        地点相对住的地方的方向（弧度）
//   load[k],         地点的停留时间（用来平均分配）
//   locked[k],       固定在第几天（0..days-1），没固定是 -1
//   dayCost(d, ks),  算第 d 天去 ks 这些地点的成本
// }
// 返回 assign[k] = 第几天（0..days-1）

export function arrangeDays({ n, days, angle, load, locked, dayCost, init = null }) {
  if (days <= 1) return new Array(n).fill(0);
  const cache = new Map();
  const costOf = (d, ks) => {
    const key = `${d}|${[...ks].sort((a, b) => a - b).join(',')}`;
    if (!cache.has(key)) cache.set(key, dayCost(d, ks));
    return cache.get(key);
  };
  const groups = (assign) => {
    const g = Array.from({ length: days }, () => []);
    assign.forEach((d, k) => g[d].push(k));
    return g;
  };
  const total = (assign) => groups(assign).reduce((sum, ks, d) => sum + costOf(d, ks), 0);

  // 1. 按方向切段（固定的先放好）
  const free = [];
  for (let k = 0; k < n; k++) if (locked[k] < 0) free.push(k);
  const byAngle = [...free].sort((a, b) => angle[a] - angle[b]);
  const totalLoad = free.reduce((s, k) => s + load[k], 0) || 1;
  const lockedLoad = new Array(days).fill(0);
  for (let k = 0; k < n; k++) if (locked[k] >= 0) lockedLoad[locked[k]] += load[k];

  // 起始分法：按方向切成 N 段，试不同的起点；每段放哪一天也试不同的排法
  //（每天住不同酒店、或某天有地方休息时，哪一段放哪一天会差很多）
  const perms = permutations(days);
  const cands = [];
  const tries = Math.min(byAngle.length || 1, 10);
  for (let t = 0; t < tries; t++) {
    const start = Math.floor((t * byAngle.length) / tries);
    const order = [...byAngle.slice(start), ...byAngle.slice(0, start)];
    const chunk = locked.map((d) => (d >= 0 ? d : 0));
    const target = (totalLoad + lockedLoad.reduce((a, b) => a + b, 0)) / days;
    let d = 0;
    let acc = lockedLoad[0];
    for (const k of order) {
      // 这一段满了就换下一段（最后一段收剩下的）
      while (d < days - 1 && acc + load[k] / 2 > target) {
        d++;
        acc = lockedLoad[d];
      }
      chunk[k] = d;
      acc += load[k];
    }
    for (const perm of perms) {
      const assign = chunk.map((c, k) => (locked[k] >= 0 ? locked[k] : perm[c]));
      cands.push({ assign, cost: total(assign) });
    }
  }
  // 外面给的起始分配（例如每天住不同酒店时，按离酒店远近分）也放进来
  if (init) {
    const assign = init.map((d, k) => (locked[k] >= 0 ? locked[k] : d));
    cands.push({ assign, cost: total(assign) });
  }

  // 2. 挑最好的几个起始分法，各自做局部改良，留下最好的结果
  cands.sort((x, y) => x.cost - y.cost);
  let best = null;
  let bestCost = Infinity;
  for (const c of cands.slice(0, 5)) {
    const a = improve([...c.assign]);
    const cost = total(a);
    if (cost < bestCost) {
      bestCost = cost;
      best = a;
    }
  }
  return best;

  // 局部改良：搬一个 / 换两个，直到没有更好
  function improve(best) {
    let improved = true;
    let rounds = 0;
    while (improved && rounds++ < 30) {
      improved = false;
      const g = groups(best);
      for (const k of free) {
        const from = best[k];
        for (let to = 0; to < days; to++) {
          if (to === from) continue;
          const before = costOf(from, g[from]) + costOf(to, g[to]);
          const fromKs = g[from].filter((x) => x !== k);
          const toKs = [...g[to], k];
          const after = costOf(from, fromKs) + costOf(to, toKs);
          if (after < before - 1000) {
            best[k] = to;
            g[from] = fromKs;
            g[to] = toKs;
            improved = true;
            break;
          }
        }
      }
      for (let i = 0; i < free.length; i++) {
        for (let j = i + 1; j < free.length; j++) {
          const a = free[i];
          const b = free[j];
          const da = best[a];
          const db = best[b];
          if (da === db) continue;
          const before = costOf(da, g[da]) + costOf(db, g[db]);
          const aKs = [...g[da].filter((x) => x !== a), b];
          const bKs = [...g[db].filter((x) => x !== b), a];
          const after = costOf(da, aKs) + costOf(db, bKs);
          if (after < before - 1000) {
            best[a] = db;
            best[b] = da;
            g[da] = aKs;
            g[db] = bKs;
            improved = true;
          }
        }
      }
    }
    return best;
  }
}

// 每段放哪一天的排法：4 天以内试全部，多于 4 天只试依序和倒序
function permutations(n) {
  const id = [...Array(n).keys()];
  if (n > 4) return [id, [...id].reverse()];
  const out = [];
  const go = (rest, cur) => {
    if (!rest.length) return out.push(cur);
    rest.forEach((x, i) => go([...rest.slice(0, i), ...rest.slice(i + 1)], [...cur, x]));
  };
  go(id, []);
  return out;
}
