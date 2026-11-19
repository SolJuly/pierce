/**
 * 从宿主安装里取"模型可见文本"的真渲染函数。
 *
 * 为什么不自己实现一份：`formatFetchOutput` 是宿主每次 web_fetch 都会走的那个函数
 * （拼 header、加降权声明、html→markdown、按上限截断）。离线复现只要调它，
 * 出来的字节和线上完全一致。自己抄一份做实验，结论就不可信了。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const INSTALL =
  process.env.DSH_INSTALL ||
  "/usr/local/lib/nodejs/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

/**
 * 宿主安装是否可用。
 *
 * 这批测试钉的是**宿主行为**（turndown 丢什么、裁剪器留多少、降权声明放哪），
 * 所以必须有宿主才能跑。没有宿主的机器（例如 CI）应当**跳过**而不是硬失败 ——
 * 硬失败会让"环境没装"看起来像"代码坏了"。
 * @returns 宿主 tool-web 能否加载
 */
export function hostAvailable() {
  return fs.existsSync(path.join(INSTALL, "dsh-tool-web/lib/index.js"));
}

/** 动态 import 宿主模块（绝对路径，绕过模块解析）。 */
export async function loadToolWeb() {
  const entry = path.join(INSTALL, "dsh-tool-web/lib/index.js");
  const mod = await import(entry);
  if (typeof mod.formatFetchOutput !== "function") {
    throw new Error(`${entry} 没有导出 formatFetchOutput —— 宿主版本变了，先核对再跑`);
  }
  return mod;
}

void createRequire;
