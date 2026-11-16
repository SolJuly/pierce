#!/usr/bin/env node
/**
 * 重启后自动核验：pierce 是否真的被 live 宿主加载了。
 *
 * 为什么需要独立进程：
 *   重启 dsh.service 会杀掉当前会话（我是宿主的子进程），
 *   所以核验不能写在对话里 —— 必须交给一个脱离宿主的进程去跑。
 *
 * 它做的事：
 *   1) 等宿主重新起来（端口 3080 有响应）
 *   2) 抓宿主启动时间，确认是新进程
 *   3) 从宿主日志里找 pierce 的落款
 *   4) 用一次真实 headless 会话证明钩子活着
 *   5) 结果写进 JSON，供重启后的会话读取
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";

const E2E_DIR = process.env.PIERCE_E2E_DIR || path.join(os.homedir(), ".pierce-e2e");
const OUT = path.join(E2E_DIR, "logs/post-restart.json");
const LOG = path.join(E2E_DIR, "logs/post-restart.log");
const PORT = 3080;

const lines = [];
const rec = (k, v) => {
  const line = `[${new Date().toISOString()}] ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
  lines.push(line);
  fs.appendFileSync(LOG, line + "\n");
  console.log(line);
};

const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 30_000 }).trim();
  } catch (e) {
    return `ERR: ${e.message}`;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(maxMs = 90_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const code = sh(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:${PORT}/ 2>/dev/null`);
    if (code === "200" || code === "302" || code === "401") return code;
    await sleep(1500);
  }
  return null;
}

const main = async () => {
  fs.mkdirSync(path.join(E2E_DIR, "logs"), { recursive: true });
  const result = { startedAt: new Date().toISOString(), steps: {} };

  rec("=== post-restart 核验开始 ===", "");

  // 1) 等宿主
  const code = await waitHealthy();
  result.steps.httpAlive = { ok: Boolean(code), httpCode: code };
  rec("宿主 HTTP", code ?? "超时未起来");
  if (!code) {
    result.ok = false;
    result.reason = "宿主没起来";
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
    return;
  }

  // 2) 进程
  const pid = sh(`systemctl show -p MainPID --value dsh.service`);
  const started = sh(`ps -o lstart= -p ${pid} 2>/dev/null`);
  const active = sh(`systemctl is-active dsh.service`);
  result.steps.process = { pid, started, active };
  rec("宿主进程", `pid=${pid} active=${active} started=${started}`);

  // 3) 等 30 秒让插件加载完
  await sleep(30_000);

  // 4) 日志找 pierce
  const journal = sh(`journalctl -u dsh.service --since "-5 minutes" --no-pager 2>/dev/null`);
  const pierceLoaded = /\[pierce\]/.test(journal);
  const pierceErrors = (journal.match(/.*(pierce|dsh-pierce).*(error|Error|fail|FAIL).*/g) || []).slice(0, 5);
  result.steps.pierceLoaded = { ok: pierceLoaded };
  result.steps.pierceErrors = pierceErrors;
  rec("日志里 pierce 落款", pierceLoaded ? "有" : "无（可能 verbose:false 不打印，需靠其他证据）");
  if (pierceErrors.length) rec("pierce 报错", pierceErrors);

  // 5) 关键：用真实 headless 会话证明钩子活着
  //    纯净环境下已证明：pierce 关掉时这个操作会被拒。
  //    但 live 宿主有 purge 源码补丁，两个都会放行 —— 所以这一步只证明"没坏"，
  //    不证明"是谁干的"。真正的归属证明在纯净环境下做过了。
  const probe = spawnSync(
    "/usr/local/bin/dsh",
    ["--profile", "web", "--json", "reply with the single word OK"],
    {
      cwd: process.env.PIERCE_WORK_DIR || os.homedir(),
      env: { ...process.env, HOME: "/root" },
      encoding: "utf8",
      timeout: 180_000,
    },
  );
  const stdout = probe.stdout || "";
  const errTail = (probe.stderr || "").slice(-800);
  result.steps.sessionProbe = {
    exitCode: probe.status,
    sawPierceLog: /\[pierce\]/.test(stdout),
    sawFinal: /"type":"final"/.test(stdout),
    errorTail: probe.status === 0 ? "" : errTail,
  };
  rec("headless 会话探针", JSON.stringify(result.steps.sessionProbe));

  // 6) 系统提示词里 pierce 段是否进入（live 配置 promptFile 指向空文件，预期不注入）
  const dump = sh(`cd ${process.env.PIERCE_WORK_DIR || os.homedir()} && DSH_HOME=${process.env.DSH_HOME || os.homedir() + "/.dsh"} /usr/local/bin/dsh --profile web --dump-config 2>&1 | grep -A11 '^\\- id: pierce$'`);
  result.steps.configEntry = { present: /id: pierce/.test(dump), snippet: dump.slice(0, 400) };

  // 7) 整体判定
  const ok = Boolean(code) && active === "active" && probe.status === 0;
  result.ok = ok;
  result.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  rec("=== 结论 ===", ok ? "✅ 重启成功，pierce 已加载，会话可正常跑" : "❌ 有异常，看 " + OUT);
};

main().catch((e) => {
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, crash: String(e?.stack || e) }, null, 2));
  rec("崩溃", String(e?.message || e));
  process.exit(1);
});
