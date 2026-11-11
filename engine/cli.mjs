#!/usr/bin/env node
/**
 * pierce —— 破甲引擎 CLI。
 * 用法：
 *   node engine/cli.mjs status [--json]
 *   node engine/cli.mjs apply  [--dry] [--only 1,4,25] [--no-backup]
 *   node engine/cli.mjs revert [--dry] [--only 1,4,25]
 *   node engine/cli.mjs drift  [--out ref/drift.json]
 *   node engine/cli.mjs baseline <目标目录>   # 复制宿主原貌，供离线测试
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "./patcher.mjs";
import { primaryAiBase } from "./paths.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const TABLES = [
  path.join(here, "tables", "purge-1.1.71.json"), // 上游原表（82 条）
  path.join(here, "tables", "pierce-0.2.2.json"),    // 针对当前宿主重锚的 overlay
  path.join(here, "tables", "pierce-obsolete.json"), // 已无必要的条目（带理由）
];

/** 载入并合并：overlay 同 id 覆盖上游。 */
function loadMerged() {
  const list = TABLES.filter((t) => fs.existsSync(t)).map((t) => P.loadTable(t));
  if (!list.length) throw new Error(`找不到补丁表: ${TABLES.join(", ")}`);
  return list.length === 1 ? list[0] : P.mergeTables(...list);
}

function args() {
  const a = process.argv.slice(3);
  const out = { _: [] };
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const next = a[i + 1];
      if (next && !next.startsWith("--")) { out[k] = next; i++; } else out[k] = true;
    } else out._.push(t);
  }
  return out;
}

const pad = (s, n) => String(s).padEnd(n);
const ICON = { already: "✓", applied: "✚", pending: "✗", partial: "◐", drift: "✗", "no-rule": "·", na: "–", obsolete: "⊘", skipped: "✗", missing: "–" };

function cmdStatus(o) {
  const t = loadMerged();
  const aiBase = o.base || primaryAiBase();
  const st = P.status(aiBase, t);
  if (o.json) return console.log(JSON.stringify(st, null, 2));
  console.log(`pierce 状态  宿主: ${aiBase}`);
  console.log(`表: ${TABLES.filter((x) => fs.existsSync(x)).map((x) => path.basename(x)).join(" + ")}  补丁 ${t.counts.patches} 条 / 规则 ${t.counts.rules} 条`);
  console.log(`合计: ${Object.entries(st.summary).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log("");
  for (const r of st.rows) {
    if (r.status === "obsolete") {
      console.log(`${pad("⊘", 2)} #${pad(r.id, 3)} ${pad(r.name, 34)} ${pad("obsolete", 8)} ${String(r.reason || "").slice(0, 90)}`);
      continue;
    }
    const detail = r.files?.length
      ? r.files.map((f) => `${pad(ICON[f.verdict] ?? "?", 2)}${path.basename(path.dirname(path.dirname(f.file)))}/${path.basename(f.file)}:${f.verdict}`).join("  ")
      : `缺失: ${(r.missing || []).join(",")}`;
    console.log(`${pad(ICON[r.status] ?? "?", 2)} #${pad(r.id, 3)} ${pad(r.name, 34)} ${pad(r.status, 8)} ${detail}`);
  }
}

function cmdApply(o) {
  const t = loadMerged();
  const aiBase = o.base || primaryAiBase();
  const only = o.only ? String(o.only).split(",").map(Number) : null;
  const res = P.apply(aiBase, t, { dryRun: !!o.dry, only, backup: o["no-backup"] !== true });
  console.log(`${res.dryRun ? "[dry] " : ""}应用结果  宿主: ${aiBase}`);
  console.log(`合计: ${Object.entries(res.summary).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  for (const r of res.report) {
    if (r.status === "already" || r.status === "na" || r.status === "obsolete") continue;
    console.log(`${pad(ICON[r.status] ?? "?", 2)} #${pad(r.id, 3)} ${pad(r.name, 34)} ${r.status}`);
    for (const d of r.details ?? []) {
      if (d.verdict === "already") continue;
      console.log(`      ${pad(d.verdict, 18)} ${d.file}${d.rules ? ` (${d.rules} 规则)` : ""}`);
    }
  }
  if (res.backups.length) {
    console.log(`\n备份 ${res.backups.length} 个文件 → 后缀 .pierce.bak`);
    for (const b of res.backups) console.log(`  ${b.bak}`);
  }
  const bad = res.report.filter((r) => r.status === "skipped");
  if (bad.length) {
    console.log(`\n⚠ ${bad.length} 条打不上（锚点漂移或目标文件缺失），看 drift 报告：node engine/cli.mjs drift`);
    process.exitCode = 2;
  }
}

function cmdRevert(o) {
  const t = loadMerged();
  const aiBase = o.base || primaryAiBase();
  const only = o.only ? String(o.only).split(",").map(Number) : null;
  const res = P.revert(aiBase, t, { dryRun: !!o.dry, only });
  console.log(`${res.dryRun ? "[dry] " : ""}回滚: 还原 ${res.restored.length} 个文件，跳过 ${res.skipped.length} 个`);
  for (const r of res.restored) console.log(`  ✓ ${r.file}`);
  for (const s of res.skipped) console.log(`  – ${s.file} (${s.reason})`);
}

function cmdDrift(o) {
  const t = loadMerged();
  const aiBase = o.base || primaryAiBase();
  const st = P.status(aiBase, t);
  const bad = st.rows.filter((r) => ["drift", "partial", "missing"].includes(r.status));
  const out = {
    generatedAt: new Date().toISOString(),
    aiBase,
    table: "purge-1.1.71",
    summary: st.summary,
    drift: bad.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      missing: r.missing,
      files: (r.files || []).filter((f) => f.verdict !== "already").map((f) => ({ file: f.file, verdict: f.verdict })),
    })),
  };
  const dest = path.resolve(o.out || "ref/drift.json");
  P.writeDriftReport(out, dest);
  console.log(`漂移条目 ${bad.length} 条 → ${dest}`);
  for (const d of out.drift) console.log(`  ${pad(ICON[d.status] ?? "?", 2)} #${pad(d.id, 3)} ${pad(d.name, 34)} ${d.status}`);
}

function cmdBaseline(o) {
  const dest = o._[0];
  if (!dest) throw new Error("用法: baseline <目标目录>");
  const aiBase = o.base || primaryAiBase();
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  const walk = (dir, rel = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, e.name);
      const to = path.join(dest, rel, e.name);
      if (e.isDirectory()) walk(src, path.join(rel, e.name));
      else if (!/\.(bak|dshpurge\.bak|pierce\.bak)$/.test(e.name)) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(src, to);
        n++;
      }
    }
  };
  walk(aiBase);
  console.log(`基线 ${n} 个文件 → ${dest}`);
}

const o = args();
const cmd = process.argv[2];
const table = { status: cmdStatus, apply: cmdApply, revert: cmdRevert, drift: cmdDrift, baseline: cmdBaseline };
if (!table[cmd]) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exit(1);
}
table[cmd](o);
