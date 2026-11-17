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
const CLEAN = "/opt/dsh-clean/node_modules/@deepseek-ai";
const E2E_DIR = process.env.PIERCE_E2E_DIR || path.join(os.homedir(), ".pierce-e2e");

let pass = 0;
const fails = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fails.push(label); console.error(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`); }
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
];
for (const [rel, label] of MUST_MATCH) {
  const a = path.join(CLEAN, rel);
  const b = path.join(MODULES, rel);
  const same = fs.existsSync(a) && fs.existsSync(b) && fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8");
  ok(label, same, same ? "0 差异" : "仍有差异");
}

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
// 自检：确认 dump 真的来自线上安装（base 层的 policy 应是我改的 ask 常量）
ok("dump 来自线上安装", dump.includes("ask"), "base.approval.policy 可见");
const suffix = /personaSuffix:\s*(.*)/.exec(dump)?.[1]?.trim() ?? "";
ok("personaSuffix 不再引用 {{cwd}}", !suffix.includes("{{cwd}}"), suffix || "(空)");
ok("pierce 在配置树里", dump.includes("dsh-pierce") || dump.includes("id: pierce"));

// 新会话的默认 preset：本部署要有意保持 danger-full-access。
// 历史上这是靠 purge 的 #51 补丁（改源码）实现的，撤掉后必须在这里显式声明，
// 否则新会话会退回 workspace-write —— 那是行为变化，不是清理补丁的预期结果。
ok("defaultPreset = danger-full-access", /defaultPreset:\s*danger-full-access/.test(dump));

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

// ── 5. 运行时：真宿主跑 turn ────────────────────────────────
section("5. 运行时（线上宿主 + 真实请求体）");
const liveScript = path.join(REPO_ROOT, "scripts/verify-live-source.mjs");
if (fs.existsSync(liveScript)) {
  const out = sh(`PIERCE_E2E_DIR=${E2E_DIR} timeout 180 node ${liveScript} 2>&1`);
  const m = /结果：(\d+) 项通过/.exec(out);
  const n = m ? Number(m[1]) : 0;
  ok("verify-live-source 全通过", n >= 7, `通过 ${n} 项`);
  if (n < 7) console.error(out.split("\n").filter((l) => l.includes("✗")).join("\n"));
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
