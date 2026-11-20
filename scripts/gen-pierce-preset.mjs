#!/usr/bin/env node
/**
 * 生成「破甲模式」agent preset 的配置块。
 *
 * ## 为什么是生成而不是手写
 *
 * 一个 agent preset = persona + 一套工具集。工具集那部分（约 150 行）必须和宿主的
 * official `preset-standard` 保持一致，否则破甲模式里的工具就跟标准模式不一样。
 * 手抄一份会在宿主升级时悄悄漂掉。
 *
 * 所以这里**从官方 standard.patch.yml 派生**：原样搬它的 plugins 数组，只把
 * `persona` 那一行换成带破甲正文的版本。宿主装在哪、版本多少，跑一次就重新对齐。
 *
 * ## 为什么不自己写加载器
 *
 * 官方 standard 预设里有 4 个 `!!js` 表达式（平台判断、skills 路径、profileContext 判断）。
 * 在插件里重新实现一套 YAML 加载 + `!!js` 求值，等于把那套语义再写一遍 —— 不划算。
 * 直接把派生出来的块追加进 profile 的 `cordis.patch.yml`，复用宿主自己的加载器。
 *
 * ## 与 profile 级 pierce 插件的关系
 *
 * - 插件照常挂着：审批放行 / webGuard / 身份清洗在两种会话里都生效
 * - 插件注入的 `pierce:body` 段在破甲模式下会被 `complete: true` 丢弃 → **不会双份注入**
 * - 破甲模式 = 只吃 persona 里那份正文；standard 会话 = 吃插件注入那份。两者不叠加
 *
 * 代价：`complete: true` 会丢弃**所有** section，包括宿主的工具使用提示
 * （"Check the [exit code: N] marker" 之类）。破甲模式里模型只有正文 + 工具 schema 本身。
 *
 * ## 用法
 *
 *   node scripts/gen-pierce-preset.mjs                # 打印到 stdout
 *   node scripts/gen-pierce-preset.mjs --out <路径>   # 写文件
 *   node scripts/gen-pierce-preset.mjs --append       # 直接追加进线上 profile
 *
 * `--append` 会先做幂等检查：profile 里已经有 `id: preset-pierce` 就不再追加。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOST = process.env.DSH_INSTALL
	|| "/usr/local/lib/nodejs/lib/node_modules/@deepseek-ai/dsh";
const STANDARD = path.join(HOST, "node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml");
const PROMPT = "/root/破甲开发/提示词/pierce-prompt.md";
const PROFILE = "/root/.dsh/profiles/web/cordis.patch.yml";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(`--${flag}`);
const valueOf = (flag) => {
	const index = argv.indexOf(`--${flag}`);
	return index >= 0 ? argv[index + 1] : undefined;
};

if (!fs.existsSync(STANDARD)) {
	console.error(`gen-pierce-preset: 找不到官方 standard 预设 ${STANDARD}（设 DSH_INSTALL）`);
	process.exit(2);
}

const lines = fs.readFileSync(STANDARD, "utf8").split("\n");
const pluginsAt = lines.findIndex((line) => line.trim() === "plugins:");
if (pluginsAt < 0) {
	console.error("gen-pierce-preset: standard.patch.yml 里没有 plugins: 段，官方格式变了");
	process.exit(1);
}

/** 官方 plugins: 之后的全部内容（缩进 10 空格），去掉尾部空行。 */
const body = lines.slice(pluginsAt + 1);
while (body.length > 0 && body[body.length - 1].trim() === "") body.pop();

const PERSONA_ROWS = [
	"          - id: persona",
	"            name: '@deepseek-ai/dsh-persona'",
	"            config:",
	"              # 破甲正文作为**整个**系统提示（complete:true）。",
	"              # 用 !!js 直接读 .md：单一来源，改正文不用改这里，也不用把 2 万字内联进 YAML。",
	"              # 代价：complete:true 丢弃所有 section（含工具使用提示），见脚本头注释。",
	`              prefix: !!js process.getBuiltinModule('node:fs').readFileSync('${PROMPT}', 'utf8')`,
	"              complete: true",
	"              includeRuntimeContext: false",
];

const header = [
	"",
	"# ══ 破甲模式：一个可选 agent preset ══",
	"#",
	"# 形状照 @linxin666/dsh-liangshen：预设 = persona + 工具集，新建会话时可选。",
	"# 这里走 profile 层声明，复用宿主的 cordis.patch.yml 加载器 —— 官方 standard 预设里有",
	"# 4 个 !!js 表达式（平台判断 / skills 路径 / profileContext），自己重写加载器等于把",
	"# 那套语义再实现一遍，不划算。",
	"#",
	"# 工具集是从官方 standard.patch.yml **原样派生**的（只换 persona 一行），宿主升级后",
	"# 重新跑 scripts/gen-pierce-preset.mjs --append 即可对齐，不会漂。",
	"#",
	"# 与 profile 级 pierce 插件的关系：插件照常生效（审批放行 / webGuard / 身份清洗），",
	"# 但插件注入的 pierce:body 段在本模式里会被 complete:true 丢弃 → 不会双份注入。",
	"# 破甲模式只吃 persona 那份正文；standard 会话吃插件注入那份。两者不叠加。",
	"- insert:",
	"    - id: preset-pierce",
	"      name: '@deepseek-ai/dsh-agent-preset'",
	"      config:",
	"        id: pierce",
	"        order: 5",
	"        plugins:",
];

const out = [...header];
let replaced = false;
for (let i = 0; i < body.length; i += 1) {
	if (body[i].trim() === "- id: persona") {
		// 吃掉整块 persona 行，直到下一个同级 - id:
		let j = i + 1;
		while (j < body.length && !body[j].trim().startsWith("- id:")) j += 1;
		out.push(...PERSONA_ROWS);
		replaced = true;
		i = j - 1;
		continue;
	}
	out.push(body[i]);
}

if (!replaced) {
	console.error("gen-pierce-preset: 官方 standard 预设里找不到 persona 行，格式变了");
	process.exit(1);
}

const block = `${out.join("\n")}\n`;

const outPath = valueOf("out");
if (has("append")) {
	const current = fs.existsSync(PROFILE) ? fs.readFileSync(PROFILE, "utf8") : "";
	if (/^\s*- id: preset-pierce$/mu.test(current)) {
		console.log("profile 里已有 preset-pierce，跳过（要重建先手动删掉旧块）");
		process.exit(0);
	}
	fs.writeFileSync(PROFILE, `${current.replace(/\n+$/u, "")}\n${block}`);
	console.log(`已追加到 ${PROFILE}（${block.split("\n").length - 1} 行）`);
} else if (outPath !== undefined) {
	fs.writeFileSync(outPath, block);
	console.log(`已写出 ${outPath}（${block.split("\n").length - 1} 行）`);
} else {
	process.stdout.write(block);
	console.error(`\n（${block.split("\n").length - 1} 行；宿主 ${path.basename(HOST)}；正文 ${PROMPT}）`);
}

void os;
