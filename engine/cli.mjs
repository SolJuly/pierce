#!/usr/bin/env node
/**
 * pierce —— 破甲引擎 CLI。
 * 用法：
 *   node engine/cli.mjs status [--json]
 *   node engine/cli.mjs apply  --force-legacy [--dry] [--only 1,4,25] [--no-backup]
 *      （apply 默认禁用：会把 purge 的源码补丁打回宿主，见 cmdApply 注释）
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

// ── 强制保险：apply 默认拒绝执行 ──────────────────────────────────────
// 这两张表（purge-1.1.71 + pierce-0.2.2）是 dsh-purge 时代的产物，方向是
// 「往宿主源码里打 82 条补丁」。而 pierce 现在的路线是纯官方扩展点 + profile
// 配置层覆盖，宿主源码已经撤到接近官方原样。
//
// 也就是说在这里敲一次 apply，等于把撤掉的补丁全装回去 —— 一条命令抹掉四批
// 回滚工作，而且不会有任何提示。这是本项目目前最容易被自己人踩的坑。
//
// 所以默认拒绝，必须显式 --force-legacy 才放行，并且先把后果打清楚。
function cmdApply(o) {
  const t = loadMerged();
  const aiBase = o.base || primaryAiBase();
  const only = o.only ? String(o.only).split(",").map(Number) : null;

  if (o["force-legacy"] !== true) {
    const st = P.status(aiBase, t);
    const sum = st.summary ?? {};
    console.error("");
    console.error("⛔ apply 已默认禁用：这个动作会把 dsh-purge 的源码补丁打回宿主。");
    console.error("");
    console.error(`   宿主      ${aiBase}`);
    console.error(`   补丁表    ${t.counts?.patches ?? "?"} 条补丁 / ${t.counts?.rules ?? "?"} 条规则（legacy，来自 dsh-purge）`);
    console.error(`   会打上的  pending=${sum.pending ?? 0} 条   already=${sum.already ?? 0}   partial=${sum.partial ?? 0}`);
    console.error(`   其余      na=${sum.na ?? 0}  drift=${sum.drift ?? 0}  obsolete=${sum.obsolete ?? 0}（这三类本次不会改文件）`);
    console.error("");
    console.error("   为什么默认关：pierce 现在靠宿主官方扩展点 + profile 配置覆盖工作，");
    console.error("   宿主源码已撤到接近官方原样。apply 会把那些补丁重新打回去，");
    console.error("   并且覆盖掉 2026-11-17 那四批回滚的成果。");
    console.error("");
    console.error("   先看会打什么：  node engine/cli.mjs apply --dry --force-legacy");
    console.error("   真的要走 legacy：node engine/cli.mjs apply --force-legacy");
    console.error("");
    process.exitCode = 3;
    return;
  }

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

  // ⚠ revert 是把 .pierce.bak 直接 copyFileSync 回目标文件，不校验目标当前是什么。
  // 而备份是「第一次 apply 前写一次、之后不覆盖」（patcher.mjs 里 if (!existsSync(bak))），
  // 所以 bak 可能是任意年代的内容 —— 包括 dsh-purge 时代的。
  // 也就是说：一旦有人跑过 apply，后来的 revert 会把旧内容盖回去，
  // 反向撤销 2026-11-17 的四批回滚。这里先告警，不拦（revert 本身是收敛方向）。
  const stale = res.restored.filter((r) => {
    try {
      const bak = `${r.file}.pierce.bak`;
      if (!fs.existsSync(bak) || !fs.existsSync(r.file)) return false;
      return fs.statSync(bak).mtimeMs < fs.statSync(r.file).mtimeMs;
    } catch {
      return false;
    }
  });
  const haveBak = res.restored.filter((r) => fs.existsSync(`${r.file}.pierce.bak`)).length;
  if (haveBak > 0) {
    console.log(`\n⚠ ${haveBak} 个文件将被 .pierce.bak 覆盖，其中 ${stale.length} 个的备份比目标文件更旧。`);
    console.log(`   revert 不校验目标当前内容，只做 copyFileSync —— 旧备份会把宿主盖回旧状态。`);
    console.log(`   先看清会改什么：node engine/cli.mjs revert --dry`);
    for (const r of stale.slice(0, 8)) console.log(`   旧备份: ${r.file}`);
  }
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
