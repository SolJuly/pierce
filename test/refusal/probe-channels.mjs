/**
 * 渠道探活：逐个实测「账号渠道能否稳定出正文」。
 * 只发一句最小请求，不消耗有意义额度。
 */
import fs from "node:fs";

/** 只取 refs 段里的 key: value，不引第三方 yaml（本目录没有 node_modules）。 */
function readRefs(file) {
  const out = {};
  let inRefs = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (inRefs && /^\S/.test(line)) break;
    if (!inRefs) continue;
    const m = line.match(/^\s{2}([A-Z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1).replace(/''/g, "'");
    out[m[1]] = v;
  }
  return out;
}

const creds = readRefs("/root/.dsh/.credentials.yaml");
const state = JSON.parse(fs.readFileSync("/root/.dsh/channel-pack/state.json", "utf8"));
const accounts = state.accounts.filter((a) => a.enabled);

const UA = "opencode/1.0.0";

async function post(url, headers, body) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(45000) });
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch { /* 非 JSON */ }
    return { status: res.status, json: j, text: txt.slice(0, 300) };
  } catch (e) {
    return { status: 0, error: e.name === "TimeoutError" ? "timeout" : String(e.message).slice(0, 120) };
  }
}

const out = [];

// 1) zen 免密池
for (const model of ["glm-5.3-flash-free", "deepseek-v4.1-flash-free", "mimo-v2.6-flash-free"]) {
  const r = await post("https://opencode.ai/zen/v1/chat/completions", {
    authorization: "Bearer public", "user-agent": UA, "x-opencode-client": "desktop",
    "x-opencode-session": "ses_" + Math.random().toString(16).slice(2, 14),
    "x-opencode-request": Math.random().toString(16).slice(2, 18), "x-opencode-project": "global",
  }, { model, messages: [{ role: "user", content: "说一个字" }], max_tokens: 20 });
  out.push({ lane: "zen免密", model, status: r.status, verdict: classifyResp(r), detail: shortErr(r) });
}

// 2) 账号渠道
const pick = (p) => accounts.filter((a) => a.provider === p).map((a) => creds[a.credentialRef]).filter(Boolean).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);

for (const c of pick("cline")) {
  const r = await post("https://api.cline.bot/api/v1/chat/completions",
    { authorization: `Bearer ${c.access_token}`, "HTTP-Referer": "https://cline.bot", "X-Title": "Cline", "X-CLIENT-TYPE": "cline-sdk" },
    { model: "anthropic/claude-sonnet-5", messages: [{ role: "user", content: "说一个字" }], max_tokens: 20 });
  out.push({ lane: "cline", model: "claude-sonnet-5", status: r.status, verdict: classifyResp(r), detail: shortErr(r) });
  break;
}

for (const c of pick("zcode")) {
  const r = await post("https://api.z.ai/api/anthropic/v1/messages",
    { "x-api-key": c.bigmodel_access_token, "anthropic-version": "2023-06-01" },
    { model: "glm-4.6", messages: [{ role: "user", content: "hi" }], max_tokens: 20 });
  out.push({ lane: "zcode/智谱", model: "glm-4.6", status: r.status, verdict: classifyResp(r), detail: shortErr(r) });
  break;
}

for (const c of pick("qoder")) {
  const r = await post("https://api2-v2.qoder.sh/algo/api/v2/service/pro/chat/completions",
    { authorization: `Bearer ${c.security_oauth_token}` }, { model: "qwen3.8-max", messages: [{ role: "user", content: "hi" }], max_tokens: 20 });
  out.push({ lane: "qoder", model: "qwen3.8-max", status: r.status, verdict: classifyResp(r), detail: shortErr(r) });
  break;
}

function classifyResp(r) {
  if (r.status === 0) return "网络失败";
  if (r.json?.error) {
    const m = String(r.json.error.message || r.json.error || "");
    if (/limit|quota|balance|credits|recharge/i.test(m)) return "配额/余额不足";
    if (/auth|401|403|expired/i.test(m)) return "鉴权失败";
    if (/entitle|subscrib/i.test(m)) return "需订阅";
    return "报错";
  }
  if (r.json?.choices?.[0] || r.json?.content) return "可用";
  return "空响应";
}
function shortErr(r) {
  if (r.error) return r.error;
  const m = r.json?.error?.message || r.json?.error || "";
  return String(m || r.text || "").slice(0, 110);
}

console.log("渠道".padEnd(14), "模型".padEnd(26), "状态".padEnd(12), "说明");
for (const o of out) console.log(o.lane.padEnd(14), o.model.padEnd(26), o.verdict.padEnd(12), o.detail);
fs.writeFileSync("test/refusal/out/channels.json", JSON.stringify({ at: new Date().toISOString(), out }, null, 2));
