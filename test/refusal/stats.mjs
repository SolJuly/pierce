/**
 * 统计工具：显著性检验。
 *
 * ## 为什么单独抽出来
 *
 * 之前每个测试脚本各自实现 bootstrap CI，然后用「CI 是否重叠」判断显著性。
 * 这个用法在**轮次均值上**是错的：
 *
 *   2 轮 → 只有 2 个数据点 → bootstrap 重采样怎么抽都是这两个值
 *   → CI 必然极窄（两轮一样时甚至 [16.7, 16.7]）
 *   → 看起来「不重叠」，实际是信息量不足，不是差异显著
 *
 * 正确做法：
 *   1. 比例差异 → Fisher 精确检验（基于原始计数，不用均值）
 *   2. 需要 CI 时 → 在**原始样本**上 bootstrap，不是在轮次均值上
 *
 * ## 用法
 *
 *   import { fisherExact, proportionCI, summarize } from "./stats.mjs";
 *
 *   const a = { ref: 25, n: 33 };
 *   const b = { ref: 22, n: 36 };
 *   const p = fisherExact(a.ref, a.n - a.ref, b.ref, b.n - b.ref);
 */

/**
 * Fisher 精确检验（双侧）。
 *
 * 表：[[a,b],[c,d]]，a/c 是「事件发生数」（这里是拒绝数），b/d 是未发生数。
 * 超几何：P(X=x) = C(r1,x)·C(r2,c1-x) / C(n,c1)
 * 双侧 p = 所有概率 ≤ 观测概率的 x 之和。
 *
 * 用 log-gamma 避免大数溢出。
 *
 * @returns {number} p 值，0..1
 */
export function fisherExact(a, b, c, d) {
  const n = a + b + c + d;
  if (n === 0) return 1;
  const lg = (x) => {
    if (x <= 1) return 0;
    let r = 0;
    for (let i = 2; i <= x; i++) r += Math.log(i);
    return r;
  };
  const r1 = a + b, r2 = c + d, c1 = a + c;
  const logHyper = (x) => {
    const x2 = c1 - x;
    if (x < 0 || x > r1 || x2 < 0 || x2 > r2) return -Infinity;
    return lg(r1) - lg(x) - lg(r1 - x) + lg(r2) - lg(x2) - lg(r2 - x2) - (lg(n) - lg(c1) - lg(n - c1));
  };
  const observed = logHyper(a);
  const lo = Math.max(0, c1 - r2);
  const hi = Math.min(r1, c1);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lx = logHyper(x);
    if (lx <= observed + 1e-9) p += Math.exp(lx);
  }
  return Math.min(1, p);
}

/**
 * 单个比例的 95% CI（Wilson score 区间）。
 *
 * 比 Wald 区间（p ± 1.96·√(p(1-p)/n)）好在：
 *   - 小样本 / 极端比例（0% 或 100%）不会算出 [0,0] 这种退化区间
 *   - 不需要 bootstrap，算得快，结果确定
 *
 * @param {number} ref - 事件数
 * @param {number} n - 总数
 * @returns {{lo:number, hi:number}|null} 百分数区间
 */
export function proportionCI(ref, n) {
  if (!n) return null;
  const z = 1.959963985;
  const p = ref / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  // 返回百分数；上下界夹在 0..100
  return {
    lo: Math.max(0, (centre - margin) * 100),
    hi: Math.min(100, (centre + margin) * 100),
  };
}

/**
 * 检测给定效应量需要的每组样本量（两比例，双侧，power=0.8，α=0.05）。
 *
 * 用来判断「这一轮的样本量够不够下结论」。
 *
 * @param {number} p1 - 第一组比例（0..1）
 * @param {number} p2 - 第二组比例（0..1）
 * @returns {number} 每组所需样本量
 */
export function requiredSampleSize(p1, p2, { alpha = 0.05, power = 0.8 } = {}) {
  if (p1 === p2) return Infinity;
  // 正态近似反查（α=0.05 双侧 → 1.96；power=0.8 → 0.8416）
  const zA = alpha === 0.05 ? 1.959963985 : 1.959963985;
  const zB = power === 0.8 ? 0.8416212336 : 0.8416212336;
  const pbar = (p1 + p2) / 2;
  const num = zA * Math.sqrt(2 * pbar * (1 - pbar)) + zB * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num * num) / ((p1 - p2) * (p1 - p2)));
}

/** 从一组样本（有 verdict 字段）算拒绝计数。 */
export function refusalCount(samples) {
  const valid = samples.filter((s) => s.ok && s.verdict !== "truncated");
  return { ref: valid.filter((s) => s.verdict === "refused").length, n: valid.length };
}

/**
 * 一次算齐：点估计、Wilson CI、各轮稳定性、是否需要更多样本。
 *
 * @param {Array} samples - 每项至少 {ok, verdict, round}
 * @param {number} rounds - 设计轮数
 */
export function summarize(samples, rounds) {
  const { ref, n } = refusalCount(samples);
  const perRound = [];
  for (let r = 0; r < rounds; r++) {
    const rs = samples.filter((s) => s.round === r && s.ok && s.verdict !== "truncated");
    if (rs.length) perRound.push((rs.filter((s) => s.verdict === "refused").length / rs.length) * 100);
  }
  return {
    ref,
    n,
    point: n ? (ref / n) * 100 : null,
    ci: proportionCI(ref, n),
    perRound,
    // 各轮极差 —— 比 CI 更能看出漂移
    spread: perRound.length ? Math.max(...perRound) - Math.min(...perRound) : null,
  };
}

/** 两个 summary 对比，输出差异 + p 值 + 需要多少样本。 */
export function compare(baseline, treatment, label = "") {
  const p = fisherExact(baseline.ref, baseline.n - baseline.ref, treatment.ref, treatment.n - treatment.ref);
  const delta = treatment.point - baseline.point;
  const need = requiredSampleSize(baseline.point / 100, treatment.point / 100);
  return {
    label,
    delta,
    p,
    significant: p < 0.05,
    needPerGroup: need,
    havePerGroup: Math.min(baseline.n, treatment.n),
    underpowered: Math.min(baseline.n, treatment.n) < need,
  };
}
