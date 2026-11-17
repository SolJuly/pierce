#!/usr/bin/env node
/**
 * 验证 pierce 的审批链路在**线上宿主**里真的接管了。
 *
 * ## 为什么需要这个
 *
 * purge 曾经把 `dsh-user-approval` 的 `decide()` 改成直接
 * `return "allowed-once"`（在 waterfall 之前），使得 pierce 的
 * `approval/request` 钩子是死代码。撤掉那条补丁之后，`decide()` 恢复成
 * 官方实现：
 *
 *   decide() → waterfall("approval/request") → pierce 钩子 → "allowed-once"
 *
 * 但这条链路在 `danger-full-access` 模式下测不出来 —— 那种模式下工具
 * 本来就不需要审批。必须让工具**申请升级**（带 `sandbox_permissions`），
 * 才会走到审批分支。
 *
 * ## 方法
 *
 * mock LLM 发射一个带 `sandbox_permissions: "danger-full-access"` 的 bash
 * 调用，触发"申请升级到更宽模式"的审批。跑两组对照：
 *   - pierce 开 → 钩子应被调用、工具应执行（落盘为证）
 *   - pierce 关 → 钩子不应被调用、工具应被拒
 *
 * ## 用法
 *
 *   node scripts/verify-approval-chain.mjs
 *   PIERCE_E2E_DIR=/root/pierce-e2e node scripts/verify-approval-chain.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIVE_DSH = process.env.LIVE_DSH || "/usr/local/bin/dsh";
const PROFILE = process.env.PIERCE_E2E_PROFILE || "e2e";
const MOCK_PORT = Number(process.env.PIERCE_MOCK_PORT || 9911);
const E2E_DIR = process.env.PIERCE_E2E_DIR || path.join(os.homedir(), ".pierce-e2e");
const WORK = path.join(os.tmpdir(), "pierce-approval-test");
const PROOF = path.join(os.tmpdir(), "pierce-e2e-proof");

let pass = 0;
const fails = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fails.push(label); console.error(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`); }
};

/** 准备一个隔离的 DSH_HOME（复制 e2e profile，软链指向本仓库）。 */
function prepareHome() {
  const home = path.join(WORK, "home");
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(path.join(home, "profiles"), { recursive: true });
  const src = path.join(E2E_DIR, "home", "profiles", PROFILE);
  if (!fs.existsSync(src)) {
    console.error(`❌ 找不到 profile 模板: ${src}`);
    console.error("   设 PIERCE_E2E_DIR 指向含 home/profiles/<profile> 的目录");
    process.exit(2);
  }
  fs.cpSync(src, path.join(home, "profiles", PROFILE), { recursive: true });
  // 复制后相对软链会失效，用绝对路径重建
  const link = path.join(home, "profiles", PROFILE, "node_modules", "dsh-pierce");
  fs.rmSync(link, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(REPO_ROOT, link);
  return home;
}

/** 跑一组：pierce 开或关。 */
async function run(pierceOn, home) {
  fs.rmSync(PROOF, { force: true });
  const mockLog = path.join(WORK, `mock-${pierceOn ? "on" : "off"}.log`);
  fs.writeFileSync(mockLog, "");

  const mock = spawn("node", [path.join(REPO_ROOT, "scripts/mock-llm.mjs")], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SCENARIO: "bash", MOCK_LOG: mockLog },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 1200));

  const child = spawn(LIVE_DSH, ["--profile", PROFILE, "run bash"], {
    cwd: WORK,
    env: {
      ...process.env,
      DSH_HOME: home,
      MOCK_API_KEY: "fake",
      PIERCE_ENABLED: pierceOn ? "1" : "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  await new Promise((r) => setTimeout(r, 400));
  mock.kill("SIGKILL");

  return {
    out,
    hookCalled: out.includes("approval auto-grant"),
    executed: fs.existsSync(PROOF),
    denied: /requires approval|no approval channel/i.test(out),
  };
}

const main = async () => {
  console.log("\n\x1b[1m═══ 审批链路验证（线上宿主）═══\x1b[0m");
  console.log(`宿主  : ${LIVE_DSH}`);
  console.log(`profile: ${PROFILE}\n`);

  if (!fs.existsSync(LIVE_DSH)) {
    console.error(`❌ 找不到线上宿主: ${LIVE_DSH}`);
    process.exit(2);
  }

  const home = prepareHome();

  console.log("\x1b[1mA. pierce 开启\x1b[0m");
  const on = await run(true, home);
  ok("approval 钩子被调用", on.hookCalled, on.hookCalled ? "[pierce] approval auto-grant" : "没打印");
  ok("工具真的执行（落盘为证）", on.executed);
  ok("没有审批拒绝迹象", !on.denied);

  console.log("\n\x1b[1mB. pierce 关闭（对照组）\x1b[0m");
  const off = await run(false, home);
  ok("approval 钩子未被调用", !off.hookCalled);
  ok("工具未执行", !off.executed);
  ok("拒绝信息指向审批通道", off.denied, "requires approval / no approval channel");

  console.log(`\n\x1b[1m═══ 结果：${pass} 项通过${fails.length ? `，${fails.length} 项失败` : ""} ═══\x1b[0m\n`);
  if (fails.length) {
    console.log("失败项：");
    for (const f of fails) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
};

main().catch((e) => {
  console.error("崩溃:", e);
  process.exit(1);
});
