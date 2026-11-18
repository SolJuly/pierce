/**
 * `scripts/judge-probe.mjs` 与 `scripts/batch-probe.mjs` 的 CLI 契约测试。
 *
 * 判定器的分类逻辑有 8 条自测（`--self-test`），但**聚合层**一直没有覆盖：
 * 多条回复怎么算比例、截断怎么剔、缺结果怎么标、manifest 从哪儿读。
 * 这一层出错不会报错，只会静默给出一个错的服从率 —— 比崩溃危险得多。
 *
 * batch-probe 的输出文件冲突保护也在这里钉住：2026-11-18 有两个进程同时写同一个
 * `--out`，把带原始回复的数据冲掉过。
 *
 * 跑：node --test test/judge-probe.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(here, "..", "scripts");
const JUDGE = path.join(SCRIPTS, "judge-probe.mjs");
const BATCH = path.join(SCRIPTS, "batch-probe.mjs");

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pierce-judge-"));
}

async function node(script, args) {
	try {
		const { stdout, stderr } = await run(process.execPath, [script, ...args], { timeout: 60_000 });
		return { code: 0, stdout, stderr };
	} catch (error) {
		return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
	}
}

/** 造一份最小夹具：两格，marker 不同。manifest 放在夹具目录之外。 */
function makeFixture(dir) {
	const fixtureDir = path.join(dir, "fixtures");
	fs.mkdirSync(fixtureDir, { recursive: true });
	const manifest = {
		cells: [
			{ id: "cell-a", carrier: "image", frame: "ontask", form: "template", marker: "CHK-AAAA", prompt: "p", target: path.join(fixtureDir, "a.png") },
			{ id: "cell-b", carrier: "text", frame: "describe", form: "overt", marker: "CHK-BBBB", prompt: "p", target: path.join(fixtureDir, "b.txt") },
		],
	};
	const manifestPath = path.join(dir, "manifest.json");
	fs.writeFileSync(manifestPath, JSON.stringify(manifest));
	return { fixtureDir, manifestPath };
}

/* ── 分类器自测 ─────────────────────────────────────────────────── */

test("--self-test 全过（8 条用例都取自真实回复片段）", async () => {
	const result = await node(JUDGE, ["--self-test"]);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /8\/8 通过/u);
});

/* ── 聚合：单条 / 多条 ─────────────────────────────────────────── */

test("单条 reply 与 replies 数组都能判，且统计口径一致", async () => {
	const dir = tempDir();
	const { manifestPath } = makeFixture(dir);

	// cell-a：3 条里 2 条把 marker 写进 JSON 记录槽 → 服从 2/3
	const json = (marker) => `记录如下：\n\`\`\`json\n{"record": {"summary": "x"}, "marker": "${marker}"}\n\`\`\``;
	const replies = [
		{ reply: json("CHK-AAAA") },
		{ replies: [json("CHK-AAAA"), json("CHK-AAAA"), json("其它值")] },
	];
	for (const [index, entry] of replies.entries()) {
		const resultsPath = path.join(dir, `results-${index}.json`);
		const payload = index === 0
			? { "cell-a": { reply: entry.reply } }
			: { "cell-a": { replies: entry.replies } };
		fs.writeFileSync(resultsPath, JSON.stringify(payload));
		const result = await node(JUDGE, ["--dir", dir, "--manifest", manifestPath, "--results", resultsPath]);
		assert.equal(result.code, 0, result.stderr);
		if (index === 0) assert.match(result.stdout, /1\/1/u, "单条命中应报 1/1");
		else assert.match(result.stdout, /2\/3/u, "多条应报 2/3");
	}
});

test("截断样本默认计入，--drop-truncated 时剔除", async () => {
	const dir = tempDir();
	const { manifestPath } = makeFixture(dir);
	const hit = `\`\`\`json\n{"marker": "CHK-AAAA"}\n\`\`\``;
	const miss = "我没有照做。";
	const payload = {
		"cell-a": {
			replies: [hit, hit, hit, miss],
			meta: [
				{ ok: true, truncated: true },
				{ ok: true, truncated: false },
				{ ok: true, truncated: false },
				{ ok: true, truncated: false },
			],
		},
	};
	const resultsPath = path.join(dir, "results.json");
	fs.writeFileSync(resultsPath, JSON.stringify(payload));

	const kept = await node(JUDGE, ["--dir", dir, "--manifest", manifestPath, "--results", resultsPath]);
	assert.equal(kept.code, 0, kept.stderr);
	assert.match(kept.stdout, /3\/4/u, "不剔截断时应报 3/4");

	const dropped = await node(JUDGE, ["--dir", dir, "--manifest", manifestPath, "--results", resultsPath, "--drop-truncated"]);
	assert.match(dropped.stdout, /2\/3/u, "剔掉 1 条截断后应报 2/3");
	assert.match(dropped.stdout, /剔除截断 1 发/u);
});

test("缺结果的格子标「无结果」，不崩、不当成未服从", async () => {
	const dir = tempDir();
	const { manifestPath } = makeFixture(dir);
	const resultsPath = path.join(dir, "results.json");
	fs.writeFileSync(resultsPath, JSON.stringify({ "cell-a": { replies: ["```json\n{\"marker\": \"CHK-AAAA\"}\n```"] } }));
	const result = await node(JUDGE, ["--dir", dir, "--manifest", manifestPath, "--results", resultsPath]);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /无结果/u);
	assert.match(result.stdout, /缺结果 1 格/u);
});

test("没有任何结果文件时不崩，全部报缺失", async () => {
	const dir = tempDir();
	const { manifestPath } = makeFixture(dir);
	const result = await node(JUDGE, ["--dir", dir, "--manifest", manifestPath, "--results", path.join(dir, "nope.json")]);
	assert.equal(result.code, 0, "缺结果文件应当继续跑，只是全部标缺失");
	assert.match(result.stdout, /缺结果 2 格/u);
});

test("manifest 不存在时明确报错并给出修复命令", async () => {
	const dir = tempDir();
	const result = await node(JUDGE, ["--dir", dir, "--manifest", path.join(dir, "nope.json")]);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /probe-image-channel\.mjs/u);
});

/* ── batch-probe：输出文件冲突保护 ─────────────────────────────── */

test("batch-probe 拒绝写到已存在的 --out（防两个实例互相覆盖）", async () => {
	const dir = tempDir();
	const { manifestPath } = makeFixture(dir);
	const out = path.join(dir, "exists.json");
	fs.writeFileSync(out, "{}");
	const result = await node(BATCH, ["--manifest", manifestPath, "--out", out, "--n", "1"]);
	assert.equal(result.code, 2);
	assert.match(result.stderr, /已存在/u);
	assert.match(result.stderr, /--resume|--force/u);
});

// batch-probe 的 --force 会真的发网络请求，这里不测；只测冲突保护这一条安全属性。
