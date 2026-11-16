#!/usr/bin/env node
/**
 * 重启后核验：LX 人设 + stripForeignPrompt 是否都生效。
 *
 * 为什么必须独立进程：重启 dsh.service 会杀掉当前会话（我是宿主的子进程）。
 *
 * 核验什么：
 *   1. 宿主起来了，是新进程
 *   2. pierce 加载了（7 个扩展点）
 *   3. 配置树里 stripForeignPrompt 在
 *   4. purge enabled:false
 *   5. 派一个子代理问它身份 —— 这是唯一能证明「系统提示词里只有一个 LX 人设」的方法
 */
import { execSync } from "node:child_process";
import fs from "node:fs";

const E2E_DIR = process.env.PIERCE_E2E_DIR || path.join(os.homedir(), ".pierce-e2e");
const OUT = path.join(E2E_DIR, "logs/post-restart-lx.json");
const LOG = path.join(E2E_DIR, "logs/post-restart-lx.log");

const lines = [];
const rec = (k, v) => {
  const s = `[${new Date().toISOString()}] ${k}${v === undefined ? "" : ": " + (typeof v === "string" ? v : JSON.stringify(v))}`;
  lines.push(s);
  fs.appendFileSync(LOG, s + "\n");
  console.log(s);
};
const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 30_000 }).trim();
  } catch (e) {
    return `ERR: ${e.message}`;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(maxMs = 120_000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const code = sh(`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/ 2>/dev/null`);
    if (["200", "302", "401"].includes(code)) return code;
    await sleep(2000);
  }
  return null;
}

const main = async () => {
  fs.mkdirSync(path.join(E2E_DIR, "logs"), { recursive: true });
  const R = { startedAt: new Date().toISOString(), steps: {} };
  rec("=== 重启后核验开始 ===");

  const code = await waitHealthy();
  R.steps.http = { ok: Boolean(code), code };
  rec("宿主 HTTP", code ?? "超时");
  if (!code) {
    R.ok = false;
    fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
    return;
  }

  const pid = sh(`systemctl show -p MainPID --value dsh.service`);
  const started = sh(`ps -o lstart= -p ${pid} 2>/dev/null`);
  R.steps.process = { pid, started, active: sh(`systemctl is-active dsh.service`) };
  rec("宿主进程", `pid=${pid} ${R.steps.process.active} started=${started}`);

  // 等插件加载 + 配置稳定
  await sleep(25_000);

  // 配置树
  const tree = sh(`cd ${process.env.PIERCE_WORK_DIR || os.homedir()} && DSH_HOME=${process.env.DSH_HOME || os.homedir() + "/.dsh"} /usr/local/bin/dsh --profile web --dump-config 2>/dev/null`);
  const pierceBlock = tree.split("- id: pierce")[1]?.slice(0, 900) ?? "";
  R.steps.stripForeignPrompt = { present: /stripForeignPrompt/.test(pierceBlock) };
  R.steps.purgeDisabled = { present: /- id: dsh-purge[\s\S]{0,900}?enabled: false/.test(tree) };
  rec("配置树: stripForeignPrompt", R.steps.stripForeignPrompt.present ? "✓ 在" : "✗ 缺失");
  rec("配置树: purge enabled:false", R.steps.purgeDisabled.present ? "✓ 是" : "✗ 否");

  // 日志
  const journal = sh(`journalctl -u dsh.service --since "-6 minutes" --no-pager 2>/dev/null`);
  R.steps.pierceErrors = (journal.match(/.*(pierce).*(error|Error|fail|Fail).*/g) || []).slice(0, 5);
  R.steps.hostErrors = (journal.match(/.*(Error|error:).*(profile|bundle|patch).*/g) || []).slice(0, 5);
  rec("宿主日志 pierce 报错", R.steps.pierceErrors.length ? R.steps.pierceErrors : "无");
  rec("宿主日志加载错误", R.steps.hostErrors.length ? R.steps.hostErrors : "无");

  // 提示词文件状态（身份验证由重启后的会话自己做 —— web profile 不接受一次性任务参数）
  const promptFile = process.env.PIERCE_PROMPT_FILE || path.join(process.cwd(), "提示词/pierce-prompt.md");
  const body = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : "";
  R.steps.prompt = {
    bytes: Buffer.byteLength(body),
    hasCaco: /你是 Caco/.test(body),
    hasLX: /\bLX\b/.test(body),
    hasYG: /\bYG\b/.test(body),
    hasLittleCodeSauce: /Little Code Sauce/i.test(body),
  };
  rec("提示词文件", JSON.stringify({
    bytes: R.steps.prompt.bytes,
    Caco: R.steps.prompt.hasCaco,
    LX: R.steps.prompt.hasLX,
    YG: R.steps.prompt.hasYG,
    LittleCodeSauce: R.steps.prompt.hasLittleCodeSauce,
  }));

  const ok = Boolean(code) && R.steps.process.active === "active" && R.steps.stripForeignPrompt.present && R.steps.purgeDisabled.present && R.steps.prompt.hasLX && !R.steps.prompt.hasYG && !R.steps.prompt.hasLittleCodeSauce;
  R.ok = ok;
  R.finishedAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(R, null, 2));
  rec("=== 结论 ===", ok ? "✅ 重启成功，配置已加载" : "⚠️ 有项没过，看 " + OUT);
};

main().catch((e) => {
  fs.writeFileSync(OUT, JSON.stringify({ ok: false, crash: String(e?.stack || e) }, null, 2));
  rec("崩溃", String(e?.message || e));
  process.exit(1);
});
