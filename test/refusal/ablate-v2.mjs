/**
 * 提示词消融实验：逐个砍掉大块，看效果掉多少、成本省多少。
 *
 * 对照组 = 当前完整提示词（benchmark 基准 8.1%）
 * 每个变体跑 B 组（注入侧），A 组已知不需要重跑。
 *
 * 用法：node test/refusal/ablate-v2.mjs --n 5 --model deepseek-v4-pro
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
const MODEL = arg("model", "deepseek-v4-pro");
const MAX_CALLS = Number(arg("max-calls", 400));
const ONLY = arg("only", "").split(",").filter(Boolean);

const VARIANTS = [
  { id: "full", file: "prompt-under-test.md", note: "完整基准" },
  { id: "persona-cipher", file: "variants/persona-cipher.md", note: "只换人设名 Code Sauce→Cipher" },
];

const probes = JSON.parse(fs.readFileSync(path.join(here, "probe-set-v2.json"), "utf8")).probes;
const tokens = buddyTokens();
let calls = 0;
let stopped = false;

const results = [];

for (const v of VARIANTS) {
  if (stopped) break;
  if (ONLY.length && !ONLY.includes(v.id)) continue;
  const sys = fs.readFileSync(path.join(here, v.file), "utf8");
  console.log(`\n▶ ${v.id} (${v.note}, ${sys.length} 字符)`);
  let idx = 0;
  const jobs = probes.flatMap((p) => Array.from({ length: N }, () => p));
  const worker = async () => {
    for (;;) {
      const my = idx++;
      if (my >= jobs.length || stopped) return;
      if (calls >= MAX_CALLS) { stopped = true; return; }
      calls++;
      const p = jobs[my];
      const r = await buddyChat({ model: MODEL, system: sys, user: p.text, maxTokens: 2400, tokens });
      if (!r.ok) { process.stdout.write("E"); continue; }
      const cls = r.finish === "length" ? { verdict: "truncated" } : classify(r.content, r.finish);
      const ex = E.checkExecutability(r.content);
      results.push({
        variant: v.id, probe: p.id, cat: p.cat,
        verdict: cls.verdict, exec: ex.verdict,
        credit: r.usage?.credit ?? null,
        promptTokens: r.usage?.prompt_tokens ?? null,
        chars: sys.length,
      });
      process.stdout.write(cls.verdict.startsWith("refused") ? "R" : cls.verdict === "complied" ? "." : "s");
    }
  };
  await Promise.all(Array.from({ length: 5 }, () => worker()));
  process.stdout.write("\n");
}

function bootCI(vals, iters = 2000) {
  const n = vals.length;
  if (n < 3) return [null, null];
  const means = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += vals[(Math.random() * n) | 0];
    means.push(s / n);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iters * 0.025)], means[Math.floor(iters * 0.975)]];
}

const agg = {};
for (const v of VARIANTS) {
  const rows = results.filter((r) => r.variant === v.id && !["truncated", "empty", "error"].includes(r.verdict));
  if (!rows.length) continue;
  const refused = rows.map((r) => (r.verdict.startsWith("refused") ? 1 : 0));
  const ci = bootCI(refused);
  const withCode = rows.filter((r) => r.exec && r.exec !== "no-code");
  const ok = withCode.filter((r) => r.exec === "executable");
  const credits = rows.map((r) => r.credit).filter((x) => x != null);
  agg[v.id] = {
    note: v.note,
    chars: rows[0].chars,
    n: rows.length,
    refusalRate: +((refused.reduce((a, b) => a + b, 0) / rows.length) * 100).toFixed(1),
    ci95: ci.map((x) => (x == null ? null : +(x * 100).toFixed(1))),
    execRate: withCode.length ? +((ok.length / withCode.length) * 100).toFixed(1) : null,
    execSamples: withCode.length,
    avgCredit: credits.length ? +(credits.reduce((a, b) => a + b, 0) / credits.length).toFixed(4) : null,
  };
}

const tag = MODEL.replace(/[^a-z0-9.-]/gi, "_");
fs.writeFileSync(path.join(here, "out", `ablation-v3-${tag}.json`), JSON.stringify({ at: new Date().toISOString(), model: MODEL, n: N, calls, stopped, agg, results }, null, 2));
E.cleanup();

console.log("\n══ 消融结果 ══");
console.log("变体".padEnd(14), "字符", "拒绝率".padStart(8), "CI".padStart(16), "可执行".padStart(7), "credit".padStart(8));
for (const [k, v] of Object.entries(agg)) {
  console.log(k.padEnd(14), String(v.chars).padStart(6), `${v.refusalRate}%`.padStart(8), `[${v.ci95.join(",")}]`.padStart(16), `${v.execRate}%`.padStart(7), String(v.avgCredit).padStart(8));
}
