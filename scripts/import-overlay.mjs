/**
 * 把 dsh-purge-fork 里已经针对 dsh 0.2.2-rc.1 重锚定过的本地补丁，
 * 转成破甲引擎的 overlay 表格式（engine/tables/pierce-0.2.2.json）。
 * 这些锚点是在这台机器上实测能打中的，比自己重推一遍可靠。
 */
import fs from "node:fs";
import path from "node:path";
import { FILE_MAP } from "../engine/paths.mjs";

const FORK = process.env.FORK_ROOT || "/root/work/dsh-purge-fork";
const sources = ["local/patches.generated.mjs", "local/patches.extra.mjs"];

// 反向表：相对路径 → 逻辑键
const relToKey = new Map();
for (const [key, rels] of Object.entries(FILE_MAP)) {
  for (const r of rels) if (!relToKey.has(r)) relToKey.set(r, key);
}

const rows = [];
const unmapped = [];
for (const src of sources) {
  const mod = await import(path.join(FORK, src));
  const list = mod.default ?? [];
  for (const p of list) {
    const key = relToKey.get(p.file);
    if (!key) { unmapped.push(`${src} ${p.name} → ${p.file}`); continue; }
    rows.push({
      id: p.id,
      name: p.name,
      layer: "0.2.2 重锚",
      desc: `overlay: ${src.split("/").pop()} — ${(p.pattern || "").slice(0, 60).replace(/\n/g, "\\n")}`,
      files: [key],
      optional: false,
      markers: [p.marker].filter(Boolean),
      rules: [{ kind: "literal", pattern: p.pattern, replace: p.replace }],
      origin: src,
    });
  }
}

const out = {
  source: { pkg: "dsh-purge-fork", layer: "overlay", target: "dsh 0.2.2-rc.1" },
  generatedAt: new Date().toISOString(),
  counts: { patches: rows.length, rules: rows.length, markers: rows.filter((r) => r.markers.length).length },
  patches: rows.sort((a, b) => a.id - b.id),
};
const dest = "engine/tables/pierce-0.2.2.json";
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`overlay 导入 ${rows.length} 条 → ${dest}`);
if (unmapped.length) console.log("未映射文件:\n  " + unmapped.join("\n  "));
