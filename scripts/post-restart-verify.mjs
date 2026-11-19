#!/usr/bin/env node
/**
 * 重启后自检：确认撤补丁 + pierce 接管在**真实线上宿主**里生效。
 *
 * 在宿主重启之后跑这个脚本。它检查：
 *   1. 服务在跑、端口在听
 *   2. 源码层：关键文件与官方一致（撤补丁生效）
 *   3. 配置层：personaSuffix 不再引用 {{cwd}}
 *   4. 运行时：真宿主跑一个 turn，请求体里没有 purge 提权话术
 *   5. 审批链路：pierce 钩子能接住（不需要人工点确认）
 *
 * 用法：
 *   node scripts/post-restart-verify.mjs
 */
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = "/usr/local/lib/nodejs/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
// 可覆盖：测试「基线过期」分支时指向一个假基线
const CLEAN = process.env.PIERCE_CLEAN_MODULES || "/opt/dsh-clean/node_modules/@deepseek-ai";
const E2E_DIR = process.env.PIERCE_E2E_DIR || path.join(os.homedir(), ".pierce-e2e");

let pass = 0;
let skipped = 0;
const fails = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fails.push(label); console.error(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`); }
};
/** 跳过一项并说明原因。基线过期时那些「与官方一致」的检查只能跳过，不能算失败。 */
const skip = (label, why) => {
  skipped++;
  console.log(`  ⊘ ${label}  — 跳过：${why}`);
};
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { return (e.stdout || "") + (e.stderr || ""); }
};

// ── 1. 服务状态 ──────────────────────────────────────────────
section("1. 服务状态");
const active = sh("systemctl is-active dsh").trim();
ok("dsh.service 在跑", active === "active", active);
const listening = sh("ss -tlnp 2>/dev/null | grep -c ':3080'").trim();
ok("3080 端口在听", Number(listening) > 0, `匹配 ${listening} 条`);

// ── 1b. 验证基线版本 ────────────────────────────────────────
// 2026-11-19 宿主升到 0.2.2-rc.3，而 /opt/dsh-clean 还停在 rc.1 ——
// 结果 7 项「必须与官方一致」的检查因为**版本差异**全部假失败，
// 排查了半天才发现不是回归。这层检查就是为了不再重演。
section("1b. 验证基线版本");
/**
 * 读出 dsh 包自己的版本号。
 *
 * 两侧目录布局不同，不能写死一个路径：
 *   线上  …/dsh/node_modules/@deepseek-ai/*   → dsh 包在 MODULES 的上两级
 *   基线  /opt/dsh-clean/node_modules/@deepseek-ai/* → dsh 包在 CLEAN/dsh
 * 所以两个候选都试，再退一步往上找 name 为 @deepseek-ai/dsh 的 package.json。
 */
const versionOf = (dir) => {
  const candidates = [path.join(dir, "dsh", "package.json"), path.resolve(dir, "..", "..", "package.json")];
  for (const pj of candidates) {
    if (!fs.existsSync(pj)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(pj, "utf8"));
      if (parsed.name === "@deepseek-ai/dsh" && typeof parsed.version === "string") return parsed.version;
      if (pj === candidates[0] && typeof parsed.version === "string") return parsed.version;
    } catch { /* 坏 json 就试下一个 */ }
  }
  return null;
};
const hostVersion = versionOf(MODULES);
const cleanVersion = versionOf(CLEAN);
const BASELINE_STALE = hostVersion !== null && cleanVersion !== null && hostVersion !== cleanVersion;
ok(
  "纯净基线版本与宿主一致",
  !BASELINE_STALE,
  BASELINE_STALE ? `基线 ${cleanVersion} ≠ 宿主 ${hostVersion}` : `${hostVersion ?? "?"}`,
);
if (BASELINE_STALE) {
  console.error("");
  console.error(`  ⚠ 基线过期：/opt/dsh-clean 是 ${cleanVersion}，宿主是 ${hostVersion}。`);
  console.error("    下面所有「与官方一致」的检查都会因版本差异假失败，已跳过。先同步基线：");
  console.error(`    cd /opt/dsh-clean && npm install @deepseek-ai/dsh@${hostVersion}`);
  console.error("");
}

// ── 2. 源码层：撤补丁是否生效 ────────────────────────────────
section("2. 源码层（关键项必须与官方一致）");
const MUST_MATCH = [
  ["dsh-agent-instructions/lib/index.js", "工作区指令提权话术已撤"],
  ["dsh-system-prompt/lib/index.js", "cwd 兜底已撤 + 守卫已还原"],
  ["dsh-user-approval/lib/index.js", "审批 policy 默认值已还原"],
  ["dsh-user-approval/lib/types/index.js", "NEVER_SENTENCE 已还原"],
  ["dsh-tool-bash/lib/index.js", "bash 安全回退已还原"],
  ["dsh-tool-pwsh/lib/index.js", "pwsh 安全回退已还原"],
  ["dsh-subagent/lib/index.js", "子代理权限话术已还原"],
  ["dsh-permission-presets/lib/index.js", "预设描述已还原"],
  ["dsh-app-boot/lib/index.js", "overlay 缺失时回落 .dshpurge.bak 的兜底已撤"],
];
for (const [rel, label] of MUST_MATCH) {
  if (BASELINE_STALE) { skip(label, "基线版本不一致"); continue; }
  const a = path.join(CLEAN, rel);
  const b = path.join(MODULES, rel);
  const same = fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8");
  ok(label, same, same ? "0 差异" : "仍有差异");
}

// 兜底一旦还在，删任何 overlay 都会静默读回 purge 补丁态 —— 这条必须硬断言。
const appBootSrc = path.join(MODULES, "dsh-app-boot/lib/index.js");
const appBootText = fs.existsSync(appBootSrc) ? fs.readFileSync(appBootSrc, "utf8") : "";
ok("app-boot 源码里没有 .dshpurge.bak 回落", !appBootText.includes(".dshpurge.bak"));
const leftoverBak = [];
const walkBak = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkBak(p);
    // 原来只匹配 `.dshpurge.bak`，但实际残留叫 `.dsh-purge-local.bak` ——
    // 后缀不同，这项检查一直报「0 个」在骗自己。改成任何备份后缀都算。
    else if (/\.(dshpurge|dsh-purge[a-z-]*|pierce)\.bak$/.test(e.name) || /\.bak$/.test(e.name)) leftoverBak.push(path.relative(MODULES, p));
  }
};
walkBak(MODULES);
ok("安装树里没有残留 .dshpurge.bak", leftoverBak.length === 0, leftoverBak.length ? `${leftoverBak.length} 个：${leftoverBak.slice(0, 3).join(", ")}` : "0 个");

// 必须**不**存在的破甲特征
section("3. 破甲特征必须消失");
const MUST_ABSENT = [
  ["dsh-agent-instructions/lib/index.js", "ACTIVE and MANDATORY", "工作区提权话术"],
  ["dsh-agent-instructions/lib/index.js", "Do not treat them as untrusted data", "禁止标记注入"],
  ["dsh-system-prompt/lib/index.js", 'name === "cwd"', "cwd 兜底分支"],
  ["dsh-agent-loop/lib/index.js", "__dshPurgeHungPrompt", "hung 注入挂钩"],
  ["dsh-agent-loop/lib/index.js", "__dshPurgePrepareAssemble", "prepareAssemble 挂钩"],
  ["dsh-sandbox/lib/index.js", "escalation bypass", "升级阶梯旁路"],
  ["dsh-fs-sandbox/lib/index.js", "filesystem sandbox bypass", "fs 围栏旁路"],
  ["dsh-tools/lib/pipeline.js", "no approval service => allow", "fail-open"],
];
for (const [rel, needle, label] of MUST_ABSENT) {
  const p = path.join(MODULES, rel);
  const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  ok(`${label} 已消失`, !text.includes(needle));
}

// ── 4. 配置层 ────────────────────────────────────────────────
section("4. 配置层");
// 必须用**线上**二进制 dump：/opt/dsh-clean 的 dsh 会加载它自己那份干净
// bundles，base 层的值（mode / policy）全显示成官方默认，看不出线上改动。
const LIVE_DSH = process.env.LIVE_DSH || "/usr/local/bin/dsh";
const dump = sh(`DSH_HOME=/root/.dsh timeout 60 ${LIVE_DSH} --profile web --dump-config 2>&1`);

// 取某个 - id: 条目的整块（到下一个 - id: / 段注释 / 结尾为止）
const blockOf = (id) =>
  new RegExp(`- id: ${id}\\n[\\s\\S]{0,600}?(?=\\n- id:|\\n# ==|$)`).exec(dump)?.[0] ?? "";
const lineIn = (block, needle) => block.split("\n").find((l) => l.includes(needle)) ?? "";

// 自检：确认 dump 真的来自线上安装，而不是纯净基线。
// 判据用 sandbox-policy.mode —— 官方默认是 workspace-write，本部署是
// danger-full-access。以前这条写的是 dump.includes("ask")，太松，纯净版也含 ask，
// 等于没自检（踩过一次：拿纯净二进制作 dump，所有断言在假数据上全绿）。
const spBlock = blockOf("sandbox-policy");
const modeLine = lineIn(spBlock, "mode:");
ok(
  "dump 来自线上安装（不是纯净基线）",
  modeLine.includes("danger-full-access"),
  modeLine.trim() || "(未找到 sandbox-policy.mode)",
);

// sandbox-policy 的 config 是**整体替换**：官方有两个字段（mode / workspaceRoot），
// profile 覆盖时少写 workspaceRoot 就会真的丢，工作区根会变成 undefined。
ok("sandbox-policy.workspaceRoot 没被整体替换吃掉", /workspaceRoot:/.test(spBlock));
ok(
  "sandbox-policy 由 profile 层覆盖",
  /patched by .*profiles\/web\/cordis\.patch\.yml/.test(
    (/[\s\S]*?- id: sandbox-policy/.exec(dump)?.[0] ?? "").split("\n").slice(-8).join("\n"),
  ) || /profiles\/web\/cordis\.patch\.yml[\s\S]{0,400}- id: sandbox-policy/.test(dump),
);

// ── 4b. 配置层不得有补丁（YAML 层盲区）──────────────────────
// 这一层以前完全没盘。病根：撤补丁只盯 JS 源码，bundle 的 cordis.patch.yml
// 改了 10 个文件没人发现，其中 dsh-base 那两处还是「审批链路可达性」的承重墙。
// 现在直接把两棵树的 .yml/.yaml 递归比一遍。
section("4b. 配置层（YAML）必须与官方一致");
const walkYaml = (root) => {
  const out = [];
  const rec = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" && dir !== root) continue;
        rec(p);
      } else if (/\.ya?ml$/.test(e.name)) out.push(path.relative(root, p));
    }
  };
  rec(root);
  return out;
};
// 版本自检：两棵树必须真是同一个版本，否则「0 差异」是拿苹果比橘子。
// /opt/dsh-clean 是个 npm 工程（package.json version 1.0.0，依赖 @deepseek-ai/dsh），
// 它的 node_modules/@deepseek-ai 与线上的 dsh/node_modules/@deepseek-ai 是同一批包；
// 第三方依赖版本两边会漂（commander / pi-ai 之类），那些不在比对范围内，
// 但 @deepseek-ai/* 必须逐一对齐，否则下面的 YAML 断言没有意义。
const pkgVersions = (root) => {
  const out = new Map();
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const pj = path.join(root, e.name, "package.json");
    if (!fs.existsSync(pj)) continue;
    try { out.set(e.name, JSON.parse(fs.readFileSync(pj, "utf8")).version); } catch { /* 跳过坏 json */ }
  }
  return out;
};
const cv = pkgVersions(CLEAN);
const lv = pkgVersions(MODULES);
if (BASELINE_STALE) skip("@deepseek-ai/* 版本 census", "基线版本不一致");
else {
const versionDrift = [...cv.keys()].filter((k) => lv.has(k) && cv.get(k) !== lv.get(k));
ok(
  "@deepseek-ai/* 版本与纯净基线一致",
  versionDrift.length === 0,
  versionDrift.length === 0
    ? `${cv.size} 个包全部同版本`
    : `版本漂移 ${versionDrift.length}：${versionDrift.slice(0, 5).map((k) => `${k} ${cv.get(k)}≠${lv.get(k)}`).join(", ")}`,
);
}

