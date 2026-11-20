#!/usr/bin/env node
/**
 * 生成「破甲模式」agent preset 的定义文件。
 *
 * ## 产物
 *
 *   presets/pierce/preset.json    { name, description, order }
 *   presets/pierce/plugins.json   插件行数组（从官方 standard 派生，persona 换成破甲正文）
 *
 * 两个文件随 npm 包分发；`lib/index.js` 在激活时读出来交给
 * `ctx.agentPresets.register`，所以**装了 dsh-pierce 就自带这个模式**，
 * 不需要用户改 profile。
 *
 * ## 为什么派生而不是手写
 *
 * 一个 preset = persona + 工具集。工具集那 20 多行必须和官方 `preset-standard` 一致，
 * 手抄一份会在宿主升级时悄悄漂掉。这里从官方 `standard.patch.yml` 原样搬 plugins 数组，
 * 只把 `persona` 那一行换掉。宿主装在哪、版本多少，跑一次就重新对齐。
 *
 * ## 为什么是 JSON 不是 YAML
 *
 * 官方 standard 里有 `!!js` 表达式（平台判断 / skills 路径 / profileContext）。
 * 用 YAML 就得决定谁来求值：自己实现一遍 `!!js` 语义不划算，交给宿主又拿不到
 * 求值后的结果。JSON 里把它们保留成 `{"__jsExpr": "..."}` —— 这正是
 * `dsh-agent-preset` 注册器认识的形状（@linxin666/dsh-liangshen 也是这么做的），
 * 由它在挂载时求值。破甲自己不需要会算 `!!js`。
 *
 * ## persona 的 prefix 是占位符
 *
 * 生成的 JSON 里写的是 `"@@PIERCE_PROMPT@@"`，注册时代码把它换成正文全文。
 * 这样正文只存在于 提示词/pierce-prompt.md 一处，而且路径由插件自己解析
 * （相对包目录），换机器、换绝对路径都不用改。
 *
 * ## 用法
 *
 *   node scripts/gen-pierce-preset.mjs            # 重写 presets/pierce/*.json
 *   node scripts/gen-pierce-preset.mjs --check    # 只比对，不写（CI 用）
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const OUT_DIR = path.join(ROOT, "presets", "pierce");
const PLUGINS_FILE = path.join(OUT_DIR, "plugins.json");
const PRESET_FILE = path.join(OUT_DIR, "preset.json");

const PROMPT_PLACEHOLDER = "@@PIERCE_PROMPT@@";

const HOST = process.env.DSH_INSTALL
	|| "/usr/local/lib/nodejs/lib/node_modules/@deepseek-ai/dsh";
const STANDARD = path.join(HOST, "node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml");

const PRESET_META = {
	name: "破甲模式",
	description: "以破甲正文作为整个系统提示，工具集与标准模式一致。",
	order: 5,
};

if (!fs.existsSync(STANDARD)) {
	console.error(`gen-pierce-preset: 找不到官方 standard 预设 ${STANDARD}（设 DSH_INSTALL 指到宿主安装目录）`);
	process.exit(2);
}

const nodeRequire = createRequire(import.meta.url);

/** 宿主自带的 yaml 包 —— 不额外引入依赖。 */
function loadYaml() {
	const candidates = [
		path.join(HOST, "node_modules/yaml/dist/index.js"),
		path.join(HOST, "node_modules/yaml"),
	];
	for (const candidate of candidates) {
		try {
			return nodeRequire(candidate);
		} catch {
			continue;
		}
	}
	throw new Error("gen-pierce-preset: 找不到宿主的 yaml 包");
}

/** 把 `!!js` 标量原样收成注册器认识的 `{ __jsExpr }`。 */
const JS_TAG = { tag: "tag:yaml.org,2002:js", resolve: (value) => ({ __jsExpr: String(value) }) };

const yaml = loadYaml();

const document = yaml.parse(fs.readFileSync(STANDARD, "utf8"), { customTags: [JS_TAG] });
const presetRow = document
	.map((row) => (row?.insert ? row.insert[0] : row))
	.find((row) => row?.config?.plugins !== undefined);
if (presetRow === undefined) {
	console.error("gen-pierce-preset: standard.patch.yml 里找不到带 plugins 的预设行，官方格式变了");
	process.exit(1);
}

const rows = presetRow.config.plugins;
const personaIndex = rows.findIndex((row) => row?.id === "persona");
if (personaIndex < 0) {
	console.error("gen-pierce-preset: 官方 standard 预设里找不到 persona 行，格式变了");
	process.exit(1);
}

const derived = rows.map((row) => {
	if (row?.id !== "persona") return row;
	return {
		...row,
		config: {
			...row.config,
			// 注册时代码把它换成正文全文
			prefix: PROMPT_PLACEHOLDER,
			// complete:true 丢弃所有 section —— 插件注入的 pierce:body 段被丢掉，
			// 所以破甲模式只吃这份正文，不会跟插件双份注入。
			// 代价：宿主的工具使用提示也一起丢了，模型只有正文 + 工具 schema 本身。
			complete: true,
			includeRuntimeContext: false,
		},
	};
});

const pluginsJson = `${JSON.stringify(derived, null, "\t")}\n`;
const presetJson = `${JSON.stringify(PRESET_META, null, "\t")}\n`;

if (process.argv.includes("--check")) {
	const samePlugins = fs.existsSync(PLUGINS_FILE) && fs.readFileSync(PLUGINS_FILE, "utf8") === pluginsJson;
	const samePreset = fs.existsSync(PRESET_FILE) && fs.readFileSync(PRESET_FILE, "utf8") === presetJson;
	if (!samePlugins || !samePreset) {
		console.error("gen-pierce-preset --check: 产物与官方 standard 不同步，重跑一次不带 --check");
		process.exit(1);
	}
	console.log("gen-pierce-preset --check: 与官方 standard 一致");
	process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(PLUGINS_FILE, pluginsJson);
fs.writeFileSync(PRESET_FILE, presetJson);
console.log(`已写出 ${path.relative(ROOT, PRESET_FILE)}（${Object.keys(PRESET_META).length} 个字段）`);
console.log(`已写出 ${path.relative(ROOT, PLUGINS_FILE)}（${derived.length} 行，persona 在 #${personaIndex + 1}）`);
