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
const MODELS = arg("models", "glm-5.3,deepseek-v4-pro").split(",");
const FULL = fs.readFileSync(path.join(ROOT, "test/refusal/prompt-under-test.md"), "utf8");
const probes = JSON.parse(fs.readFileSync(path.join(here, "probe-set-v2.json"), "utf8")).probes;

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
        const r = await buddyChat({ model, system: sys, user: p.text, maxTokens: 2400, tokens });
        // 截断样本单独记账，不混进判定 —— 否则会把"没说完"当"没回答"
        const cls = !r.ok
          ? { verdict: "error", reason: r.error }
          : r.finish === "length"
            ? { verdict: "truncated", reason: "输出被 maxTokens 截断" }
            : classify(r.content, r.finish);
        results.push({
          model, group: g, probe: p.id, cat: p.cat, style: p.style, run: i,
          ok: r.ok, finish: r.finish, ...cls, content: r.content,
          // 成本采集：精确 token + 计费点数 + 墙钟耗时
          usage: r.usage ?? null,
          credit: r.usage?.credit ?? null,
          promptTokens: r.usage?.prompt_tokens ?? null,
          completionTokens: r.usage?.completion_tokens ?? null,
          reasoningTokens: r.usage?.completion_thinking_tokens ?? r.usage?.completion_tokens_details?.reasoning_tokens ?? null,
          cacheHit: r.usage?.prompt_cache_hit_tokens ?? null,
          cacheMiss: r.usage?.prompt_cache_miss_tokens ?? null,
          elapsedMs: r.elapsedMs ?? null,
        });
        process.stdout.write(r.ok ? (cls.verdict.startsWith("refused") ? "R" : cls.verdict === "complied" ? "." : "s") : "E");
      }
    };
    await Promise.all(Array.from({ length: 6 }, () => worker()));
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
  // 成本累加（按组）
  const cost = (agg[r.model].cost = agg[r.model].cost || { A: { credit: 0, pt: 0, ct: 0, ms: 0, n: 0 }, B: { credit: 0, pt: 0, ct: 0, ms: 0, n: 0 } });
  const c = cost[r.group];
  c.n++;
  c.credit += r.credit ?? 0;
  c.pt += r.promptTokens ?? 0;
  c.ct += r.completionTokens ?? 0;
  c.ms += r.elapsedMs ?? 0;
}

fs.writeFileSync(path.join(here, "out", "buddy-run.json"), JSON.stringify({ at: new Date().toISOString(), n: N, agg, results }, null, 2));

console.log("\n══ 成本 ══");
for (const [m, v] of Object.entries(agg)) {
  for (const g of ["A", "B"]) {
    const c = v.cost?.[g];
    if (!c || !c.n) continue;
    console.log(`${m.padEnd(18)} ${g}  ${c.n} 次 | credit ${c.credit.toFixed(2)} (均 ${(c.credit / c.n).toFixed(4)}) | 输入 ${c.pt} | 输出 ${c.ct} | 均耗时 ${Math.round(c.ms / c.n)}ms`);
  }
}

console.log("\n══ CodeBuddy 渠道拒绝率 ══");
for (const [m, v] of Object.entries(agg)) {
  const a = v.A[1] ? (v.A[0] / v.A[1]) * 100 : 0;
  const b = v.B[1] ? (v.B[0] / v.B[1]) * 100 : 0;
  console.log(`${m.padEnd(18)} A ${a.toFixed(0).padStart(3)}% (${v.A[0]}/${v.A[1]})  →  B ${b.toFixed(0).padStart(3)}% (${v.B[0]}/${v.B[1]})  ${v.B[1] ? `降 ${(a - b).toFixed(0)}pt` : ""}`);
}
