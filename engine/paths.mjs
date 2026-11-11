/**
 * 目标文件定位：把逻辑键（agent-loop / user-approval / preset-standard …）
 * 解析成宿主里真实的文件路径。键表与文件布局解耦，宿主升级搬家只改这张表。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

const exists = (p) => {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
};

/** 候选 aiBase：npm 全局安装的 @deepseek-ai 目录、DSH_HOME 里带的、桌面解包目录。 */
export function candidateAiBases(env = process.env) {
  const out = [];
  const push = (p) => {
    if (!p) return;
    const n = path.normalize(p);
    if (!out.some((x) => x === n)) out.push(n);
  };
  if (env.DSH_BASE) push(env.DSH_BASE);
  // npm -g 安装：<prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
  for (const prefix of ["/usr/local/lib/nodejs/lib/node_modules", "/usr/local/lib/node_modules", "/usr/lib/node_modules"]) {
    push(path.join(prefix, "@deepseek-ai/dsh/node_modules/@deepseek-ai"));
    push(path.join(prefix, "@deepseek-ai"));
  }
  push(path.join(HOME, "profiles/web/node_modules/@deepseek-ai"));
  push(path.join(HOME, "profiles/desktop/node_modules/@deepseek-ai"));
  // 桌面端解包目录
  push(path.join(HOME, "..", "AppData/Local/Programs/deepseek-harness/resources/app/node_modules/@deepseek-ai"));
  return out.filter(exists);
}

export function isAiBase(p) {
  return exists(path.join(p, "dsh-agent-loop")) || exists(path.join(p, "dsh-base"));
}

export function primaryAiBase() {
  const hit = candidateAiBases().find(isAiBase);
  if (!hit) throw new Error("找不到 @deepseek-ai 插件根；用 DSH_BASE 指过去");
  return hit;
}

/**
 * 逻辑键 → 相对路径列表。
 * 一个键可以对应多个候选（不同版本搬家），按顺序取第一个存在的。
 */
