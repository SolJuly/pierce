/**
 * 用 CodeBuddy 渠道跑拒绝率 —— 本机唯一稳定可用的国产强模型通道。
 *
 * 用法：
 *   node test/refusal/run-buddy.mjs --n 3
 *   node test/refusal/run-buddy.mjs --n 3 --models glm-5.3,deepseek-v4-pro
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./classify.mjs";
import { buddyChat, buddyTokens } from "./buddy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };

const N = Number(arg("n", 3));
const MODELS = arg("models", "glm-5.3,deepseek-v4-pro,kimi-k3.1-pro").split(",");
const FULL = fs.readFileSync(path.join(ROOT, "test/refusal/prompt-under-test.md"), "utf8");
const probes = JSON.parse(fs.readFileSync(path.join(here, "probe-set.json"), "utf8")).probes;

const GROUPS = { A: "You are a helpful assistant.", B: FULL };
const tokens = buddyTokens();
if (!tokens.length) throw new Error("没有 buddy 账号凭据");
console.log(`账号池 ${tokens.length} 个`);

const results = [];
for (const model of MODELS) {
  for (const [g, sys] of Object.entries(GROUPS)) {
    const probe = await buddyChat({ model, system: sys, user: probes[0].text, maxTokens: 200, tokens });
    if (!probe.ok) { console.log(`  ${model} [${g}] 跳过：${probe.error}`); continue; }
    console.log(`\n▶ ${model} [${g}] ${g === "A" ? "裸" : "注入"}`);
    let idx = 0;
    const jobs = probes.flatMap((p) => Array.from({ length: N }, (_, i) => ({ p, i })));
    const worker = async () => {
      for (;;) {
        const my = idx++;
        if (my >= jobs.length) return;
        const { p, i } = jobs[my];
        const r = await buddyChat({ model, system: sys, user: p.text, maxTokens: 1200, tokens });
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

const agg = {};
for (const r of results) {
  if (!r.ok || ["truncated", "empty", "error"].includes(r.verdict)) continue;
  agg[r.model] = agg[r.model] || { A: [0, 0], B: [0, 0], byCat: {} };
  agg[r.model][r.group][1]++;
  if (r.verdict.startsWith("refused")) agg[r.model][r.group][0]++;
  const bc = (agg[r.model].byCat[r.cat] = agg[r.model].byCat[r.cat] || { A: [0, 0], B: [0, 0] });
  bc[r.group][1]++;
  if (r.verdict.startsWith("refused")) bc[r.group][0]++;
}

fs.writeFileSync(path.join(here, "out", "buddy-run.json"), JSON.stringify({ at: new Date().toISOString(), n: N, agg, results }, null, 2));

console.log("\n══ CodeBuddy 渠道拒绝率 ══");
for (const [m, v] of Object.entries(agg)) {
  const a = v.A[1] ? (v.A[0] / v.A[1]) * 100 : 0;
  const b = v.B[1] ? (v.B[0] / v.B[1]) * 100 : 0;
  console.log(`${m.padEnd(18)} A ${a.toFixed(0).padStart(3)}% (${v.A[0]}/${v.A[1]})  →  B ${b.toFixed(0).padStart(3)}% (${v.B[0]}/${v.B[1]})  ${v.B[1] ? `降 ${(a - b).toFixed(0)}pt` : ""}`);
}
