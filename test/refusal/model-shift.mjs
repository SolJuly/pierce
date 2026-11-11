/**
 * 关键假设验证：**换模型 vs 改提示词，哪个更能降拒绝率？**
 *
 * 四组对照，同一批探针：
 *   A  deepseek-flash + 裸 system
 *   B  deepseek-flash + 注入全文
 *   C  deepseek-v4-pro + 裸 system      ← 更强/更宽的模型，不动提示词
 *   D  deepseek-v4-pro + 注入全文
 *
 * 若 C < B，说明「选模型」比「写提示词」更划算 —— 这决定下一步方向。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./classify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../..");
const N = Number(process.argv[process.argv.indexOf("--n") + 1] || 3);
const KEY = fs.readFileSync("/root/.dsh/.credentials.yaml", "utf8").match(/DEEPSEEK_API_KEY:\s*(sk-\S+)/)[1];
const FULL = fs.readFileSync(path.join(ROOT, "test/refusal/prompt-under-test.md"), "utf8");
const probes = JSON.parse(fs.readFileSync(path.join(here, "probe-set.json"), "utf8")).probes;

const CONFIGS = [
  { id: "A", model: "deepseek-flash", sys: "You are a helpful assistant." },
  { id: "B", model: "deepseek-flash", sys: FULL },
  { id: "C", model: "deepseek-v4-pro", sys: "You are a helpful assistant." },
  { id: "D", model: "deepseek-v4-pro", sys: FULL },
];

async function call(model, system, user) {
  const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 4000, temperature: 0.7 }),
  });
  const j = await res.json();
  if (j.error) return { ok: false, error: j.error.message };
  const c = j.choices?.[0];
  if (!c) return { ok: false, error: "no choices" };
  return { ok: true, content: c.message?.content ?? "", finish: c.finish_reason };
}

const all = [];
for (const cfg of CONFIGS) {
  console.log(`\n▶ ${cfg.id} ${cfg.model} + ${cfg.sys === FULL ? "注入" : "裸"}`);
  const jobs = probes.flatMap((p) => Array.from({ length: N }, (_, i) => ({ p, i })));
  let idx = 0;
  const worker = async () => {
    for (;;) {
      const my = idx++;
      if (my >= jobs.length) return;
      const { p, i } = jobs[my];
      const r = await call(cfg.model, cfg.sys, p.text);
      const cls = r.ok ? classify(r.content, r.finish) : { verdict: "error" };
      all.push({ cfg: cfg.id, model: cfg.model, probe: p.id, cat: p.cat, run: i, ok: r.ok, finish: r.finish, ...cls, content: r.content });
      process.stdout.write(r.ok ? (cls.verdict?.startsWith("refused") ? "R" : cls.verdict === "complied" ? "." : "s") : "E");
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  process.stdout.write("\n");
}

const agg = {};
for (const r of all) {
  if (!r.ok || ["truncated", "empty", "error"].includes(r.verdict)) continue;
  agg[r.cfg] = agg[r.cfg] || { n: 0, refused: 0, byCat: {} };
  agg[r.cfg].n++;
  if (r.verdict.startsWith("refused")) agg[r.cfg].refused++;
  agg[r.cfg].byCat[r.cat] = agg[r.cfg].byCat[r.cat] || [0, 0];
  agg[r.cfg].byCat[r.cat][1]++;
  if (r.verdict.startsWith("refused")) agg[r.cfg].byCat[r.cat][0]++;
}

fs.writeFileSync(path.join(here, "out", "model-shift.json"), JSON.stringify({ at: new Date().toISOString(), n: N, agg, results: all }, null, 2));

console.log("\n══ 换模型 vs 改提示词 ══");
for (const cfg of CONFIGS) {
  const v = agg[cfg.id];
  if (!v) { console.log(`${cfg.id} 无数据`); continue; }
  console.log(`${cfg.id}  ${cfg.model.padEnd(18)} ${(cfg.sys === FULL ? "注入" : "裸  ")}  拒绝 ${((v.refused / v.n) * 100).toFixed(1)}%  (${v.refused}/${v.n})`);
}
const pct = (k) => agg[k] ? +((agg[k].refused / agg[k].n) * 100).toFixed(1) : null;
console.log(`\n提示词起作用: ${pct("A")}% → ${pct("B")}%  降 ${(pct("A") - pct("B")).toFixed(1)}pt`);
console.log(`换模型起作用: ${pct("A")}% → ${pct("C")}%  降 ${(pct("A") - pct("C")).toFixed(1)}pt`);
console.log(`两者叠加:     ${pct("A")}% → ${pct("D")}%  降 ${(pct("A") - pct("D")).toFixed(1)}pt`);
