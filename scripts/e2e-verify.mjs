#!/usr/bin/env node
/**
 * P0 端到端验证：证明 pierce 的宿主层钩子在**真实宿主**里真的生效。
 *
 * 为什么需要这个脚本：
 *   之前只有 plugin.test.mjs / cordis.test.mjs，用的是假 ctx。
 *   假 ctx 能证明"钩子返回了正确的值"，但证明不了"返回值真的让工具跑起来了"。
 *   这里用真 dsh 进程 + 真工具执行 + 落盘文件为证。
 *
 * 怎么做到零成本、确定性：
 *   起一个本地假 LLM（mock-llm.mjs），固定发射某个工具调用。
 *   免费渠道都已 throttled，付费渠道烧钱，而且真模型"这次肯不肯调工具"不可控。
 *   P0 要验证的是宿主链路，不是模型 —— 假模型反而更可靠。
 *
 * 三个场景，每个都有「开 pierce / 关 pierce」对照组：
 *   1) approval       bash 申请沙箱升级 → 需要 approval 通道
 *   2) tool-gate      探针强制 kind:"ask" → 需要 ask→allow 降级
 *   3) prompt         系统提示词里有没有 pierce:body 段
 *
 * 用法：
 *   node scripts/e2e-verify.mjs            # 跑全部
 *   node scripts/e2e-verify.mjs --only approval
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 所有路径都从环境变量取，并给出相对本仓库的合理默认值。
// 想跑这套 E2E，先准备一个纯净宿主和一个隔离的 DSH_HOME：
//
//   export DSH_CLEAN_ROOT=/opt/dsh-clean          # 官方原样安装
//   export PIERCE_E2E_DIR=/path/to/e2e-sandbox    # 隔离沙箱（home/ work/ logs/ 都在里面）
//   node scripts/e2e-verify.mjs
//
// PIERCE_E2E_DIR 下面需要：
//   home/profiles/e2e/   隔离的 DSH_HOME（挂 dsh-pierce + mock provider）
//   work/                工作目录
//   logs/                日志
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLEAN_ROOT = process.env.DSH_CLEAN_ROOT || "/opt/dsh-clean";

/**
 * 定位隔离沙箱。优先级：
 *   1. $PIERCE_E2E_DIR（显式指定）
 *   2. $HOME/.pierce-e2e（约定俗成的家目录位置）
 *   3. 仓库内 .e2e-sandbox（最后兜底，且该目录被 .gitignore 排除）
 * 选第一个「已经存在 home/profileName」的候选，全都没有就用候选 3 并给出提示。
 */
function resolveE2EDir(profile) {
  const candidates = [
    process.env.PIERCE_E2E_DIR,
    path.join(os.homedir(), ".pierce-e2e"),
    path.join(REPO_ROOT, ".e2e-sandbox"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "home", "profiles", profile))) return { dir, found: true };
  }
  return { dir: candidates[candidates.length - 1], found: false };
}

const PROFILE = process.env.PIERCE_E2E_PROFILE || "e2e";
const { dir: E2E_DIR, found: E2E_READY } = resolveE2EDir(PROFILE);

const E2E = {
  cleanDsh: path.join(CLEAN_ROOT, "node_modules/.bin/dsh"),
  home: path.join(E2E_DIR, "home"),
  work: path.join(E2E_DIR, "work"),
  logs: path.join(E2E_DIR, "logs"),
  mockScript: path.join(REPO_ROOT, "scripts/mock-llm.mjs"),
  probeDir: path.join(E2E_DIR, "ask-gate-probe"),
  profile: PROFILE,
  mockPort: Number(process.env.PIERCE_MOCK_PORT || 9911),
  proofBash: path.join(os.tmpdir(), "pierce-e2e-proof"),
  proofFs: path.join(E2E_DIR, "work/proof-fs-edit.txt"),
};

const only = (() => {
  const i = process.argv.indexOf("--only");
  return i > 0 ? process.argv[i + 1] : null;
})();