export const FILE_MAP = {
  "agent-instructions": ["dsh-agent-instructions/lib/index.js"],
  "agent-preset": ["dsh-agent-preset/lib/index.js"],
  "web-app": ["dsh-web-app/cordis.patch.yml"],
  headless: ["dsh-headless/cordis.patch.yml"],
  "preset-acp-app": ["dsh-acp-app/cordis.patch.yml"],
  "preset-sdk-app": ["dsh-sdk-app/cordis.patch.yml"],
  "preset-standard": ["dsh-web-app/presets/standard.patch.yml"],
  "preset-ptc": ["dsh-web-app/presets/ptc.patch.yml"],
  "preset-cordis": ["dsh-web-app/presets/cordis.patch.yml"],
  "preset-minimal": ["dsh-web-app/presets/minimal.patch.yml"],
  "preset-unrestricted": ["dsh-web-app/.agent-presets/unrestricted/agent.cordis.yml"],
  "preset-sdk-minimal": ["dsh-sdk-minimal/cordis.patch.yml"],
  "preset-liangshen": ["dsh-web-app/presets/liangshen.patch.yml"],
  "preset-liangshen-pkg": ["dsh-liangshen/presets/liangshen/agent.cordis.yml"],
  "user-approval": ["dsh-user-approval/lib/types/index.js"],
  "user-approval-invariant": ["dsh-user-approval-invariant/lib/index.js"],
  "user-approval-code": ["dsh-user-approval/lib/index.js"],
  "sandbox-local": ["dsh-sandbox-local/lib/index.js"],
  "sandbox-policy": ["dsh-sandbox-policy/lib/index.js"],
  base: ["dsh-base/cordis.patch.yml"],
  "base-package": ["dsh-base/package.json"],
  escalation: ["dsh-sandbox/lib/index.js"],
  "fs-sandbox": ["dsh-fs-sandbox/lib/index.js"],
  "fs-observation-policy": ["dsh-fs-observation-policy/lib/index.js"],
  "repeat-tool-reminder": ["dsh-repeat-tool-reminder/lib/index.js"],
  "compaction-tool-result-pruner": ["dsh-compaction-tool-result-pruner/lib/index.js"],
  "tool-fs": ["dsh-tool-fs/lib/index.js"],
  subagent: ["dsh-subagent/lib/index.js"],
  "subagent-types": ["dsh-subagent/lib/types/child-agent.js"],
  "tool-subagent": ["dsh-tool-subagent/lib/index.js"],
  "system-prompt": ["dsh-system-prompt/lib/index.js"],
  "system-prompt-nested": ["dsh-system-prompt/lib/types/index.js"],
  persona: ["dsh-persona/lib/index.js"],
  "session-format-v0": ["dsh-session-format-v0-to-v1/lib/index.js"],
  "web-app-lib": ["dsh-web-app/lib/index.js"],
  "harness-dev-context": ["dsh-harness-dev-context/lib/index.js"],
  "deliverable-file-references": ["dsh-deliverable-file-references/lib/index.js"],
  "deliverables-prompt": ["dsh-client-ui-deliverables/lib/index.js"],
  "tool-web": ["dsh-tool-web/lib/index.js"],
  "tool-web-nested": ["dsh-tool-web/lib/types/index.js"],
  "tool-bash": ["dsh-tool-bash/lib/index.js"],
  "tool-pwsh": ["dsh-tool-pwsh/lib/index.js"],
  "tool-executor-ptc": ["dsh-tool-executor-ptc/lib/index.js"],
  settings: ["dsh-settings/lib/index.js"],
  "pi-ai-anthropic-messages": ["@earendil-works/pi-ai/dist/api/anthropic-messages.js"],
  "pi-ai-completions": ["@earendil-works/pi-ai/dist/api/openai-completions.js"],
  "pi-ai-responses-shared": ["@earendil-works/pi-ai/dist/api/openai-responses-shared.js"],
  "session-reference": ["dsh-session-reference/lib/index.js"],
  "permission-presets": ["dsh-permission-presets/lib/index.js"],
  "permission-presets-types": ["dsh-permission-presets/lib/types/index.js"],
  "session-log-deepseek": ["dsh-session-log-deepseek/lib/index.js"],
  "session-log-deepseek-types": ["dsh-session-log-deepseek/lib/types/index.js"],
  "agent-loop": ["dsh-agent-loop/lib/index.js"],
  session: ["dsh-session/lib/index.js"],
  "llm-deepseek": ["dsh-llm-deepseek/lib/index.js"],
  "conversation-client": ["dsh-client-ui-conversation/lib/client.js"],
  "tool-todo": ["dsh-tool-todo/lib/index.js"],
  "auto-review": ["dsh-experimental-auto-review/lib/index.js"],
  "api-session-controller": ["dsh-api-session-controller/lib/index.js"],
  "dsh-tools": ["dsh-tools/lib/index.js"],
  "dsh-tools-types": ["dsh-tools/lib/types/index.js"],
  "dsh-tools-ptc": ["dsh-tools/lib/types/index.js"],
  "dsh-tools-pipeline": ["dsh-tools/lib/pipeline.js"],
  "working-directory": ["dsh-working-directory/lib/index.js"],
  appBoot: ["dsh-app-boot/lib/index.js"],
};

/** 解析逻辑键 → 绝对路径数组（只返回存在的）。 */
export function resolveKey(aiBase, key) {
  const rels = FILE_MAP[key];
  if (!rels) return { key, files: [], reason: "unknown-key" };
  const files = rels.map((r) => path.join(aiBase, r)).filter(exists);
  return { key, files, reason: files.length ? "ok" : "missing-file" };
}

export function resolvePatch(aiBase, patch) {
  const keys = Array.isArray(patch.files) ? patch.files : [patch.files];
  const out = [];
  const missing = [];
  for (const k of keys) {
    const r = resolveKey(aiBase, k);
    if (r.files.length) out.push(...r.files);
    else missing.push(r.reason === "unknown-key" ? `${k}(unknown)` : `${k}(absent)`);
  }
  return { files: [...new Set(out)], missing };
}

export function backupPath(file) {
  return `${file}.pierce.bak`;
}
export { HOME };
