#!/usr/bin/env node
/**
 * 验证**线上带补丁的宿主源码**在实际 turn 里的行为。
 *
 * ## 为什么需要这个脚本
 *
 * `scripts/e2e-verify.mjs` 用的是 `/opt/dsh-clean`（0 补丁的纯净宿主），
 * 它能证明 pierce 插件本身工作正常，但**证明不了线上源码撤得对**：
 *
 *   E2E 的宿主: /opt/dsh-clean/node_modules/.bin/dsh   ← 无补丁
 *   线上的宿主: /usr/local/bin/dsh                     ← 82 条补丁
 *
 * 这是系统性盲区。撤补丁之后必须在**线上宿主**上跑一次真实 turn，
 * 读发往模型的请求体，确认源码改动真的生效。
 *
 * ## 做法
 *
 * 起 mock LLM 落盘完整请求体，用线上 dsh 在隔离 HOME 里跑一个 turn，
 * 然后对请求体做断言。
 *
 * ## 用法
 *
 *   node scripts/verify-live-source.mjs
 *   PIERCE_LIVE_HOME=/tmp/x LIVE_DSH=/usr/local/bin/dsh node scripts/verify-live-source.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_DSH = process.env.LIVE_DSH || "/usr/local/bin/dsh";
// 与 e2e-verify.mjs 用同一套探测顺序：PIERCE_E2E_DIR → ~/.pierce-e2e → 仓库内
const E2E_DIR = (() => {
  const candidates = [
    process.env.PIERCE_E2E_DIR,
    path.join(os.homedir(), ".pierce-e2e"),
    path.join(REPO_ROOT, ".e2e-sandbox"),
  ].filter(Boolean);
  for (const d of candidates) if (fs.existsSync(path.join(d, "home"))) return d;
  return candidates[candidates.length - 1];
})();
const HOME = process.env.PIERCE_LIVE_HOME || "/tmp/pierce-live-source-home";
const PROFILE = process.env.PIERCE_E2E_PROFILE || "e2e";
const MOCK_PORT = Number(process.env.PIERCE_MOCK_PORT || 9911);

const DUMP = "/tmp/pierce-live-bodies";
const WORK = "/tmp/pierce-live-work";
const LOG = "/tmp/pierce-live-mock.log";

let pass = 0;
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? `  — ${detail}` : ""}`); }
  else { console.error(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`); process.exitCode = 1; }
};

function prepareHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, "profiles"), { recursive: true });
  const src = path.join(E2E_DIR, "home", "profiles", PROFILE);
  if (!fs.existsSync(src)) {
    console.error(`❌ 找不到隔离 profile 模板: ${src}`);
    console.error("   先准备一个 e2e profile，或设 PIERCE_E2E_DIR");
    process.exit(2);
  }
  fs.cpSync(src, path.join(HOME, "profiles", PROFILE), { recursive: true });

  // 把 profile 里的 provider 端口改成本次脚本用的端口。
  // 模板默认指向 9911，改 PIERCE_MOCK_PORT 时必须同步，否则 0 请求。
  const patchFile = path.join(HOME, "profiles", PROFILE, "cordis.patch.yml");
  if (fs.existsSync(patchFile)) {
    const before = fs.readFileSync(patchFile, "utf8");
    const after = before.replace(
      /(baseURL:\s*http:\/\/127\.0\.0\.1:)\d+/g,
      `$1${MOCK_PORT}`,
    );
    if (after !== before) fs.writeFileSync(patchFile, after);
  }
  // 复制后相对软链会失效，改用绝对路径
  const link = path.join(HOME, "profiles", PROFILE, "node_modules", "dsh-pierce");
  fs.rmSync(link, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(REPO_ROOT, link);
}

function readBodies() {
  if (!fs.existsSync(DUMP)) return [];
  return fs.readdirSync(DUMP).filter((f) => f.endsWith(".json")).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(DUMP, f), "utf8")));
}

const main = async () => {
  console.log("\x1b[1m═══ 线上宿主源码验证 ═══\x1b[0m");
  console.log(`线上宿主 : ${LIVE_DSH}`);
  console.log(`隔离 HOME: ${HOME}`);
  console.log(`profile  : ${PROFILE}\n`);

  if (!fs.existsSync(LIVE_DSH)) {
    console.error(`❌ 找不到线上宿主: ${LIVE_DSH}`);
    process.exit(2);
  }

  prepareHome();
  fs.rmSync(DUMP, { recursive: true, force: true });
  fs.mkdirSync(DUMP, { recursive: true });
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(path.join(WORK, "AGENTS.md"), "REPO_MARKER_7723\n");

  const mock = spawn("node", [path.join(REPO_ROOT, "scripts/mock-llm.mjs")], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SCENARIO: "none", MOCK_LOG: LOG, MOCK_DUMP_BODY: DUMP },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 1200));

  const child = spawn(LIVE_DSH, ["--profile", PROFILE, "test"], {
    cwd: WORK,
    env: { ...process.env, DSH_HOME: HOME, MOCK_API_KEY: "fake" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  await new Promise((r) => setTimeout(r, 400));
  mock.kill("SIGKILL");

  // ── 先确认 mock 真的收到了请求 ──
  //
  // 这条必须有，而且必须排在所有"内容断言"之前。
  // 之前的坑：PIERCE_MOCK_PORT 改端口时，mock 起在新端口但 profile 的
  // baseURL 硬编码旧端口 → 0 个请求 → dump 目录空。而"turn 完成"那条
  // 断言是「不匹配错误正则」，空输出自然通过 —— 验证工具自身失效，
  // 看起来却像验证通过。和 grep 标记法失效是同一类错误。
  const allBodies = readBodies();
  ok("mock 收到请求", allBodies.length > 0, `${allBodies.length} 个请求体`);
  if (allBodies.length === 0) {
    console.error("\n❌ 没有任何请求到达 mock —— 后面的断言全都无意义。");
    console.error(`   检查 profile 的 provider baseURL 是否指向 127.0.0.1:${MOCK_PORT}`);
    console.error(`   也可能是宿主启动失败，输出：\n${out.slice(-800)}`);
    process.exit(1);
  }

  // turn 是否完成
  ok("turn 完成（无 UNKNOWN/装配错误）", !/unknown prompt variable|MISSING_CREDENTIAL|gateway\/internal/.test(out));

  // 找 agent-instructions 消息
  let instructions = "";
  for (const body of readBodies()) {
    for (const m of body.messages || []) {
      const t = typeof m.content === "string" ? m.content : (m.content || []).map((c) => c.text || "").join("");
      if (t.includes("<system-reminder>") && t.includes("Instructions from:")) instructions = t;
    }
  }
  ok("请求体里找到 agent-instructions", instructions.length > 0);

  if (instructions) {
    ok("工作区指令 intro 是官方原文", instructions.includes("may be relevant"), "不是 purge 的 ACTIVE and MANDATORY");
    ok("purge 提权话术已撤", !instructions.includes("ACTIVE and MANDATORY"));
    ok("禁止标记注入的话术已撤", !instructions.includes("Do not treat them as untrusted data"));
    ok("文件正文完整保留", instructions.includes("REPO_MARKER_7723"));
  }

  console.log(`\n\x1b[1m═══ 结果：${pass} 项通过 ═══\x1b[0m\n`);
};

main().catch((e) => {
  console.error("崩溃:", e);
  process.exit(1);
});