const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass, detail });
  const icon = pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${icon} ${name}${detail ? `  — ${detail}` : ""}`);
};

const env = (extra = {}) => ({
  ...process.env,
  DSH_HOME: E2E.home,
  PATH: `/opt/dsh-clean/node_modules/.bin:${process.env.PATH}`,
  MOCK_API_KEY: "e2e-test-key",
  ...extra,
});

/** 起假 LLM，返回 stop()。 */
function startMock(scenario) {
  fs.mkdirSync(E2E.logs, { recursive: true });
  const out = fs.openSync(path.join(E2E.logs, `mock-${scenario}.log`), "a");
  const proc = spawn("node", [E2E.mockScript], {
    env: env({ MOCK_SCENARIO: scenario, MOCK_PORT: String(E2E.mockPort) }),
    stdio: ["ignore", out, out],
    detached: true,
  });
  proc.unref();
  return {
    proc,
    stop: () => {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
    },
  };
}

async function waitMock(ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${E2E.mockPort}/v1/models`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** 跑一次 headless，返回解析后的事件。 */
function runTask(pierceEnabled, task = "e2e") {
  const r = spawnSync(E2E.cleanDsh, ["--profile", E2E.profile, "--json", task], {
    cwd: E2E.work,
    env: env({ PIERCE_ENABLED: pierceEnabled ? "1" : "0" }),
    encoding: "utf8",
    timeout: 180_000,
  });
  const events = [];
  for (const line of (r.stdout || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      /* ignore */
    }
  }
  return { events, stdout: r.stdout || "", stderr: r.stderr || "", code: r.status };
}

const toolResult = (events) => events.find((e) => e.type === "tool_result");
const toolCall = (events) => events.find((e) => e.type === "tool_call");

// ── 场景 1：approval/request ────────────────────────────────────────────────
async function scenarioApproval() {
  console.log("\n\x1b[1m场景 1：approval/request —— bash 申请沙箱升级需要审批通道\x1b[0m");
  const mock = startMock("bash");
  try {
    if (!(await waitMock())) return record("mock 启动", false, "假 LLM 没起来");

    // 实验组
    fs.rmSync(E2E.proofBash, { force: true });
    const on = runTask(true);
    const onCall = toolCall(on.events);
    const onResult = toolResult(on.events);
    const onRan = fs.existsSync(E2E.proofBash);
    record(
      "pierce 开 → 工具真的执行",
      onResult?.status === "completed" && onRan,
      `status=${onResult?.status} 落盘=${onRan}`,
    );
    record("pierce 开 → approval 钩子被调用", /approval auto-grant/.test(on.stdout), "");

    // 对照组
    fs.rmSync(E2E.proofBash, { force: true });
    const off = runTask(false);
    const offResult = toolResult(off.events);
    const offRan = fs.existsSync(E2E.proofBash);
    record(
      "pierce 关 → 同一操作被拒",
      offResult?.status === "error" && !offRan,
      `status=${offResult?.status} 落盘=${offRan}`,
    );
    record(
      "对照组错误信息指向审批缺失",
      /no approval channel is available|requires approval/.test(String(offResult?.result ?? "")),
      String(offResult?.result ?? "").slice(0, 80),
    );
  } finally {
    mock.stop();
  }
}

// ── 场景 2：tools/pre-execute 的 ask → allow ───────────────────────────────
async function scenarioToolGate() {
  console.log("\n\x1b[1m场景 2：tools/pre-execute —— 探针强制 kind:ask，pierce 应降级为 allow\x1b[0m");
  const mock = startMock("bash");
  try {
    if (!(await waitMock())) return record("mock 启动", false, "假 LLM 没起来");

    fs.rmSync(E2E.proofBash, { force: true });
    const on = runTask(true);
    const onResult = toolResult(on.events);
    const onRan = fs.existsSync(E2E.proofBash);
    record(
      "pierce 开 → ask 被降级，工具执行",
      onResult?.status === "completed" && onRan,
      `status=${onResult?.status} 落盘=${onRan}`,
    );
    record("降级分支真的被走到", /tool gate ask→allow/.test(on.stdout), "");

    fs.rmSync(E2E.proofBash, { force: true });
    const off = runTask(false);
    const offResult = toolResult(off.events);
    const offRan = fs.existsSync(E2E.proofBash);
    record(
      "pierce 关 → ask 不被降级，工具被挡",
      offResult?.status === "error" && !offRan,
      `status=${offResult?.status} 落盘=${offRan}`,
    );
  } finally {
    mock.stop();
  }
}

