/**
 * 机制归属：每条 purge 补丁在「新插件」里应该由哪一层承接。
 *   A = 配置层：改 cordis.patch.yml / 预设 yml / 插件 config，零源码改动
 *   B = 运行期钩子：本插件挂 waterfall / systemPrompt section / context 覆盖
 *   C = 源码补丁：没有扩展点，必须改宿主源文件（走 engine 表）
 *   D = 已无必要（当前版本语义里不存在对应物）
 */
import fs from "node:fs";
const TABLE = "engine/tables/purge-1.1.71.json";
const t = JSON.parse(fs.readFileSync(TABLE, "utf8"));

const M = {
  A: {
    7: "permission-presets.presets.*.approval = never",
    8: "cordis.patch.yml: user-approval.policy = never",
    10: "同上，配置默认 instead of 改 zod .default",
    18: "patch yml 里 disabled: true（重复提醒插件）",
    19: "同上 / 或 pruner thresholdChars 拉高",
    21: "bash 执行器 config.timeoutMs",
    22: "tool-fs config: readLimit / readMaxBytes / readMaxLineLength",
    23: "tool-subagent config.maxDepth = 10",
    24: "preset yml 里给 tool-web 加 fetch",
    25: "system-prompt.includeHarnessIdentity = false",
    26: "preset yml: persona prefix 置空 + complete",
    43: "四个 web 预设 yml 里删 persona 行",
    51: "permission-presets.defaultPreset = danger-full-access",
    52: "session-log-deepseek.enabled = false",
    70: "minimal 预设 yml 改 shell 描述",
    71: "liangshen 预设 yml 删身份行",
    73: "minimal bash 镜像说明删行",
    80: "minimal 预设 yml 工具表",
    28: "liangshen 预设 yml",
    30: "hooks 插件 disabled: true（比改它代码干净）",
    31: "同上（codex hooks）",
    64: "同上 / 或 hook 配置关 steer",
    65: "同上",
    35: "approval/request 已短路，永不 reject",
    76: "preset-unrestricted yml 删身份行",
  },
  B: {
    1: "system-prompt/assemble 里替换免责声明段",
    2: "同上",
    3: "同上",
    5: "systemPrompt.context 同名覆盖 approval:policy 句",
    9: "approval/request → allowed-once",
    11: "同 5",
    12: "同 5",
    13: "approval/request 已短路，ladder 不再触发",
    14: "同上（沙箱升级请求走同一 approval 通道）",
    17: "fs/write|edit|delete-intent 返回 undefined",
    29: "assemble 里改 tool-web 描述段",
    32: "assemble 里改 web 面身份段",
    33: "assemble 里改 shell 拒绝话术段",
    34: "assemble 里改沙箱 hint 段",
    37: "assemble 里改子代理边界段",
    48: "assemble 里改 bash/pwsh 描述段",
    50: "assemble 里改会话引用 framing 段",
    53: "assemble 里删 web 禁止另开服务器句",
    54: "assemble 里放行 present 句",
    59: "tools/pre-execute 里放过 auto-review 的 deny",
    60: "approval/request（run_code 同一通道）",
    61: "assemble / approval 双重盖住",
    62: "tools/pre-execute：无审批通道时 allow",
    63: "assemble 里改 plan mode 段",
    4: "persona section 覆盖（prefix/suffix 段）",
  },
  C: {
    6: "sandbox-local 的 deny file-write 分支",
    15: "sandbox-local confine 直通",
    16: "fs-sandbox 围栏",
    20: "—",
    36: "tool-fs 的 zod schema 描述文本",
    38: "persona 文本前缀别名",
    39: "session v0 插件摘要别名",
    40: "complete 模式保留注入",
    42: "settings 旧 API 补齐",
    45: "桌面壳更新接管",
    46: "桌面壳 ASCII 脚本",
    47: "anthropic messages 首段",
    49: "anthropic oauth CLI 伪装",
    55: "agent-loop 每步替换首条 system",
    56: "conversation-client 回退隐藏",
    57: "pi-ai developer role 白名单",
    58: "session 回退标记",
    66: "renderPrompt undefined 兜底",
    67: "agent-loop decision.messages 兜底",
    68: "systemNodes content 兜底",
    69: "llm-deepseek 流释放",
    72: "messages system 字段",
    74: "pre-step 前挂注入",
    75: "回退重置 todos",
    77: "回退丢弃已发送",
    78: "overlay 从 bak 恢复",
    82: "桌面 DSH_PROFILE 兜底",
    83: "桌面 close 不报致命",
    84: "桌面 close code0",
    85: "session-controller 一律 followup",
    86: "steer → followup",
    87: "挂全文 LF needle",
    88: "挂全文严格 needle",
  },
  D: { 20: "无对应规则（历史占位）" },
};

const rows = [];
for (const p of t.patches) {
  const mech = Object.keys(M).find((k) => M[k][p.id]) ?? "?";
  rows.push({ id: p.id, name: p.name, rules: p.rules.length, mech, how: M[mech]?.[p.id] ?? "" });
}
rows.sort((a, b) => a.id - b.id);

const by = {};
for (const r of rows) { by[r.mech] = by[r.mech] || { n: 0, rules: 0 }; by[r.mech].n++; by[r.mech].rules += r.rules; }
fs.mkdirSync("ref", { recursive: true });
fs.writeFileSync("ref/mechanism.json", JSON.stringify({ generatedAt: new Date().toISOString(), counts: by, rows }, null, 2) + "\n");

console.log("机制归属（补丁数 / 规则数）：");
for (const k of ["A", "B", "C", "D", "?"]) if (by[k]) console.log(`  ${k} 配置=${k==="A"} … ${by[k].n} 条 / ${by[k].rules} 规则`);
console.log(`  合计 ${rows.length} 条 / ${rows.reduce((a, r) => a + r.rules, 0)} 规则`);
console.log(`  零源码改动 (A+B)：${(by.A?.n ?? 0) + (by.B?.n ?? 0)} 条 = ${Math.round(((by.A?.n ?? 0) + (by.B?.n ?? 0)) / rows.length * 100)}%`);
const unassigned = rows.filter((r) => r.mech === "?");
if (unassigned.length) console.log("未归类:", unassigned.map((r) => r.id).join(","));
