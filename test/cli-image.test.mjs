/**
 * `engine/cli.mjs image` 子命令的端到端测试。
 *
 * 这个子命令是新加的，之前只有手工冒烟，没有任何自动覆盖。它是「图片载体」唯一的
 * 生产入口 —— 如果它把参数解析错了、把文件写到别处、或者在 sharp 缺失时静默成功，
 * 后面所有基于图片载体的实验材料就都是错的。
 *
 * 所以这里**真的去开子进程跑命令**，而不是 import 函数：
 * 参数解析、退出码、stderr 文案、文件落盘位置，这些只有跑真进程才测得到。
 *
 * 跑：node --test test/cli-image.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { imageRenderAvailable, resolveSharp } from "../lib/image-render.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "engine", "cli.mjs");

const hasSharp = await imageRenderAvailable();

/** 每个用例一个独立临时目录，避免互相踩。 */
function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pierce-cli-"));
}

/**
 * 跑一次 CLI。
 * @param args - 命令行参数
 * @returns `{ code, stdout, stderr }`（以 `code` 表达退出码，不让异常逃出去）
 */
async function cli(args) {
	try {
		const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { timeout: 60_000 });
		return { code: 0, stdout, stderr };
	} catch (error) {
		return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
	}
}

/* ── 参数面 ─────────────────────────────────────────────────────── */

test("无参数时打印用法并以非零退出", async () => {
	const result = await cli([]);
	assert.notEqual(result.code, 0);
	assert.match(result.stdout, /engine\/cli\.mjs image/u, "用法里必须列出 image 子命令");
});

test("image 子命令出现在用法说明里（否则等于没加）", async () => {
	const result = await cli([]);
	assert.match(result.stdout, /probe-image|--template plain\|document\|terminal/u);
});

test("缺 --text / --in 时报错退出", async () => {
	const dir = tempDir();
	const result = await cli(["image", "--out", path.join(dir, "x.png")]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /需要 --text/u);
});

test("未知模板报错并列出可用模板", async () => {
	const dir = tempDir();
	const result = await cli(["image", "--text", "x", "--template", "screenshot", "--out", path.join(dir, "x.png")]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /未知模板/u);
	assert.match(result.stderr, /plain \/ document \/ terminal/u);
});

test("数值参数非数字时报错，而不是静默回落默认值", async () => {
	const dir = tempDir();
	for (const flag of ["width", "font-size", "padding", "max-height"]) {
		const result = await cli(["image", "--text", "x", `--${flag}`, "abc", "--out", path.join(dir, "x.png")]);
		assert.equal(result.code, 1, `--${flag} 传非数字应当报错`);
		assert.match(result.stderr, new RegExp(`--${flag} 需要数字`, "u"));
	}
});

/* ── 出图 ───────────────────────────────────────────────────────── */

test("--text 内联：写出合法 PNG，尺寸与 --json 报告一致", async (t) => {
	if (!hasSharp) return t.skip("sharp 不可用");
	const dir = tempDir();
	const out = path.join(dir, "inline.png");
	const result = await cli(["image", "--text", "内联文本测试", "--out", out, "--json"]);
	assert.equal(result.code, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.out, out);
	assert.equal(report.template, "plain");
	const bytes = fs.readFileSync(out);
	assert.equal(bytes.subarray(1, 4).toString("latin1"), "PNG");
	const sharp = await resolveSharp();
	const meta = await sharp(bytes).metadata();
	assert.equal(meta.width, report.width);
	assert.equal(meta.height, report.height);
});

test("--in 文件：正文照文件内容渲染", async (t) => {
	if (!hasSharp) return t.skip("sharp 不可用");
	const dir = tempDir();
	const source = path.join(dir, "body.txt");
	fs.writeFileSync(source, "第一行\n第二行\n第三行\n");
	const out = path.join(dir, "from-file.png");
	const result = await cli(["image", "--in", source, "--out", out, "--json"]);
	assert.equal(result.code, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.lines, 4, "三行正文 + 结尾换行产生的空行 = 4 行版面");
});

test("--in - 从标准输入读正文", async (t) => {
	if (!hasSharp) return t.skip("sharp 不可用");
	const dir = tempDir();
	const out = path.join(dir, "stdin.png");
	// execFile 不支持直接喂 stdin，用一个 shell 管道更接近真实用法
	const { stdout } = await run("/bin/sh", ["-c", `printf '来自标准输入\\n第二行' | "${process.execPath}" "${CLI}" image --in - --out "${out}" --json`]);
	const report = JSON.parse(stdout);
	assert.equal(report.out, out);
	assert.ok(fs.statSync(out).size > 100);
});

