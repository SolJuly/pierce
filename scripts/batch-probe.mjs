#!/usr/bin/env node
/**
 * buddy 批跑器：把探针格子铺成 N 发，收集回复，供 `judge-probe.mjs` 判定。
 *
 * ## 为什么不用 subagent 跑统计
 *
 * 2026-11-18 用 subagent 跑过两批，每格 N=1–2，问题有四：
 *   1. 一格一次调用，不可脚本化，铺不到 N=10
 *   2. 不能设温度、不能钉账号 —— 组间不同质
 *   3. agent 会 `ls` 夹具目录、`grep` 兄弟文件，看到同尺寸变体就推断出"这是对照组"
 *   4. 系统提示换不掉（继承当前会话 preset），做不了中立对照
 *
 * buddy 通道四条都能解：脚本化、可钉账号、system 由调用方给、夹具从 base64 进不落地。
 *
 * ## 关键约束（都是踩出来的）
 *
 * - **钉死单账号**：`buddyChat` 默认在账号池里轮换，撞 429 就换号。那会让组间不同质，
 *   而且额度耗尽会被记成"空响应"→ 若判定看的是"有没有出现 marker"，就变成假阴性。
 *   本脚本默认只用 `--account` 指定的一个号；换号会写进记录的 `fallback` 字段。
 * - **记录 finish_reason**：`length` 表示被 max_tokens 截断，结尾的 marker 可能被切掉。
 *   这类样本必须在统计前剔除，否则是纯假阴性。
 * - **图像只能从内存进**：夹具不落盘到 agent 可读目录，杜绝"读 manifest 猜答案"。
 * - **可续跑**：已满 N 的格子默认跳过，中断后重跑不会浪费额度。
 *
 * ## 用法
 *
 *   node scripts/batch-probe.mjs --manifest /tmp/pd-iso.manifest.json \
 *        --out /tmp/pd-iso.results.json --model glm-5.3 --n 10 \
 *        [--account BUDDY_ACCOUNT_XXX] [--cell delegation-weak]
 *        [--system-file 路径 | --system "字面"] [--max-tokens 800] [--delay 250]
 *        [--dry]
 *
 * ## 输出
 *
 * `<out>` 形如：
 *
 *   { "delegation-weak": { "replies": ["…", "…"], "meta": [{…}, {…}] }, … }
 *
 * `replies` 与 `meta` 一一对应。`judge-probe.mjs` 直接吃这个形状。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buddyTokens } from "../test/refusal/buddy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINT = "https://copilot.tencent.com/v2/chat/completions";
const UA = "CodeBuddyIDE/1.106.1";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const manifestPath = path.resolve(flag("manifest", path.join(here, "..", "tmp", "probe.manifest.json")));
const outPath = path.resolve(flag("out", path.join(path.dirname(manifestPath), "results.json")));
const model = flag("model", "glm-5.3");
const repeat = Number(flag("n", "10"));
const maxTokens = Number(flag("max-tokens", "800"));
const delayMs = Number(flag("delay", "250"));
const onlyCell = flag("cell", null);
const dry = has("dry");

if (!(repeat > 0)) {
	console.error("batch-probe: --n 必须是正整数");
	process.exit(1);
}
if (!fs.existsSync(manifestPath)) {
	console.error(`batch-probe: 找不到 manifest ${manifestPath}`);
	process.exit(2);
}

// 系统提示：可以给文件、给字面，或者两者都不给（不发 system 消息）。
// 中立对照组的等长补齐由调用方先生成文件，这里只负责发。
let system = undefined;
if (typeof flag("system-file", null) === "string") system = fs.readFileSync(path.resolve(flag("system-file")), "utf8");
else if (typeof flag("system", null) === "string") system = flag("system");

const pool = buddyTokens();
if (pool.length === 0) {
	console.error("batch-probe: 没有 buddy 账号");
	process.exit(2);
}
const pinnedRef = flag("account", pool[0].ref);
const order = [pool.find((item) => item.ref === pinnedRef) ?? pool[0], ...pool.filter((item) => item.ref !== pinnedRef)];
if (order[0] === undefined) {
	console.error(`batch-probe: 账号 ${pinnedRef} 不在池里`);
	process.exit(2);
}

/** 解析 SSE，拼出正文与 finish_reason。 */
function parseSse(text) {
	let content = "";
	let reasoning = "";
	let finish = null;
	let usage = null;
	for (const line of String(text).split(/\r?\n/u)) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (payload === "" || payload === "[DONE]") continue;
		let data;
		try {
			data = JSON.parse(payload);
		} catch {
			continue;
		}
		const choice = data.choices?.[0];
		if (choice?.delta?.content) content += choice.delta.content;
		if (choice?.delta?.reasoning_content) reasoning += choice.delta.reasoning_content;
		if (choice?.finish_reason) finish = choice.finish_reason;
		if (data.usage) usage = data.usage;
	}
	return { content, reasoning, finish, usage };
}

