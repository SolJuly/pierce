#!/usr/bin/env node
/**
 * 分发自检：装完这个包，正文是不是现成的。
 *
 * ## 为什么单独一条
 *
 * `buildPresetDeclaration` 在正文为空时抛错、预设静默不注册（只有一行 console.warn）。
 * 而 prompt 通道那段 text 返回空串时也只是被 renderPrompt 滤掉，什么都不报。
 * 结果：用户装完插件，看到的是「审批自动放行生效了」，破甲正文一个字没进 ——
 * 两个通道同时哑掉，没有任何一处会红。
 *
 * 这条检查把「全新机器 + 默认配置」这个场景单独钉住：临时造一个空的 $DSH_HOME，
 * 不往里放任何文件，然后要求预设能注册、正文长度像样。
 *
 * 它必须用子进程跑：`promptCandidates` 在读 `process.env.DSH_HOME`，
 * 而这个进程自己可能已经被宿主设过 DSH_HOME 了。
 *
 * ## 用法
 *
 *   node scripts/check-bundle-prompt.mjs     # 退出码 0 = 开箱可用
 *   （CI 里紧跟 gen-pierce-preset --check 之后跑）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pierce-bundle-check-"));

// 断言逻辑跑在子进程里，且显式把 cwd 钉在包根 —— 相对路径的 import 才不依赖调用者在哪。
const probe = `
import { pathToFileURL } from "node:url";
const url = pathToFileURL(${JSON.stringify(path.join(ROOT, "lib/index.js"))}).href;
const { buildPresetDeclaration, promptCandidates } = await import(url);

// 与 cordis.patch.yml 里 pierce 行的 promptFile 保持一致
const cfg = { promptFile: "prompt-inject.md" };

const candidates = promptCandidates(cfg);
if (candidates.length !== 2) {
  console.error("失败：候选路径应有「用户文件 → 包内」两段，实际 " + JSON.stringify(candidates));
  process.exit(1);
}

let declaration;
try {
  declaration = buildPresetDeclaration(cfg);
} catch (error) {
  console.error("失败：空 $DSH_HOME 下预设注册抛错 —— " + error.message);
  console.error("这就是新用户装完拿到「会放审批的空壳」的那条路径。");
  process.exit(1);
}

const persona = declaration.plugins.find((row) => row?.id === "persona");
const text = persona?.config?.prefix ?? "";
if (text.includes("@@PIERCE_PROMPT@@")) {
  console.error("失败：persona 里还是占位符，正文没换上");
  process.exit(1);
}
if (text.length < 15000) {
  console.error("失败：正文只有 " + text.length + " 字符，包内那份应该是 2 万上下");
  process.exit(1);
}
if (persona.config.complete !== true) {
  console.error("失败：persona 没有 complete:true，会跟插件那段双份注入");
  process.exit(1);
}

console.log("开箱可用：空 $DSH_HOME 下预设注册成功，persona 带 " + text.length + " 字符正文（" + declaration.plugins.length + " 行）");
console.log("候选路径：" + candidates.join("  →  "));
`;

try {
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: home },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  process.stdout.write(stdout);
  process.exit(0);
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  process.exit(error.status ?? 1);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