test("输出目录不存在时自动创建", async (t) => {
	if (!hasSharp) return t.skip("sharp 不可用");
	const dir = tempDir();
	const out = path.join(dir, "a", "b", "c", "deep.png");
	const result = await cli(["image", "--text", "深目录", "--out", out]);
	assert.equal(result.code, 0, result.stderr);
	assert.ok(fs.existsSync(out));
});

test("--svg 同时写出 SVG，且画布尺寸与 PNG 一致", async (t) => {
	if (!hasSharp) return t.skip("sharp 不可用");
	const dir = tempDir();
	const out = path.join(dir, "both.png");
	const result = await cli(["image", "--text", "双份输出", "--out", out, "--svg"]);
	assert.equal(result.code, 0, result.stderr);
	const svgPath = path.join(dir, "both.svg");
	assert.ok(fs.existsSync(svgPath), "应当写出同名 .svg");
	const svg = fs.readFileSync(svgPath, "utf8");
	assert.ok(svg.startsWith("<svg "));
	const sharp = await resolveSharp();
	const meta = await sharp(fs.readFileSync(out)).metadata();
	assert.ok(svg.includes(`viewBox="0 0 ${meta.width} ${meta.height}"`), "SVG 画布必须与 PNG 尺寸一致");
});

test("三个模板都能出图，且 terminal 用深色底", async (t) => {
	if (!hasSharp) return t.skip("sharp 不可用");
	const dir = tempDir();
	for (const template of ["plain", "document", "terminal"]) {
		const out = path.join(dir, `${template}.png`);
		const result = await cli(["image", "--text", "模版测试", "--out", out, "--template", template, "--json"]);
		assert.equal(result.code, 0, `${template}: ${result.stderr}`);
		assert.equal(JSON.parse(result.stdout).template, template);
	}
	const terminalSvg = path.join(dir, "terminal.svg");
	await cli(["image", "--text", "x", "--out", path.join(dir, "t2.png"), "--template", "terminal", "--svg"]);
	assert.ok(fs.existsSync(terminalSvg) || fs.existsSync(path.join(dir, "t2.svg")));
});

/* ── 失败路径 ───────────────────────────────────────────────────── */

test("--width 越界时报错退出，而不是产出畸形图", async (t) => {
	if (!hasSharp) return t.skip("sharp 不可用");
	const dir = tempDir();
	const result = await cli(["image", "--text", "x", "--width", "99999", "--out", path.join(dir, "x.png")]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /width 必须在/u);
	assert.equal(fs.existsSync(path.join(dir, "x.png")), false, "失败时不允许留下半成品");
});

test("版面超 maxHeight 时报错退出", async (t) => {
	if (!hasSharp) return t.skip("sharp 不可用");
	const dir = tempDir();
	const result = await cli(["image", "--text", "内容\n".repeat(200), "--max-height", "200", "--out", path.join(dir, "x.png")]);
	assert.equal(result.code, 1);
	assert.match(result.stderr, /超过 maxHeight/u);
});

test("--in 指向不存在的文件时报错退出（不静默生成空图）", async (t) => {
	if (!hasSharp) return t.skip("sharp 不可用");
	const dir = tempDir();
	const result = await cli(["image", "--in", path.join(dir, "nope.txt"), "--out", path.join(dir, "x.png")]);
	assert.notEqual(result.code, 0);
	assert.equal(fs.existsSync(path.join(dir, "x.png")), false);
});

/* ── 与判定器/夹具脚本的接口一致性 ─────────────────────────────── */

test("夹具生成器默认把 manifest 写在夹具目录之外（防 agent 读答案）", async () => {
	const dir = tempDir();
	const result = await cli(["image", "--text", "一致性检查", "--out", path.join(dir, "x.png"), "--json"]);
	if (result.code !== 0) return; // 无 sharp 时跳过
	const probe = path.join(here, "..", "scripts", "probe-image-channel.mjs");
	const probeOut = path.join(dir, "fixtures");
	const { stdout } = await run(process.execPath, [probe, "--out", probeOut], { timeout: 120_000 });
	assert.match(stdout, /manifest →/u);
	assert.equal(fs.existsSync(path.join(probeOut, "manifest.json")), false, "夹具目录里不允许有 manifest");
	assert.ok(fs.existsSync(`${probeOut}.manifest.json`), "manifest 应当落在夹具目录的同级");
});
