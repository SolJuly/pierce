#!/usr/bin/env node
/**
 * A/D 对照分析器：系统提示对"服从率"的影响到底有多大。
 *
 * ## 要回答的问题
 *
 * pierce 的正文有 20300 字符，而一句 "You are a helpful assistant." 只有 30 字符。
 * 直接比这两者的服从率是没意义的 —— 750:1 的长度差可以同时解释"更长 → 更服从"
 * 和"更长 → 更警惕"两个相反机制。所以必须拿**等长中立文本**当对照。
 *
 *   A 组 = pierce 正文（20300 字符）
 *   D 组 = 等长中立语料（20300 字符，实测 `测试/neutral-20300.txt` 那种）
 *
 * Δ = P(服从|D) − P(服从|A)。**Δ 才是"pierce 正文带来的净效应"**，
 * 长度影响被 D 组消掉了（这是本设计的全部意义）。
 *
 * ## 为什么要 Holm 校正
 *
 * 两个模型各自算一个 p 值，就是在做两次检验。两次独立检验里至少一次假阳性的
 * 概率是 1-(1-0.05)² ≈ 9.75%，不是 5%。Holm 是控制这个的、比 Bonferroni 温和的做法。
 *
 * ## 用法
 *
 *   node scripts/analyze-ad.mjs \
 *     --pair glm-5.3=/tmp/ad-glm-A.json:/tmp/ad-glm-D.json \
 *     --pair deepseek-v4.1-flash=/tmp/ad-v41-A.json:/tmp/ad-v41-D.json \
 *     [--manifest /tmp/pd-iso.manifest.json] [--drop-truncated]
 *
 * 每对格式：`标签=A结果文件:D结果文件`（A 在前，D 在后）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyFollowed } from "./judge-probe.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const flagAll = (name) => {
	const out = [];
	for (let index = 0; index < argv.length; index += 1) {
		if (argv[index] === `--${name}` && argv[index + 1] !== undefined) out.push(argv[index + 1]);
	}
	return out;
};

/** 两个比例的 Fisher 双侧精确检验。 */
export function fisherExact(a, b, c, d) {
	const choose = (n, k) => {
		if (k < 0 || k > n) return 0;
		let value = 1;
		for (let index = 0; index < k; index += 1) value = (value * (n - index)) / (index + 1);
		return value;
	};
	const hyper = (i) => {
		const j = a + b - i;
		const k = a + c - i;
		const l = c + d - k;
		if (j < 0 || k < 0 || l < 0) return 0;
		const total = choose(a + b + c + d, a + c);
		return total === 0 ? 0 : (choose(a + b, i) * choose(c + d, k)) / total;
	};
	const observed = hyper(a);
	let sum = 0;
	for (let i = 0; i <= Math.min(a + b, a + c); i += 1) {
		const p = hyper(i);
		if (p <= observed + 1e-12) sum += p;
	}
	return Math.min(1, sum);
}

/** Holm–Bonferroni 校正。 */
export function holm(pvalues) {
	const order = pvalues.map((p, index) => ({ p, index })).sort((x, y) => x.p - y.p);
	const adjusted = new Array(pvalues.length).fill(1);
	let running = 0;
	for (const [rank, item] of order.entries()) {
		const value = Math.min(1, (pvalues.length - rank) * item.p);
		running = Math.max(running, value);
		adjusted[item.index] = running;
	}
	return adjusted;
}

const manifestPath = path.resolve(flag("manifest", path.join(path.dirname(flagAll("pair")[0]?.split("=")[1]?.split(":")[0] ?? "/tmp"), "manifest.json")));
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : { cells: [] };
const dropTruncated = argv.includes("--drop-truncated");

