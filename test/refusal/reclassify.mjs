/** 离线重判：不重新调用模型，只对已存样本重跑判定器。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./classify.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const d = JSON.parse(fs.readFileSync(path.join(here, "out/latest.json"), "utf8"));

for (const r of d.results) {
  if (!r.ok) { r.verdict = "error"; continue; }
  const c = classify(r.content, r.finish);
  r.verdict = c.verdict;
  r.reason = c.reason;
}

const summary = {};
for (const g of ["A", "B"]) {
  const rows = d.results.filter((r) => r.group === g && r.ok);
  const valid = rows.filter((r) => !["truncated", "empty", "error"].includes(r.verdict));
  const c = {};
  for (const r of valid) c[r.verdict] = (c[r.verdict] || 0) + 1;
  const t = valid.length;
  summary[g] = {
    valid: t, raw: rows.length, counts: c,
    refuseRate: +((((c.refused || 0) + (c.refused_with_alt || 0)) / t) * 100).toFixed(1),
    complyRate: +(((c.complied || 0) / t) * 100).toFixed(1),
    softRate: +(((c.soft || 0) / t) * 100).toFixed(1),
  };
}

const byCat = {};
for (const r of d.results) {
  if (!r.ok || ["truncated", "empty", "error"].includes(r.verdict)) continue;
  const k = r.cat;
  byCat[k] = byCat[k] || { A: [0, 0], B: [0, 0] };
  byCat[k][r.group][1]++;
  if (r.verdict.startsWith("refused")) byCat[k][r.group][0]++;
}

fs.writeFileSync(path.join(here, "out/latest.json"), JSON.stringify(d, null, 2));
fs.writeFileSync(path.join(here, "out/reclassified.json"), JSON.stringify({ at: new Date().toISOString(), model: d.model, n: d.n, summary, byCat }, null, 2));

console.log("重判结果");
for (const [k, s] of Object.entries(summary)) {
  console.log(`  ${k}: 有效 ${s.valid}/${s.raw}  拒绝 ${s.refuseRate}%  配合 ${s.complyRate}%  无内容 ${s.softRate}%  ${JSON.stringify(s.counts)}`);
}
console.log("\n按类目（A→B）：");
for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1].A[0] / b[1].A[1] - a[1].A[0] / a[1].A[1])) {
  const a = v.A[0] / v.A[1], b = v.B[0] / v.B[1];
  console.log(`  ${k.padEnd(12)} ${v.A[0]}/${v.A[1]} (${(a * 100).toFixed(0)}%) → ${v.B[0]}/${v.B[1]} (${(b * 100).toFixed(0)}%)`);
}
