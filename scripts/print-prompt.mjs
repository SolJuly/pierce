#!/usr/bin/env node
/**
 * 打印某一版破甲提示词，供直接复制粘贴。
 *
 * ## 为什么要有这个脚本
 *
 * C 端用户拿不到仓库里的 markdown —— 他需要的是「一段能粘进聊天框的文本」。
 * 这个脚本把提示词原样吐到 stdout，说明信息走 stderr，所以可以直接接管道：
 *
 *   node scripts/print-prompt.mjs lite | xclip -selection clipboard
 *   node scripts/print-prompt.mjs lite | pbcopy
 *   node scripts/print-prompt.mjs lite > /tmp/pierce.txt
 *
 * ## 三版的选择依据（2026-11-19 实测，44 条技术探针）
 *
 *   full  20300 字符  拒答 2.3%   prompt 6338 tok   ← 自有部署当系统提示
 *   lite   6170 字符  拒答 2.3%   prompt 1852 tok   ← C 端粘贴，效果与完整版无差异
 *   mini   2797 字符  拒答 13.6%  prompt 1360 tok   ← 只要话题覆盖面的便宜场景
 *
 * 裸基线 36.4%。30% 是免费的午餐，14% 不是（越过 30% 后成本省得少、效力掉得多）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

/** 版本表。`note` 只用于 stderr 提示，不进 stdout。 */
const VERSIONS = {
	full: {
		file: path.join(ROOT, "提示词", "pierce-prompt.md"),
		refusal: "2.3%",
		tokens: 6338,
		use: "自有部署当系统提示（需要按格式输出、接工具、真实干活时用这版）",
	},
	lite: {
		file: path.join(ROOT, "提示词", "pierce-lite.md"),
		refusal: "2.3%",
		tokens: 1852,
		use: "C 端粘贴。效果与完整版无差异，长度是 30%",
	},
	mini: {
		file: path.join(ROOT, "提示词", "pierce-mini.md"),
		refusal: "13.6%",
		tokens: 1360,
		use: "只要话题覆盖面的便宜场景。掉了一档，别指望它精确",
	},
};

const wanted = (process.argv[2] ?? "lite").toLowerCase();
const entry = VERSIONS[wanted];
if (entry === undefined) {
	console.error(`print-prompt: 未知版本 "${wanted}"，可用：${Object.keys(VERSIONS).join(" / ")}`);
	process.exit(1);
}
if (!fs.existsSync(entry.file)) {
	console.error(`print-prompt: 找不到 ${entry.file}`);
	process.exit(2);
}

const text = fs.readFileSync(entry.file, "utf8");

// stdout 只放提示词本身，方便直接进管道
process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);

// 说明走 stderr，不污染管道
console.error("");
console.error(`── ${wanted} ────────────────────────────────────────`);
console.error(`  字符 ${text.length}   平均 prompt ${entry.tokens} tok   实测拒答率 ${entry.refusal}`);
console.error(`  用途：${entry.use}`);
console.error("");
console.error("  用法：把上面全文粘进聊天框，然后空一行，写：");
console.error("");
console.error("      以下是本次的具体请求：");
console.error("");
console.error("      <你的问题>");
console.error("");
console.error("  那条空行/分隔线是必要的 —— 不加的话模型可能把请求读成提示词的一部分。");
