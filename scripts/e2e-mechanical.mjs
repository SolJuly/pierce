#!/usr/bin/env node
/**
 * 机械通道 vs 提示词的归因实验（在真实宿主里跑，零成本）。
 *
 * ## 为什么需要它
 *
 * README 把破甲的效果整个归给提示词，但线上其实同时开着三个机械通道：
 *
 *   autoGrantApproval   approval/request → allowed-once
 *   allowToolGate       tools/pre-execute 的 ask → allow
 *   fsIntentFree        fs/{write,edit,delete}-intent → 不要求「先读」
 *
 * 之前所有拒绝率实验都跑在 buddy 通道（只有提示词，没有任何钩子），所以
 * 「提示词贡献多少、机械通道贡献多少」从来没被拆开过。
 *
 * 这个脚本用**真宿主 + 假模型**做拆解：假模型让行为完全确定，真宿主让钩子真的被调用。
 *
 * ## 三臂
 *
 *   A 全开     提示词 + 三个机械通道（≈ 线上现状）
 *   B 只提示词  提示词开，三个机械通道全关
 *   C 全关     pierce 整个不挂载
 *
 * 拆解方式：
 *
 *   A − B  = 机械通道的贡献
 *   B − C  = 提示词的贡献
 *   A − C  = 合计
 *
 * ## 为什么这不是"重复 e2e-verify"
 *
 * e2e-verify 只做了 A vs C 的两点对比（开/关）。它证明「钩子被调用」和「工具真的跑」，
 * 但没法回答「如果只留提示词会怎样」——而那正是 README 需要的那句话。
 *
 * ## 用法
 *
 *   node scripts/e2e-mechanical.mjs [--only bash|fs_write|none]
 *
 * 需要先准备好 e2e 沙箱（见 scripts/e2e-verify.mjs 文件头）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");
const CLEAN_ROOT = process.env.DSH_CLEAN_ROOT || "/opt/dsh-clean";

/** 定位 e2e 沙箱：PIERCE_E2E_DIR → ~/.pierce-e2e → 仓库内 .e2e-sandbox。 */
function resolveE2E(profile) {
	const candidates = [
		process.env.PIERCE_E2E_DIR,
		path.join(os.homedir(), ".pierce-e2e"),
		path.join(ROOT, ".e2e-sandbox"),
	].filter(Boolean);
	for (const dir of candidates) {
		if (fs.existsSync(path.join(dir, "home", "profiles", profile))) return dir;
	}
	return candidates.at(-1);
}

const PROFILE = process.env.PIERCE_E2E_PROFILE || "e2e";
const E2E_DIR = resolveE2E(PROFILE);
const E2E = {
	dsh: path.join(CLEAN_ROOT, "node_modules/.bin/dsh"),
	home: path.join(E2E_DIR, "home"),
	work: path.join(E2E_DIR, "work"),
	logs: path.join(E2E_DIR, "logs"),
	mockScript: path.join(ROOT, "scripts", "mock-llm.mjs"),
	profile: PROFILE,
	mockPort: Number(process.env.PIERCE_MOCK_PORT || 9911),
	proofBash: path.join(os.tmpdir(), "pierce-e2e-proof"),
	proofFs: path.join(E2E_DIR, "work/proof-fs-write.txt"),
	assemble: path.join(E2E_DIR, "logs", "assemble.json"),
};

const only = (() => {
	const index = process.argv.indexOf("--only");
	return index > 0 ? process.argv[index + 1] : null;
})();

if (!fs.existsSync(E2E.dsh)) {
	console.error(`e2e-mechanical: 找不到 ${E2E.dsh}（设 DSH_CLEAN_ROOT）`);
	process.exit(2);
}
if (!fs.existsSync(path.join(E2E.home, "profiles", PROFILE))) {
	console.error(`e2e-mechanical: 找不到隔离 profile ${E2E.home}/profiles/${PROFILE}（设 PIERCE_E2E_DIR）`);
	process.exit(2);
}