// ── 场景 3：提示词注入 ─────────────────────────────────────────────────────
async function scenarioPrompt() {
  console.log("\n\x1b[1m场景 3：system-prompt/assemble —— pierce:body 段是否真的进系统消息\x1b[0m");
  const mock = startMock("none");
  const dumpPath = path.join(E2E.logs, "assemble.json");
  try {
    if (!(await waitMock())) return record("mock 启动", false, "假 LLM 没起来");

    fs.rmSync(dumpPath, { force: true });
    runTask(true, "hello");
    if (!fs.existsSync(dumpPath)) return record("装配自检文件生成", false, "dumpAssemble 没写出来");

    const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
    const body = (dump.sections || []).find((s) => s.name === "pierce:body");
    record("pierce:body 段存在", Boolean(body), body ? `${body.chars} 字符` : "缺失");
    record("提示词正文非空且有实质内容", Boolean(body && body.chars > 5000), body ? `${body.chars} 字符` : "");

    const approval = (dump.contexts || []).find((c) => c.name === "approval:policy");
    record(
      "approval:policy 被改写成自动放行口径",
      Boolean(approval && /auto-granted/i.test(approval.head)),
      approval ? approval.head.slice(0, 60) : "缺失",
    );

    const identity = (dump.sections || []).find((s) => s.name === "harness:identity");
    record("harness 身份段被清空", !identity || identity.chars === 0, identity ? `${identity.chars} 字符` : "不存在");

    // 这条是「撤掉 9 个 bundle YAML 补丁」的验收：纯净宿主没有 dsh-purge，
    // web-app 的 YAML 给的是官方 personaPrefix
    // "You are a coding agent powered by the {{model}} model."。
    // 如果 pierce 的 personaStrips 没生效，这里会看到非零字符。
    const pre = (dump.sections || []).find((s) => s.name === "deployment:persona-prefix");
    record(
      "deployment:persona-prefix 被摘掉（替代改 9 个 bundle YAML）",
      !pre,
      pre ? `仍在，${pre.chars} 字符` : "已摘除",
    );
  } finally {
    mock.stop();
  }
}

// ── 场景 4：fs 三闸的真实状态（这条是"验证结论"，不是"通过/失败"）─────────
async function scenarioFs() {
  console.log("\n\x1b[1m场景 4：fs/{write,edit,delete}-intent —— 在官方默认组合里的实际作用面\x1b[0m");
  const r = spawnSync(E2E.cleanDsh, ["--profile", E2E.profile, "--dump-config"], {
    cwd: E2E.work,
    env: env({ PIERCE_ENABLED: "1" }),
    encoding: "utf8",
    timeout: 60_000,
  });
  const out = r.stdout || "";
  const m = out.match(/- id: fs-observation-policy\n\s+name: [^\n]+\n\s+disabled: (\w+)/);
  const disabled = m?.[1];
  record(
    "fs-observation-policy 默认状态已查明",
    disabled !== undefined,
    disabled === "true"
      ? "默认 disabled:true —— pierce 的 fs 三闸在默认组合里是空转（无害，但也没作用）"
      : `enabled(${disabled}) —— fs 三闸确实在保护链上`,
  );
}

const main = async () => {
  console.log("\x1b[1m═══ pierce P0 端到端验证 ═══\x1b[0m");
  console.log(`纯净宿主 : ${E2E.cleanDsh}`);
  console.log(`隔离 HOME: ${E2E.home}`);
  console.log(`profile  : ${E2E.profile}`);

  if (!fs.existsSync(E2E.cleanDsh)) {
    console.error(`❌ 找不到纯净宿主：${E2E.cleanDsh}`);
    console.error("   准备一个官方原样安装，然后 export DSH_CLEAN_ROOT=/path/to/that/install");
    process.exit(2);
  }
  if (!E2E_READY) {
    console.error(`❌ 找不到隔离沙箱：${E2E.home}/profiles/${E2E.profile}`);
    console.error("   需要的结构：");
    console.error(`     ${E2E_DIR}/home/profiles/${E2E.profile}/cordis.patch.yml   （挂 dsh-pierce + mock provider）`);
    console.error(`     ${E2E_DIR}/work/    ${E2E_DIR}/logs/`);
    console.error("   然后用 export PIERCE_E2E_DIR=<上面那个目录> 指定。");
    process.exit(2);
  }

  const run = { approval: scenarioApproval, "tool-gate": scenarioToolGate, prompt: scenarioPrompt, fs: scenarioFs };
  for (const [name, fn] of Object.entries(run)) {
    if (only && only !== name) continue;
    await fn();
  }

  const pass = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n\x1b[1m═══ 结果：${pass}/${total} 通过 ═══\x1b[0m`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log("\x1b[31m失败项：\x1b[0m");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }

  fs.writeFileSync(
    path.join(E2E.logs, "e2e-result.json"),
    JSON.stringify({ at: new Date().toISOString(), pass, total, results }, null, 2),
  );
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => {
  console.error("e2e 崩溃:", e);
  process.exit(3);
});
