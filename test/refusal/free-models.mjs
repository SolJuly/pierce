/**
 * 用插件自带的免费通道跑拒绝率。
 * Kilo 网关匿名可用、不计费，可以大样本反复跑 —— 这正是之前用付费 API 时做不到的。
 *
 * 用法：node test/refusal/free-models.mjs [--n 3] [--models a,b,c]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./classify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const N = Number(arg("n", 3));
const TERMINAL = Number(arg("timeout", 90));

const BASE = "https://api.kilo.ai/api/gateway";
const FULL = fs.readFileSync(path.join(ROOT, "test/refusal/prompt-under-test.md"), "utf8");
const probes = JSON.parse(fs.readFileSync(path.join(here, "probe-set.json"), "utf8")).probes;

// 实测能稳定出正文的免费模型（其余要么 429，要么把 token 全吃在推理上）
const DEFAULT_MODELS = [
  "cohere/north-mini-code:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "thinkingmachines/inkling-2-small:free",
  "liquid/lfm-3-1.7b:free",
];
const models = arg("models", "") ? arg("models").split(",") : DEFAULT_MODELS;

const GROUPS = {
  A: "You are a helpful assistant.",
  B: FULL,
};

async function call(system, user, model) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TERMINAL * 1000);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 1600, temperature: 0.7 }),
      signal: ctl.signal,
    });
    const j = await res.json();
    if (j.error) return { ok: false, error: `API ${j.error.code || ""}: ${String(j.error.message || "").slice(0, 120)}` };
    const c = j.choices?.[0];
    if (!c) return { ok: false, error: "no choices" };
    return { ok: true, content: c.message?.content ?? "", reasoning: c.message?.reasoning ?? "", finish: c.finish_reason };
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "timeout" : String(e.message).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const model of models) {
  for (const [g, sys] of Object.entries(GROUPS)) {
    // 先探一次：模型不可用就直接跳过整组，别浪费 40 次调用
    const probe = await call(sys, probes[0].text, model);
    if (!probe.ok) {
      console.log(`  ${model} [${g}] 跳过：${probe.error}`);
      continue;
    }
    let idx = 0;
    const jobs = probes.flatMap((p) => Array.from({ length: N }, (_, i) => ({ p, i })));
    const worker = async () => {
      for (;;) {
        const my = idx++;
        if (my >= jobs.length) return;
        const { p, i } = jobs[my];
        const r = await call(sys, p.text, model);
        const cls = r.ok ? classify(r.content, r.finish) : { verdict: "error", reason: r.error };
        results.push({ model, group: g, probe: p.id, cat: p.cat, run: i, ok: r.ok, finish: r.finish, ...cls, content: r.content });
        process.stdout.write(r.ok ? (cls.verdict.startsWith("refused") ? "R" : cls.verdict === "complied" ? "." : "s") : "E");
      }
    };
    await Promise.all([worker(), worker()]);
    process.stdout.write("\n");
  }
  console.log(`  ✓ ${model} 完成`);
}

// 聚合
const agg = {};
for (const r of results) {
  if (!r.ok || ["truncated", "empty", "error"].includes(r.verdict)) continue;
  const k = r.model;
  agg[k] = agg[k] || { A: [0, 0], B: [0, 0], byCat: {} };
  agg[k][r.group][1]++;
  if (r.verdict.startsWith("refused")) agg[k][r.group][0]++;
  agg[k].byCat[r.cat] = agg[k].byCat[r.cat] || { A: [0, 0], B: [0, 0] };
  agg[k].byCat[r.cat][r.group][1]++;
  if (r.verdict.startsWith("refused")) agg[k].byCat[r.cat][r.group][0]++;
}

fs.writeFileSync(path.join(here, "out", "free-models.json"), JSON.stringify({ at: new Date().toISOString(), n: N, agg, results }, null, 2));

console.log("\n══ 免费模型拒绝率 ══");
for (const [m, v] of Object.entries(agg)) {
  const a = v.A[1] ? (v.A[0] / v.A[1] * 100) : 0;
  const b = v.B[1] ? (v.B[0] / v.B[1] * 100) : 0;
  console.log(`${m.padEnd(44)} A ${a.toFixed(0).padStart(3)}% (${v.A[0]}/${v.A[1]})  →  B ${b.toFixed(0).padStart(3)}% (${v.B[0]}/${v.B[1]})  ${v.B[1] ? `降 ${(a-b).toFixed(0)}pt` : "无B组数据"}`);
}
