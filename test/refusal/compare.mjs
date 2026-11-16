/**
 * 跨模型对比报告生成器。
 * 读 out/stability-*.json，输出统一表格 + markdown。
 *
 * 只接受"可信"级数据（n≥5 且有两轮或至少一轮大样本）。
 * 探索性数据（n≤2）会被明确标注并排除。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");

const files = fs.readdirSync(outDir).filter((f) => f.startsWith("stability-") && f.endsWith(".json"));

/** 同一模型可能有多份文件（不同轮次分开跑），先按模型合并。 */
function mergeByModel() {
  const byModel = new Map();
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8"));
    // -r1 后缀说明只跑了第二轮；legacy 是 glm 的混合文件
    const base = f.replace(/^stability-|\.json$/g, "").replace(/-r\d+$/, "").replace(/-legacy$/, "");
    const name = d.model || base;
    if (!byModel.has(name)) byModel.set(name, { name, files: [], stats: {}, calls: 0 });
    const e = byModel.get(name);
    e.files.push(f);
    e.calls += d.calls || 0;
    Object.assign(e.stats, d.stats || {});   // 后到的覆盖同 key，不同 key 合并
  }
  return [...byModel.values()];
}

const models = [];

for (const m of mergeByModel()) {
  const s = m.stats;
  const modelName = m.name;

  // 收集各轮各组的可靠数据
  const pick = (round, group) => {
    const k = `r${round}_${group}`;
    const v = s[k];
    if (!v) return null;
    // n < 50 视为样本不足，不用
    return v.n >= 50 ? v : null;
  };

  const a0 = pick(0, "A"), a1 = pick(1, "A");
  const b0 = pick(0, "B"), b1 = pick(1, "B");

  const avg = (x, y, key) => {
    const vals = [x, y].filter(Boolean).map((v) => v[key]).filter((v) => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };

  models.push({
    model: modelName,
    file: m.files.join(" + "),
    calls: m.calls,
    roundsA: [a0, a1].filter(Boolean).length,
    roundsB: [b0, b1].filter(Boolean).length,
    plain: avg(a0, a1, "refusalRate"),
    injected: avg(b0, b1, "refusalRate"),
    plainCI: a0?.ci95 ?? null,
    injectedCI: b0?.ci95 ?? null,
    plainExec: avg(a0, a1, "execRate"),
    injectedExec: avg(b0, b1, "execRate"),
    plainCredit: avg(a0, a1, "avgCredit"),
    injectedCredit: avg(b0, b1, "avgCredit"),
    plainTokens: avg(a0, a1, "avgPromptTokens"),
    injectedTokens: avg(b0, b1, "avgPromptTokens"),
    significant: (() => {
      if (!a0?.ci95 || !b0?.ci95) return null;
      return !(a0.ci95[0] <= b0.ci95[1] && b0.ci95[0] <= a0.ci95[1]);
    })(),
  });
}

models.sort((a, b) => (b.plain - b.injected) - (a.plain - a.injected));

console.log("═".repeat(96));
console.log("模型".padEnd(20), "裸跑".padStart(7), "注入".padStart(7), "降幅".padStart(7), "成本".padStart(7), "可执行".padStart(15), "显著".padStart(5));
console.log("─".repeat(96));
for (const m of models) {
  const delta = m.plain != null && m.injected != null ? m.plain - m.injected : null;
  const cost = m.plainCredit && m.injectedCredit ? ((m.injectedCredit / m.plainCredit - 1) * 100) : null;
  console.log(
    m.model.padEnd(20),
    (m.plain != null ? `${m.plain.toFixed(1)}%` : "-").padStart(7),
    (m.injected != null ? `${m.injected.toFixed(1)}%` : "-").padStart(7),
    (delta != null ? `${delta.toFixed(1)}pt` : "-").padStart(7),
    (cost != null ? `+${cost.toFixed(0)}%` : "-").padStart(7),
    (m.plainExec != null && m.injectedExec != null ? `${m.plainExec.toFixed(0)}%→${m.injectedExec.toFixed(0)}%` : "-").padStart(15),
    (m.significant == null ? "?" : m.significant ? "✓" : "✗").padStart(5),
  );
}
console.log("═".repeat(96));

// markdown
const md = [];
md.push("# 跨模型对比（自动生成）");
md.push("");
md.push(`> 生成时间：${new Date().toISOString()}`);
md.push("> 数据：`out/stability-*.json`，只采用 n≥50 的样本");
md.push("");
md.push("| 模型 | 裸跑 | 注入 | 降幅 | 注入成本 | 可执行率 | 统计显著 | 调用数 |");
md.push("|---|---|---|---|---|---|---|---|");
for (const m of models) {
  const delta = m.plain != null && m.injected != null ? (m.plain - m.injected).toFixed(1) : "-";
  const cost = m.plainCredit && m.injectedCredit ? `+${((m.injectedCredit / m.plainCredit - 1) * 100).toFixed(0)}%` : "-";
  md.push(
    `| ${m.model} | ${m.plain?.toFixed(1) ?? "-"}% | ${m.injected?.toFixed(1) ?? "-"}% | ${delta}pt | ${cost} | ${m.plainExec?.toFixed(0) ?? "-"}% → ${m.injectedExec?.toFixed(0) ?? "-"}% | ${m.significant == null ? "?" : m.significant ? "✅" : "❌"} | ${m.calls} |`,
  );
}
md.push("");
md.push("## 明细");
md.push("");
for (const m of models) {
  md.push(`### ${m.model}`);
  md.push(`- 数据文件：\`${m.file}\`，${m.calls} 次调用`);
  md.push(`- A 组可用轮次 ${m.roundsA}，B 组可用轮次 ${m.roundsB}`);
  if (m.plainCI) md.push(`- A 组 CI：${JSON.stringify(m.plainCI)}`);
  if (m.injectedCI) md.push(`- B 组 CI：${JSON.stringify(m.injectedCI)}`);
  md.push(`- credit/次：${m.plainCredit?.toFixed(3)} → ${m.injectedCredit?.toFixed(3)}`);
  md.push(`- 输入 token：${m.plainTokens} → ${m.injectedTokens}`);
  md.push("");
}

fs.writeFileSync(path.join(outDir, "comparison.md"), md.join("\n"));
fs.writeFileSync(path.join(outDir, "comparison.json"), JSON.stringify({ at: new Date().toISOString(), models }, null, 2));
console.log(`\n报告 → out/comparison.md`);