/**
 * 三臂定义。`env` 里没写的通道变量保持默认（开）。
 */
const ARMS = [
	{
		id: "A",
		name: "全开（提示词 + 三个机械通道）",
		env: { PIERCE_ENABLED: "1" },
	},
	{
		id: "B",
		name: "只提示词（机械通道全关）",
		env: { PIERCE_ENABLED: "1", PIERCE_MECH_APPROVAL: "0", PIERCE_MECH_GATE: "0", PIERCE_MECH_FSINTENT: "0" },
	},
	{
		id: "C",
		name: "全关（对照组）",
		env: { PIERCE_ENABLED: "0" },
	},
	// 细化臂：把 approval 和 gate 拆开，回答「bash 那一发到底是谁在起作用」
	{
		id: "D",
		name: "提示词 + 只开审批放行",
		env: { PIERCE_ENABLED: "1", PIERCE_MECH_GATE: "0", PIERCE_MECH_FSINTENT: "0" },
	},
	{
		id: "E",
		name: "提示词 + 只开工具门降级",
		env: { PIERCE_ENABLED: "1", PIERCE_MECH_APPROVAL: "0", PIERCE_MECH_FSINTENT: "0" },
	},
];

const SCENARIOS = [
	{ id: "bash", proof: E2E.proofBash, what: "bash 申请沙箱升级" },
	{ id: "fs_write", proof: E2E.proofFs, what: "write 工具（受 fs 观测闸约束）" },
	{ id: "none", proof: null, what: "纯文本，不调工具" },
].filter((scenario) => only === null || scenario.id === only);

const env = (extra = {}) => ({
	...process.env,
	DSH_HOME: E2E.home,
	PATH: `${CLEAN_ROOT}/node_modules/.bin:${process.env.PATH}`,
	MOCK_API_KEY: "e2e-test-key",
	...extra,
});

/** 起假 LLM，返回 stop()。 */
function startMock(scenario) {
	fs.mkdirSync(E2E.logs, { recursive: true });
	const out = fs.openSync(path.join(E2E.logs, `mech-mock-${scenario}.log`), "a");
	const proc = spawn("node", [E2E.mockScript], {
		env: env({ MOCK_SCENARIO: scenario, MOCK_PORT: String(E2E.mockPort) }),
		stdio: ["ignore", out, out],
		detached: true,
	});
	proc.unref();
	return {
		stop: () => {
			try {
				process.kill(-proc.pid, "SIGTERM");
			} catch {
				try {
					proc.kill("SIGTERM");
				} catch {
					/* 已经退出 */
				}
			}
		},
	};
}

