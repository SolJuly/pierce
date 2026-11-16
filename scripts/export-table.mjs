/**
 * 从 dsh-purge 1.1.71 导出补丁表 → engine/tables/purge-1.1.71.json
 * 目标：把「散在 7984 行 core.js 里的 82 条规则」变成可 diff、可版本化的数据文件。
 * 用法：node scripts/export-table.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dsh-purge 的安装位置随部署而变：优先 PURGE_ROOT，其次 $DSH_HOME 下的 profile。
const DSH_HOME_DIR = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const PURGE = process.env.PURGE_ROOT
  || process.env.PURGE_DIR
  || path.join(DSH_HOME_DIR, "profiles/web/node_modules/dsh-purge");
const core = await import(path.join(PURGE, "lib/core.js"));

const rows = core.ALL_PATCHES.map((p) => ({
  id: p.id,
  name: p.name,
  layer: p.layer,
  group: core.PATCH_DISPLAY_GROUPS
    ? Object.entries(core.PATCH_DISPLAY_GROUPS).find(([, ids]) => ids.includes(p.id))?.[0] ?? null
    : null,
  desc: p.desc ?? "",
  files: Array.isArray(p.file) ? p.file : [p.file],
  rel: p.rel ?? null,
  optional: p.optional === true,
  softSettle: p.softSettle === true,
  markers: p.markers ?? (p.marker ? [p.marker] : []),
  // 两种历史形态都要吃：
  //   replacements: [{ pattern, replace }]   —— 新写法
  //   patterns: [...]  + replace + marker    —— 旧写法（purge 里 #5 #6 #7 #8 #10 #15 #16）
  rules: [
    ...(p.replacements ?? []).map((r) => ({
      kind: typeof r.pattern === "string" ? "literal" : "regex",
      pattern: typeof r.pattern === "string" ? r.pattern : { source: r.pattern.source, flags: r.pattern.flags },
      replace: r.replace,
    })),
    ...(p.patterns ?? []).map((pat) => ({
      kind: typeof pat === "string" ? "literal" : "regex",
      pattern: typeof pat === "string" ? pat : { source: pat.source, flags: pat.flags },
      replace: p.replace ?? "",
    })),
  ],
  legacyShape: !p.replacements && Array.isArray(p.patterns),
}));

const out = {
  source: { pkg: "dsh-purge", version: "1.1.71", dshTarget: "0.2.0-rc.2" },
  generatedAt: new Date().toISOString(),
  counts: {
    patches: rows.length,
    rules: rows.reduce((a, r) => a + r.rules.length, 0),
    literalRules: rows.reduce((a, r) => a + r.rules.filter((x) => x.kind === "literal").length, 0),
    regexRules: rows.reduce((a, r) => a + r.rules.filter((x) => x.kind === "regex").length, 0),
    markers: rows.reduce((a, r) => a + r.markers.length, 0),
    optional: rows.filter((r) => r.optional).length,
  },
  patches: rows.sort((a, b) => a.id - b.id),
};

const dest = path.resolve(process.argv[2] || "engine/tables/purge-1.1.71.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`已导出 ${rows.length} 条补丁 / ${out.counts.rules} 条规则 → ${dest}`);
console.log(JSON.stringify(out.counts, null, 0));
