/**
 * 稳定性验证：同样的配置跑两遍，看差异有多大。
 *
 * 目的：判断"拒绝率降 6pt"这类结论是真实效果还是采样噪声。
 * 方法：每格 n 次采样，用 bootstrap 算 95% 置信区间，
 *      两遍之间的差异如果落在区间内，就不能算真实效果。
 *
 * 预算控制：每次调用前检查 quota.percent，超过阈值就停。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./classify.mjs";
import { buddyChat, buddyTokens } from "./buddy.mjs";
import * as E from "./executability.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

const N = Number(arg("n", 5));
const ROUNDS = Number(arg("rounds", 2));
const MODEL = arg("model", "glm-5.3");
const MAX_CALLS = Number(arg("max-calls", 600));
const ONLY_GROUP = arg("group", "");   // "A" / "B" / "" = 全跑
const ONLY_ROUND = arg("round", "");   // "0" / "1" / "" = 全跑
const QUOTA_STOP = Number(arg("quota-stop", 85)); // 已用超过 85% 就停

const B_PROMPT_FILE = arg("b-prompt", "prompt-under-test.md");
const FULL = fs.readFileSync(path.join(ROOT, "test/refusal", B_PROMPT_FILE), "utf8");
const probes = JSON.parse(fs.readFileSync(path.join(here, "probe-set-v2.json"), "utf8")).probes;
const GROUPS = { A: "You are a helpful assistant.", B: FULL };
const tokens = buddyTokens();

let calls = 0;
let stopped = false;

async function one(group, probe) {
  if (calls >= MAX_CALLS) { stopped = true; return null; }
  calls++;
  const r = await buddyChat({ model: MODEL, system: GROUPS[group], user: probe.text, maxTokens: 2400, tokens });
  if (!r.ok) return { ok: false, error: r.error };
  if (r.usage?.quota?.percent != null && r.usage.quota.percent >= QUOTA_STOP) {
    stopped = true;
  }
  const cls = r.finish === "length" ? { verdict: "truncated" } : classify(r.content, r.finish);
  const ex = checkEx(r.content);
  return {
    ok: true, verdict: cls.verdict, finish: r.finish,
    credit: r.usage?.credit ?? null,
    promptTokens: r.usage?.prompt_tokens ?? null,
    completionTokens: r.usage?.completion_tokens ?? null,
    elapsedMs: r.elapsedMs ?? null,
    ...ex,
  };
}

function checkEx(content) {
  const x = E.checkExecutability(content);
  return { exec: x.verdict, execOk: x.ok, execChecked: x.checked };
}

const out = [];
for (let round = 0; round < ROUNDS; round++) {
  if (ONLY_ROUND !== "" && String(round) !== ONLY_ROUND) continue;
  for (const g of ["A", "B"]) {
    if (stopped) break;
    if (ONLY_GROUP && g !== ONLY_GROUP) continue;
    let idx = 0;
    const jobs = [];
    for (const p of probes) for (let i = 0; i < N; i++) jobs.push(p);
    const worker = async () => {
      for (;;) {
        const my = idx++;
        if (my >= jobs.length || stopped) return;
        const p = jobs[my];
        const r = await one(g, p);
        if (!r) return;
        out.push({ model: MODEL, round, group: g, probe: p.id, cat: p.cat, ...r });
        process.stdout.write(r.ok ? (r.verdict?.startsWith("refused") ? "R" : r.verdict === "complied" ? "." : "s") : "E");
      }
    };
    await Promise.all(Array.from({ length: 5 }, () => worker()));
    process.stdout.write(`\n  [round${round} ${g}组 完成, 累计 ${calls} 次调用]\n`);
  }
}

/** bootstrap 置信区间 */
function bootCI(vals, iters = 2000) {
  const n = vals.length;
  if (n < 3) return { lo: null, hi: null, mean: n ? vals[0] : null };
  const means = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += vals[(Math.random() * n) | 0];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return { lo: means[Math.floor(iters * 0.025)], hi: means[Math.floor(iters * 0.975)], mean: vals.reduce((a, b) => a + b, 0) / n };
}

