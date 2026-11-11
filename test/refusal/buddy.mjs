/**
 * CodeBuddy（腾讯）渠道客户端 —— 这是本机唯一稳定可用的国产强模型通道。
 *
 * 端点：https://copilot.tencent.com/v2/chat/completions
 * 协议：SSE 流式（非流式被服务端拒绝：code 11101）
 * 凭据：/root/.dsh/.credentials.yaml 的 BUDDY_ACCOUNT_* → access_token
 *       （插件 channel-pack 的账号池，11 个账号可轮换）
 *
 * 实测（2026-11-11）：
 *   glm-5.3        ✓ 稳定出正文
 *   deepseek-v4-pro ✓ 稳定出正文
 *   kimi-k3.1-pro  ✓ 稳定出正文
 *   deepseek-v4.1-flash ✗ 频率限制（code 6004，23:45 重置）
 */
import fs from "node:fs";

const ENDPOINT = "https://copilot.tencent.com/v2/chat/completions";
const UA = "CodeBuddyIDE/1.106.1";

/**
 * 解析 refs 段。
 *
 * 坑：这些值是**跨多行的 YAML 单引号标量**（长的 JSON 被折成几十行，
 * 中间的换行在 YAML 里折叠成空格）。逐行读会把 JSON 截断，
 * 所以这里必须按「下一个 key 出现」为界累积。
 */
export function readRefs(file = "/root/.dsh/.credentials.yaml") {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const out = {};
  let inRefs = false;
  let key = null;
  let buf = [];

  const flush = () => {
    if (!key) return;
    let v = buf.join(" ").trim();
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    else if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    out[key] = v;
    key = null;
    buf = [];
  };

  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) { flush(); break; }   // 出 refs 段
    if (!inRefs) continue;
    const m = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(.*)$/);
    if (m) { flush(); key = m[1]; buf = [m[2]]; continue; }
    if (key && line.trim()) buf.push(line.trim());
  }
  flush();
  return out;
}

/** 所有 buddy 账号的 access_token（轮换用）。 */
export function buddyTokens() {
  const refs = readRefs();
  const toks = [];
  for (const [k, v] of Object.entries(refs)) {
    if (!k.startsWith("BUDDY_ACCOUNT_")) continue;
    try {
      const d = JSON.parse(v);
      if (d.access_token) toks.push({ ref: k, token: d.access_token });
    } catch { /* 跳过坏条目 */ }
  }
  return toks;
}

/** 解析 SSE，拼出完整 content。 */
function parseSSE(text) {
  let content = "";
  let reasoning = "";
  let finish = null;
  let error = null;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    let j;
    try { j = JSON.parse(payload); } catch { continue; }
    if (j.code && j.msg) { error = `${j.code}: ${j.msg}`; continue; }
    if (j.error) { error = JSON.stringify(j.error).slice(0, 160); continue; }
    const ch = j.choices?.[0];
    if (!ch) continue;
    const d = ch.delta ?? {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  return { content, reasoning, finish, error };
}

/**
 * 单轮调用。自动在账号池里轮换 —— 撞到频率限制就换下一个 token。
 * @returns {{ok:boolean, content?:string, finish?:string, error?:string, token?:string}}
 */
export async function buddyChat({ model, system, user, maxTokens = 1200, timeoutMs = 120000, tokens = null }) {
  const pool = tokens ?? buddyTokens();
  if (!pool.length) return { ok: false, error: "没有 buddy 账号" };
  let lastErr = null;
  for (const { ref, token } of pool) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": UA,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }],
          max_tokens: maxTokens,
          stream: true,
        }),
        signal: ctl.signal,
      });
      const text = await res.text();
      const r = parseSSE(text);
      if (r.error) { lastErr = r.error; continue; } // 换下一个账号
      if (!r.content && !r.reasoning) { lastErr = "空响应"; continue; }
      return { ok: true, ...r, token: ref };
    } catch (e) {
      lastErr = e.name === "AbortError" ? "timeout" : String(e.message).slice(0, 80);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: lastErr || "全部账号失败" };
}