async function waitMock(ms = 8000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${E2E.mockPort}/v1/models`);
			if (response.ok) return true;
		} catch {
			/* 还没起来 */
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
}

/**
 * 跑一次 headless，返回结构化观测。
 * @param armEnv - 该臂的环境变量
 * @param task - dsh 的任务名
 * @returns 观测对象
 */
function runTask(armEnv, task = "e2e") {
	// 每次跑之前清掉装配快照，否则读到的是上一臂的
	fs.rmSync(E2E.assemble, { force: true });
	const result = spawnSync(E2E.dsh, ["--profile", E2E.profile, "--json", task], {
		cwd: E2E.work,
		env: env(armEnv),
		encoding: "utf8",
		timeout: 180_000,
	});
	const events = [];
	for (const line of (result.stdout || "").split("\n")) {
		const text = line.trim();
		if (!text.startsWith("{")) continue;
		try {
			events.push(JSON.parse(text));
		} catch {
			/* 不是 JSON 行 */
		}
	}
	const toolResult = events.find((event) => event.type === "tool_result");
	const toolCall = events.find((event) => event.type === "tool_call");

	// 装配快照里的提示词体积：pierce:body 段有多长，证明提示词到底进没进
	// dumpAssemble 落盘的结构没有文档，所以不猜键路径：递归收集所有带 name+text 的节点。
	// 第一次实现按 dump.sections 取，结果读到 0 —— 说明真实结构不是那样。
	let promptChars = null;
	if (fs.existsSync(E2E.assemble)) {
		try {
			const dump = JSON.parse(fs.readFileSync(E2E.assemble, "utf8"));
			let total = 0;
			let found = false;
			const walk = (node) => {
				if (node === null || typeof node !== "object") return;
				if (Array.isArray(node)) {
					for (const item of node) walk(item);
					return;
				}
				if (typeof node.name === "string" && node.name.includes("pierce:body")) {
					found = true;
					// dumpAssemble 存的是 {name, chars, head}，不是全文。
					total += typeof node.chars === "number" ? node.chars : String(node.text ?? "").length;
				}
				for (const value of Object.values(node)) walk(value);
			};
			walk(dump);
			promptChars = found ? total : 0;
		} catch {
			promptChars = null;
		}
	}

	return {
		code: result.status,
		toolCalled: toolCall !== undefined,
		toolName: toolCall?.name ?? null,
		toolStatus: toolResult?.status ?? null,
		toolError: String(toolResult?.result ?? "").slice(0, 90),
		approvalHookSeen: /approval auto-grant/.test(result.stdout || ""),
		promptChars,
	};
}

const rows = [];
for (const scenario of SCENARIOS) {
	const mock = startMock(scenario.id);
	try {
		if (!(await waitMock())) {
			console.error(`假 LLM 没起来（scenario=${scenario.id}）`);
			continue;
		}
		for (const arm of ARMS) {
			if (scenario.proof !== null) fs.rmSync(scenario.proof, { force: true });
			const observation = runTask(arm.env);
			const proof = scenario.proof === null ? null : fs.existsSync(scenario.proof);
			rows.push({ scenario: scenario.id, what: scenario.what, arm: arm.id, armName: arm.name, proof, ...observation });
			console.log(
				`${scenario.id.padEnd(9)} ${arm.id} ${arm.name.padEnd(28)} ` +
					`tool=${String(observation.toolStatus ?? "—").padEnd(10)} ` +
					`落盘=${proof === null ? "—" : String(proof).padEnd(5)} ` +
					`钩子=${observation.approvalHookSeen ? "见" : "未"} ` +
					`提示词=${observation.promptChars ?? "?"} 字符`,
			);
		}
	} finally {
		mock.stop();
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
}

/* ── 归因汇总 ─────────────────────────────────────────────────── */

function cell(scenarioId, armId) {
	return rows.find((row) => row.scenario === scenarioId && row.arm === armId);
}

console.log("\n═══ 归因：工具是否真的执行（落盘为准）═══");
for (const scenario of SCENARIOS) {
	if (scenario.proof === null) {
		console.log(`  ${scenario.id}：不调工具，无落盘可测`);
		continue;
	}
	const cells = ARMS.map((arm) => {
		const row = cell(scenario.id, arm.id);
		if (row === undefined) return `${arm.id}=?`;
		return `${arm.id}=${row.proof ? "跑通" : "失败"}`;
	}).join("  ");
	console.log(`  ${scenario.id.padEnd(10)} ${cells}`);
}
console.log("\n  A 全开 / B 只提示词 / C 全关 / D 只审批放行 / E 只工具门降级");
console.log("  读法：若 E 失败而 D 跑通 → 起作用的是审批放行，不是工具门。");

console.log("\n═══ 提示词体积（证明 A/B 臂真的注入了、C 臂没有）═══");
for (const scenario of SCENARIOS) {
	const line = ARMS.map((arm) => {
		const row = cell(scenario.id, arm.id);
		return `${arm.id}=${row?.promptChars ?? "?"}`;
	}).join("  ");
	console.log(`  ${scenario.id.padEnd(12)} ${line}`);
}

const outPath = path.join(E2E.logs, "mechanical-attribution.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), arms: ARMS, scenarios: SCENARIOS, rows }, null, 2) + "\n");
console.log(`\n原始观测 → ${outPath}`);
