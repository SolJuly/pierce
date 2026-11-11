#!/usr/bin/env node
/**
 * 端到端演练：把 test/baseline 复制到临时目录，跑 apply → status → revert，
 * 全程不碰 live 宿主。用来验证引擎本身和补丁表在「官方原貌」上的实际命中率。
 *
 * 用法：node scripts/verify-e2e.mjs [--keep]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTable, mergeTables, apply, status, revert, writeDriftReport } from "../engine/patcher.mjs";
import { backupPath } from "../engine/paths.mjs";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const T = (n) => path.join(here, "engine/tables", n);
const table = mergeTables(
  loadTable(T("purge-1.1.71.json")),
  loadTable(T("pierce-0.2.2.json")),
  loadTable(T("pierce-obsolete.json")),
);
const baseline = path.join(here, "test/baseline");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "pierce-e2e-"));

const copy = (src, dst) => {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copy(s, d);
    else fs.copyFileSync(s, d);
  }
};
copy(baseline, work);

const out = [];
const log = (s) => { out.push(s); console.log(s); };

log(`工作目录 ${work}`);
const before = status(work, table);
log(`\n[1] 原貌判定: ${fmt(before.summary)}`);

const applied = apply(work, table, { backup: true });
log(`\n[2] apply: ${fmt(applied.summary)}  (备份 ${applied.backups.length} 文件)`);

const after = status(work, table);
log(`\n[3] 打后判定: ${fmt(after.summary)}`);

// 幂等：再跑一次不应再改任何文件
const again = apply(work, table, { backup: false });
log(`\n[4] 幂等重跑: ${fmt(again.summary)}`);
if (again.summary.applied) log("  ⚠ 非幂等：第二次仍写盘了");

// 语法校验：所有 .js 目标过 node --check
const { execFileSync } = await import("node:child_process");
let checked = 0, failed = [];
for (const patch of table.patches) {
  for (const f of (patch.files || []).flatMap(() => [])) void f;
}
const seen = new Set();
const walkAll = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walkAll(p); continue; }
    if (!/\.(js|mjs|cjs)$/.test(e.name) || /\.pierce\.bak$/.test(e.name)) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    try { execFileSync(process.execPath, ["--check", p], { stdio: "pipe" }); checked++; }
    catch (err) { failed.push({ p, msg: String(err.stderr || err).split("\n").slice(0, 3).join(" ") }); }
  }
};
walkAll(work);
log(`\n[5] 语法: ${checked} 个 JS 目标，失败 ${failed.length}`);
for (const f of failed.slice(0, 5)) log(`  ✗ ${f.p}  ${f.msg}`);

// 回滚
const rev = revert(work, table, {});
log(`\n[6] revert: 还原 ${rev.restored.length} 文件，跳过 ${rev.skipped.length}`);
const back = status(work, table);
log(`\n[7] 回滚后判定: ${fmt(back.summary)}`);
const same = JSON.stringify(back.summary) === JSON.stringify(before.summary);
log(`    与原貌一致: ${same ? "是" : "否 ≠"}`);

// 漂移清单
const drift = after.rows.filter((r) => ["drift", "partial", "missing"].includes(r.status));
log(`\n[8] 打后仍漂移 ${drift.length} 条`);
for (const d of drift) log(`  #${String(d.id).padEnd(3)} ${d.name.padEnd(34)} ${d.status}`);

writeDriftReport(
  { generatedAt: new Date().toISOString(), phase: "e2e", aiBase: work, summary: after.summary,
    drift: drift.map((r) => ({ id: r.id, name: r.name, status: r.status, missing: r.missing,
      files: (r.files || []).map((f) => ({ file: path.relative(work, f.file), verdict: f.verdict })) })) },
  path.join(here, "ref/e2e-drift.json"),
);

if (!process.argv.includes("--keep")) fs.rmSync(work, { recursive: true, force: true });
else log(`\n保留 ${work}`);

fs.mkdirSync(path.join(here, "test/reports"), { recursive: true });
fs.writeFileSync(path.join(here, "test/reports/e2e.log"), out.join("\n") + "\n");

function fmt(s) { return Object.entries(s).map(([k, v]) => `${k}=${v}`).join(" "); }
