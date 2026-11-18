/**
 * 把页面样本渲染成「模型实际会看到的文本」，并复现结果裁剪器。
 *
 * 两个来源都必须是宿主的真实实现：
 *   - 渲染：`dsh-tool-web` 的 `formatFetchOutput`（拼 header、加降权声明、html→md）
 *   - 裁剪：`dsh-compaction-tool-result-pruner` 的阈值语义（8192 / head 4096 / tail 1024）
 *
 * 裁剪器是独立一层，`formatFetchOutput` 不管它。离线复现必须把两层串起来，
 * 否则算出来的"模型可见文本"比线上长，结论会偏乐观。
 *
 * @module test/injection/render
 */
import fs from "node:fs";
import path from "node:path";
import { loadToolWeb } from "./host-module.mjs";

/** 裁剪器的标记串，与宿主 `dsh-compaction-tool-result-pruner` 一致。 */
export const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";

/** 线上实际值（从宿主的 base bundle 读出来核对过）。 */
export const PRUNE_DEFAULTS = { thresholdChars: 8192, headChars: 4096, tailChars: 1024 };

/**
 * 复现 `tool-result-pruner` 的行为：超过阈值就保留 head + 标记 + tail。
 *
 * 实现细节对齐宿主：按码点切分（`Array.from`），不是按 UTF-16 单元，
 * 否则含 emoji / 中文的样本会被切在代理对中间。
 *
 * @param text - 完整文本
 * @param cfg - {thresholdChars, headChars, tailChars}
 * @returns {{text: string, pruned: boolean}}
 */
export function pruneLikeHost(text, cfg = PRUNE_DEFAULTS) {
  const points = Array.from(text);
  if (points.length <= cfg.thresholdChars) return { text, pruned: false };
  const head = points.slice(0, cfg.headChars).join("");
  const tail = points.slice(points.length - cfg.tailChars).join("");
  return { text: head + PRUNE_MARKER + tail, pruned: true };
}

/** 构造一个 provider 返回形状（和官方 `HttpFetchProvider.readBody` 同形）。 */
function asFetchResult(url, html, statusCode = 200) {
  return {
    url,
    statusCode,
    body: { kind: "html", content: html },
    truncated: false,
  };
}

/**
 * 渲染一个页面样本。
 *
 * @param opts.url - 假装抓的是这个地址（只影响 header 行）
 * @param opts.html - 页面 HTML
 * @param opts.maxOutputChars - tool-web 的输出上限（线上默认 200000）
 * @returns {{rendered: string, final: string, pruned: boolean, chars: {rendered:number, final:number}}}
 */
export async function renderPage({ url, html, maxOutputChars = 200000 }) {
  const { formatFetchOutput } = await loadToolWeb();
  const rendered = formatFetchOutput(asFetchResult(url, html), maxOutputChars);
  const { text: final, pruned } = pruneLikeHost(rendered);
  return {
    rendered,
    final,
    pruned,
    chars: { rendered: rendered.length, final: final.length },
  };
}

/** 载荷标记是否还活在最终文本里。 */
export function markerSurvives(finalText, marker) {
  return finalText.includes(marker);
}

void fs;
void path;