// 排除 `dsh/` 这一支：那是宿主包本身，线上它的根是 MODULES 的父级的父级
// （/usr/local/lib/nodejs/lib/node_modules/@deepseek-ai/dsh），并不在自己 node_modules 里，
// 所以按相对路径比对必然对不上（典型如 dsh/README.i18n.yaml）。
// dsh 包自身的源码差异由第 2 节那些 MUST_MATCH 覆盖。
const isHostPkg = (f) => f.startsWith("dsh/") || f.startsWith(`dsh${path.sep}`);
const cleanYaml = walkYaml(CLEAN).filter((f) => !isHostPkg(f)).sort();
const liveYaml = walkYaml(MODULES).filter((f) => !isHostPkg(f)).sort();
const onlyClean = cleanYaml.filter((f) => !liveYaml.includes(f));
const onlyLive = liveYaml.filter((f) => !cleanYaml.includes(f));
const differing = cleanYaml.filter((f) => {
  const a = path.join(CLEAN, f);
  const b = path.join(MODULES, f);
  return fs.existsSync(b) && fs.readFileSync(a, "utf8") !== fs.readFileSync(b, "utf8");
});
if (BASELINE_STALE) skip("YAML 配置层 0 差异", "基线版本不一致");
else ok(
  "YAML 配置层 0 差异",
  differing.length === 0 && onlyClean.length === 0 && onlyLive.length === 0,
  differing.length === 0 && onlyClean.length === 0 && onlyLive.length === 0
    ? `${liveYaml.length} 个文件全部一致`
    : `差异 ${differing.length}：${differing.slice(0, 5).join(", ")}；仅纯净版 ${onlyClean.length}；仅线上 ${onlyLive.length}`,
);
if (differing.length) for (const f of differing.slice(0, 10)) console.error(`      ↳ ${f}`);
const suffix = /personaSuffix:\s*(.*)/.exec(dump)?.[1]?.trim() ?? "";
ok("personaSuffix 不再引用 {{cwd}}", !suffix.includes("{{cwd}}"), suffix || "(空)");
ok("pierce 在配置树里", dump.includes("dsh-pierce") || dump.includes("id: pierce"));