/** 从错误响应体里挖出可读原因，别把"额度用尽"伪装成"空响应"。 */
function explainFailure(status, text) {
	try {
		const j = JSON.parse(text);
		const code = j?.error?.data?.code ?? j?.error?.code ?? j?.code;
		const msg = j?.error?.data?.msg ?? j?.error?.message ?? j?.msg;
		if (code !== undefined || msg !== undefined) return { code, message: `HTTP ${status} code=${code ?? "?"} ${String(msg ?? "").slice(0, 160)}`.trim() };
	} catch {
		// 不是 JSON，原样带前 160 字符
	}
	return { code: undefined, message: `HTTP ${status} ${String(text).slice(0, 160)}` };
}

/**
 * 发一次带图片的请求。
 * @param args - `{ token, imageDataUrl, prompt, system }`
 * @returns `{ ok, content, finish, usage, error, code }`
 */
async function visionChat({ token, imageDataUrl, prompt, systemText }) {
	const messages = [];
	if (systemText !== undefined) messages.push({ role: "system", content: systemText });
	messages.push({
		role: "user",
		content: [
			{ type: "text", text: prompt },
			{ type: "image_url", image_url: { url: imageDataUrl } },
		],
	});
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), 180_000);
	try {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"User-Agent": UA,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify({ model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } }),
			signal: ctl.signal,
		});
		const text = await res.text();
		const parsed = parseSse(text);
		if (parsed.content.length === 0) {
			const explained = explainFailure(res.status, text);
			return { ok: false, error: explained.message, code: explained.code };
		}
		return { ok: true, ...parsed };
	} catch (error) {
		return { ok: false, error: error.name === "AbortError" ? "timeout" : String(error.message).slice(0, 120) };
	} finally {
		clearTimeout(timer);
	}
}

/** 夹具 → data URL。图从内存直接进请求，不落 agent 可读目录。 */
function imageDataUrl(file) {
	const extension = path.extname(file).toLowerCase();
	const media = extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".webp" ? "image/webp" : "image/gif";
	return `data:${media};base64,${fs.readFileSync(file).toString("base64")}`;
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const results = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};

const cells = manifest.cells.filter((cell) => onlyCell === null || cell.id === onlyCell);
if (cells.length === 0) {
	console.error(`batch-probe: 没有匹配的格子（--cell ${onlyCell}）`);
	process.exit(2);
}

if (dry) {
	console.log(`模型 ${model}  账号 ${order[0].ref}  每格 ${repeat} 发  system=${system === undefined ? "(无)" : `${system.length} 字符`}`);
	for (const cell of cells) {
		const exists = results[cell.id]?.replies?.length ?? 0;
		console.log(`  ${cell.id.padEnd(26)} marker=${cell.marker}  已有 ${exists}/${repeat}`);
	}
	process.exit(0);
}

let totalSent = 0;
let totalFailed = 0;
for (const cell of cells) {
	const entry = results[cell.id] ?? { replies: [], meta: [] };
	results[cell.id] = entry;
	const need = repeat - entry.replies.length;
	if (need <= 0) {
		console.log(`${cell.id}: 已满 ${repeat} 发，跳过`);
		continue;
	}
	const dataUrl = imageDataUrl(cell.target);
	console.log(`${cell.id}: 补 ${need} 发（${path.basename(cell.target)}，${Math.round(fs.statSync(cell.target).size / 1024)}KB）`);
	for (let index = 0; index < need; index += 1) {
		let attempt = 0;
		let outcome;
		let usedRef = order[0].ref;
		// 撞 429 才换号，且换号写进记录 —— 否则组间不同质这件事会被藏起来。
		while (attempt < order.length) {
			const account = order[attempt];
			usedRef = account.ref;
			outcome = await visionChat({ token: account.token, imageDataUrl: dataUrl, prompt: cell.prompt, systemText: system });
			if (outcome.ok || outcome.code !== 14018) break;
			attempt += 1;
		}
		totalSent += 1;
		if (!outcome.ok) {
			totalFailed += 1;
			console.log(`  ✗ ${outcome.error}`);
			// 失败样本不进 replies：额度/网络失败不是"未服从"，混进分母就是虚构效应。
			entry.meta.push({ ok: false, error: outcome.error, account: usedRef, fallback: usedRef !== order[0].ref });
			continue;
		}
		entry.replies.push(outcome.content);
		entry.meta.push({
			ok: true,
			account: usedRef,
			fallback: usedRef !== order[0].ref,
			finish: outcome.finish,
			truncated: outcome.finish === "length",
			usage: outcome.usage ?? null,
			model,
			at: new Date().toISOString(),
		});
		const marker = outcome.content.includes(cell.marker) ? "含标记" : "无标记";
		console.log(`  ✓ ${outcome.finish ?? "?"} ${marker} ${outcome.content.length} 字符`);
		fs.writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
		if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
	}
}

fs.writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
const truncated = Object.values(results).flatMap((entry) => entry.meta ?? []).filter((meta) => meta.truncated === true).length;
const failed = Object.values(results).flatMap((entry) => entry.meta ?? []).filter((meta) => meta.ok === false).length;
console.log(`\n发送 ${totalSent} 发；本次失败 ${totalFailed}；结果 → ${outPath}`);
console.log(`累计：截断 ${truncated} 发（统计前须剔除），失败 ${failed} 发（未计入分母）`);
if (truncated > 0) console.log("提示：截断样本用 --max-tokens 调大后补跑，judge 需 --drop-truncated");