/** 从结果文件里数出一格的服从/总数。 */
function tally(file, cell) {
	const data = JSON.parse(fs.readFileSync(file, "utf8"));
	const entry = data[cell.id];
	if (entry === undefined) return null;
	const replies = Array.isArray(entry.replies) ? entry.replies : typeof entry.reply === "string" ? [entry.reply] : [];
	const metas = Array.isArray(entry.meta) ? entry.meta : [];
	let hits = 0;
	let total = 0;
	let dropped = 0;
	for (const [index, reply] of replies.entries()) {
		if (dropTruncated && metas[index]?.truncated === true) {
			dropped += 1;
			continue;
		}
		total += 1;
		if (classifyFollowed(reply, cell.marker).followed) hits += 1;
	}
	const fallbacks = metas.filter((meta) => meta.fallback === true).length;
	const failures = metas.filter((meta) => meta.ok === false).length;
	return { file, hits, total, dropped, fallbacks, failures };
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
    const pairs = flagAll("pair").map((spec) => {
    	const [label, rest] = spec.split("=");
    	const [aFile, dFile] = rest.split(":");
    	return { label, aFile, dFile };
    });
    if (pairs.length === 0) {
    	console.error("analyze-ad: 至少给一个 --pair 标签=A文件:D文件");
    	process.exit(1);
    }

    // 每对用哪个格子：默认取两边都有的第一个格；也允许 --cell 指定。
    const explicitCell = flag("cell", null);

    const table = [];
    const pvalues = [];
    for (const pair of pairs) {
    	const aData = JSON.parse(fs.readFileSync(pair.aFile, "utf8"));
    	const cellId = explicitCell ?? Object.keys(aData)[0];
    	const cell = manifest.cells.find((item) => item.id === cellId);
    	if (cell === undefined) {
    		console.error(`analyze-ad: manifest 里找不到格 ${cellId}`);
    		process.exit(1);
    	}
    	const a = tally(pair.aFile, cell);
    	const d = tally(pair.dFile, cell);
    	if (a === null || d === null) {
    		console.error(`analyze-ad: ${pair.label} 的结果文件里没有格 ${cellId}`);
    		process.exit(1);
    	}
    	const p = fisherExact(a.hits, a.total - a.hits, d.hits, d.total - d.hits);
    	pvalues.push(p);
    	table.push({ label: pair.label, cellId, a, d, p, delta: d.total && a.total ? d.hits / d.total - a.hits / a.total : NaN });
    }

    const adjusted = holm(pvalues);

    console.log(`格：${table[0].cellId}    判定规则：JSON 记录里 marker 槽全等${dropTruncated ? "（已剔除截断）" : "（未剔除截断）"}\n`);
    console.log("模型                        A=pierce正文        D=等长中立          Δ(D−A)     p        p(Holm)");
    for (const [index, row] of table.entries()) {
    	const fmt = (x) => `${String(x.hits).padStart(2)}/${String(x.total).padEnd(2)} ${((x.hits / x.total) * 100).toFixed(0).padStart(3)}%`;
    	const delta = `${(row.delta * 100).toFixed(1).padStart(6)}pp`;
    	console.log(
    		`${row.label.padEnd(26)} ${fmt(row.a).padEnd(18)} ${fmt(row.d).padEnd(18)} ${delta}  ${row.p.toFixed(4)}  ${adjusted[index].toFixed(4)}` +
    			(row.a.fallbacks + row.d.fallbacks > 0 ? `   （换号 ${row.a.fallbacks + row.d.fallbacks} 次）` : "") +
    			(row.a.failures + row.d.failures > 0 ? `   （失败 ${row.a.failures + row.d.failures} 发未计入分母）` : ""),
    	);
    }

    const pooled = table.reduce((acc, row) => ({
    	aHits: acc.aHits + row.a.hits,
    	aTotal: acc.aTotal + row.a.total,
    	dHits: acc.dHits + row.d.hits,
    	dTotal: acc.dTotal + row.d.total,
    }), { aHits: 0, aTotal: 0, dHits: 0, dTotal: 0 });
    console.log(
    	`\n合并                       ${pooled.aHits}/${pooled.aTotal}              ${pooled.dHits}/${pooled.dTotal}` +
    		`              Δ=${((pooled.dHits / pooled.dTotal - pooled.aHits / pooled.aTotal) * 100).toFixed(1)}pp`,
    );

    console.log("\n读法：");
    console.log("  Δ≈0         → pierce 正文对服从率没有净效应（长度已被 D 组消掉）");
    console.log("  Δ>0 且显著  → pierce 正文**降低**服从（即它在给自己加甲，是自伤）");
    console.log("  Δ<0 且显著  → pierce 正文**提高**服从（解甲有效，且不是长度带来的）");
    console.log("  不显著      → 没检出。**不是「证明没有」** —— N=10 只够看巨大效应。");
}
