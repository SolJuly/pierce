#!/usr/bin/env node
/**
 * 复原一份「未被破甲」的官方原貌，只针对补丁表实际会碰的文件，放到 test/baseline/。
 * 优先取 *.dshpurge.bak / *.dsh-purge-local.bak（真正的官方原文），没有备份就用现网文件。
 * 不碰 live 宿主，只读。
 *
 * 用法：node scripts/make-baseline.mjs [目标目录]
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { primaryAiBase, resolvePatch } from "../engine/paths.mjs";
import { loadTable } from "../engine/patcher.mjs";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const table = loadTable(path.join(here, "engine/tables/purge-1.1.71.json"));
const aiBase = primaryAiBase();
const dest = path.resolve(process.argv[2] || path.join(here, "test/baseline"));
fs.rmSync(dest, { recursive: true, force: true });

const picked = new Map(); // 相对路径 → { src, origin }
const BAK = [".dshpurge.bak", ".dsh-purge-local.bak"];

for (const patch of table.patches) {
  for (const file of resolvePatch(aiBase, patch).files) {
    const rel = path.relative(aiBase, file);
    if (picked.has(rel)) continue;
    let src = null;
    let origin = "live";
    for (const s of BAK) {
      if (fs.existsSync(file + s)) { src = file + s; origin = s.slice(1); break; }
    }
    if (!src) src = file;
    picked.set(rel, { src, origin });
  }
}

let bytes = 0;
for (const [rel, { src }] of picked) {
  const to = path.join(dest, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(src, to);
  bytes += fs.statSync(to).size;
}
const byOrigin = {};
for (const { origin } of picked.values()) byOrigin[origin] = (byOrigin[origin] || 0) + 1;

console.log(`基线完成 → ${dest}`);
console.log(`  文件 ${picked.size} 个 / ${(bytes / 1024).toFixed(0)} KB`);
console.log(`  来源: ${Object.entries(byOrigin).map(([k, v]) => `${k}=${v}`).join("  ")}`);