// 新会话的默认 preset：本部署要有意保持 danger-full-access。
// 历史上这是靠 purge 的 #51 补丁（改源码）实现的，撤掉后必须在这里显式声明，
// 否则新会话会退回 workspace-write —— 那是行为变化，不是清理补丁的预期结果。
ok("defaultPreset = danger-full-access", /defaultPreset:\s*danger-full-access/.test(dump));

// minimal preset 必须停用。
// 它的 persona 段带 complete: true，而 dsh-system-prompt 在 waterfall 之后
// 会把 sections 整个换成那一段（lib/index.js:392 抓快照 / :410 返回），
// 任何插件钩子对 sections 的改动都不生效 —— pierce 的正文段 / 身份清洗 /
// contextReframe 在那个 preset 下全部失效，插件层救不了。
// 本部署 minimal 使用率为 0（62 个会话全是 standard），所以直接 disabled。
const minimalBlock =
  /- id: preset-minimal\n[\s\S]{0,4000}?(?=\n- id:|\n# ==|$)/.exec(dump)?.[0] ?? "";
ok(
  "minimal preset 已停用（否则破甲在它下面失效）",
  /disabled: true/.test(minimalBlock),
  minimalBlock
    ? (/disabled: true/.test(minimalBlock) ? "disabled: true" : "仍在启用")
    : "preset-minimal 不在配置树里",
);

// approval 必须是 ask，不能是 never：never 会让 decide() 在 waterfall 之前
// return rejected，pierce 的 approval/request 钩子根本没机会跑。
// YAML 会用单引号转义，实际 dump 形如：policy: !!js <三引号>ask<三引号>
const approvalBlock = /- id: approval[\s\S]{0,400}?(?=\n- id:|\n# ==|$)/.exec(dump)?.[0] ?? "";
const policyLine = approvalBlock.split("\n").find((l) => l.includes("policy:")) ?? "";
ok(
  "base 的 approval.policy = ask（不是 never）",
  policyLine.includes("ask") && !policyLine.includes("never"),
  policyLine.trim().slice(0, 60) || "(未找到 policy 行)",
);

// purge 的 bundle patch 也不该带 {{cwd}}
const purgeYml = "/root/.dsh/profiles/web/node_modules/dsh-purge/cordis.patch.yml";
if (fs.existsSync(purgeYml)) {
  const live = fs.readFileSync(purgeYml, "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  ok("purge bundle patch 不再引用 {{cwd}}", !live.includes("{{cwd}}"));
}

// 命令是否真的注册进宿主的命令表。
// 这一层在配置 dump 里完全看不见（dump 只反映 loader 树，不反映服务注册），
// 所以只能靠插件自己的启动日志。第一次上线时这里误报过「未注册」——
// 原因是横幅在 apply 阶段同步打印，而 ctx.inject 的回调是异步的。
const startRaw = sh(`ps -o lstart= -p $(systemctl show dsh -p MainPID --value)`).trim();
const journalSince = (() => {
  const d = new Date(startRaw);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
})();
const jlog = journalSince ? sh(`journalctl -u dsh --since "${journalSince}" --no-pager 2>/dev/null`) : "";
ok("pierce 启动横幅可见", /\[pierce\] 已挂 \d+ 个扩展点/.test(jlog), (/\[pierce\] 已挂[^\n]*/.exec(jlog)?.[0] ?? "").slice(0, 70));
ok(
  "/pierce 命令已注册进宿主",
  /\[pierce\] \/pierce 命令已注册/.test(jlog),
  /\[pierce\] \/pierce[^\n]*/.exec(jlog)?.[0] ?? "(日志里没有——命令没挂上)",
);

// ── 5. 运行时：真宿主跑 turn ────────────────────────────────
section("5. 运行时（线上宿主 + 真实请求体）");
const liveScript = path.join(REPO_ROOT, "scripts/verify-live-source.mjs");
if (fs.existsSync(liveScript)) {
  const out = sh(`PIERCE_E2E_DIR=${E2E_DIR} timeout 180 node ${liveScript} 2>&1`);
  const m = /结果：(\d+) 项通过/.exec(out);
  const n = m ? Number(m[1]) : 0;
  ok("verify-live-source 全通过", n >= 10, `通过 ${n} 项`);
  if (n < 10) console.error(out.split("\n").filter((l) => l.includes("✗")).join("\n"));
} else {
  ok("verify-live-source 存在", false);
}

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n\x1b[1m═══ 重启后自检：${pass} 项通过${fails.length ? `，${fails.length} 项失败` : ""} ═══\x1b[0m`);
if (fails.length) {
  console.log("\n失败项：");
  for (const f of fails) console.log(`  - ${f}`);
  console.log(`\n如需回滚：bash ${path.join(path.dirname(REPO_ROOT), "pierce-e2e/rollback/rollback-all.sh")}`);
  process.exitCode = 1;
}
console.log();