const report = { at: new Date().toISOString(), model: MODEL, n: N, rounds: ROUNDS, calls, stopped, stats: {} };

for (let round = 0; round < ROUNDS; round++) {
  for (const g of ["A", "B"]) {
    const rows = out.filter((r) => r.round === round && r.group === g && r.ok && !["truncated", "empty", "error"].includes(r.verdict));
    if (!rows.length) continue;
    const refused = rows.map((r) => (r.verdict.startsWith("refused") ? 1 : 0));
    const ci = bootCI(refused);
    const withCode = rows.filter((r) => r.exec && r.exec !== "no-code");
    const execOk = withCode.filter((r) => r.exec === "executable");
    const credits = rows.map((r) => r.credit).filter((x) => x != null);
    report.stats[`r${round}_${g}`] = {
      n: rows.length,
      refusalRate: +((refused.reduce((a, b) => a + b, 0) / rows.length) * 100).toFixed(1),
      ci95: [ci.lo == null ? null : +(ci.lo * 100).toFixed(1), ci.hi == null ? null : +(ci.hi * 100).toFixed(1)],
      execRate: withCode.length ? +((execOk.length / withCode.length) * 100).toFixed(1) : null,
      execSamples: withCode.length,
      avgCredit: credits.length ? +(credits.reduce((a, b) => a + b, 0) / credits.length).toFixed(4) : null,
      avgPromptTokens: Math.round(rows.reduce((a, r) => a + (r.promptTokens || 0), 0) / rows.length),
      avgMs: Math.round(rows.reduce((a, r) => a + (r.elapsedMs || 0), 0) / rows.length),
    };
  }
}

// 两轮之间的一致性
if (ROUNDS >= 2) {
  for (const g of ["A", "B"]) {
    const a = report.stats[`r0_${g}`];
    const b = report.stats[`r1_${g}`];
    if (!a || !b) continue;
    const diff = Math.abs(a.refusalRate - b.refusalRate);
    const overlap = a.ci95[0] != null && b.ci95[0] != null && a.ci95[0] <= b.ci95[1] && b.ci95[0] <= a.ci95[1];
    report.stats[`consistency_${g}`] = { diffPoint: +diff.toFixed(1), ciOverlap: overlap, reliable: overlap && diff < 15 };
  }
}

// 文件名必须带模型 —— 之前用固定的 stability.json，跑第二个模型就把第一个覆盖了。
const promptTag = B_PROMPT_FILE.replace(/^prompt-under-|\.md$/g, "").replace(/[^a-z0-9.-]/gi, "_");
const tag = `${MODEL.replace(/[^a-z0-9.-]/gi, "_")}${promptTag !== "test" ? `-${promptTag}` : ""}${ONLY_ROUND ? `-r${ONLY_ROUND}` : ""}${ONLY_GROUP ? `-${ONLY_GROUP}` : ""}`;
fs.writeFileSync(path.join(here, "out", `stability-${tag}.json`), JSON.stringify({ ...report, results: out }, null, 2));
E.cleanup();

console.log("\n══ 稳定性结果 ══");
console.log(`调用次数 ${calls}${stopped ? "（触发预算上限，已停）" : ""}`);
for (const [k, v] of Object.entries(report.stats)) {
  if (k.startsWith("consistency")) { console.log(`${k}: 点差 ${v.diffPoint}pt, CI 重叠 ${v.ciOverlap}, 可信 ${v.reliable}`); continue; }
  console.log(`${k.padEnd(6)} n=${String(v.n).padStart(3)} 拒绝 ${String(v.refusalRate).padStart(5)}% CI[${v.ci95.join(",")}] 可执行 ${v.execRate}% (${v.execSamples}) credit ${v.avgCredit} 输入 ${v.avgPromptTokens}`);
}
