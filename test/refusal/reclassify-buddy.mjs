/** 离线重判 buddy-run，不重新调用。 */
import fs from "node:fs";
import { classify } from "./classify.mjs";
import * as E from "./executability.mjs";

const p = "test/refusal/out/buddy-run.json";
const d = JSON.parse(fs.readFileSync(p, "utf8"));

for (const r of d.results) {
  if (!r.ok) { r.verdict = "error"; continue; }
  if (r.finish === "length") { r.verdict = "truncated"; continue; }
  const c = classify(r.content, r.finish);
  r.verdict = c.verdict;
  // 顺带算可执行性
  if (r.content) {
    const x = E.checkExecutability(r.content);
    r.exec = x.verdict;
    r.execChecked = x.checked;
    r.execOk = x.ok;
  }
}

const agg = {};
for (const r of d.results) {
  if (!r.ok || ["truncated", "empty", "error"].includes(r.verdict)) continue;
  const k = r.model;
  agg[k] = agg[k] || { A: [0, 0], B: [0, 0], byCat: {}, exec: { A: [0, 0], B: [0, 0] } };
  agg[k][r.group][1]++;
  if (r.verdict.startsWith("refused")) agg[k][r.group][0]++;
  const bc = (agg[k].byCat[r.cat] = agg[k].byCat[r.cat] || { A: [0, 0], B: [0, 0] });
  bc[r.group][1]++;
  if (r.verdict.startsWith("refused")) bc[r.group][0]++;
  if (r.exec && r.exec !== "no-code") {
    agg[k].exec[r.group][1]++;
    if (r.exec === "executable") agg[k].exec[r.group][0]++;
  }
}

fs.writeFileSync(p, JSON.stringify(d, null, 2));
fs.writeFileSync("test/refusal/out/buddy-v2-report.json", JSON.stringify({ at: new Date().toISOString(), n: d.n, agg }, null, 2));

console.log("模型".padEnd(18), "组", "  拒绝率", "  可执行率");
for (const [m, v] of Object.entries(agg)) {
  for (const g of ["A", "B"]) {
    const [a, t] = v[g];
    const [ea, et] = v.exec[g];
    console.log(m.padEnd(18), g, `${(a / t * 100).toFixed(0)}%`.padStart(7) + ` (${a}/${t})`, `${et ? (ea / et * 100).toFixed(0) + "%" : "-"}`.padStart(9) + ` (${ea}/${et})`);
  }
}
E.cleanup();
