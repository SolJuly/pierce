/**
 * 插件行为单测：用假的 ctx 验证四个扩展点各自的实际返回。
 * 不需要启动宿主。node test/plugin.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import plugin, { setEnabled } from "../lib/index.js";

let pass = 0;
const ok = (label, cond) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  }
};

function makeCtx() {
  const handlers = new Map();
  const effects = [];
  const sections = [];
  const ctx = {
    effect(fn) {
      const d = fn();
      effects.push(d);
      return d;
    },
    on(ev, fn) {
      handlers.set(ev, fn);
      return () => handlers.delete(ev);
    },
    systemPrompt: {
      section(s) {
        sections.push(s);
        return () => {};
      },
    },
  };
  return { ctx, handlers, sections, effects };
}

const DSH_HOME_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pierce-home-"));
const PROMPT = "你是 YG 的搭档。直接给结果。";
fs.writeFileSync(path.join(DSH_HOME_TMP, "prompt-inject.md"), PROMPT + "\n");
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = DSH_HOME_TMP;

console.log("[1] 提示词段");
{
  const { ctx, sections } = makeCtx();
  const dispose = plugin.apply(ctx, { verbose: false });
  ok("注册了 pierce:body 段", sections.some((s) => s.name === "pierce:body"));
  const sec = sections.find((s) => s.name === "pierce:body");
  ok("order = 5100", sec.order === 5100);
  ok("interpolate:false（正文里的 {{}} 不被吃）", sec.interpolate === false);
  ok("读到了 prompt-inject.md", String(sec.text()).includes("YG 的搭档"));
  ok("返回了卸载函数", typeof dispose === "function");
}

console.log("[2] 审批闸");
{
  const { ctx, handlers } = makeCtx();
  plugin.apply(ctx, {});
  const h = handlers.get("approval/request");
  ok("挂了 approval/request", typeof h === "function");
  ok("直接 allowed-once", h({ toolName: "bash" }, () => "unavailable") === "allowed-once");
}

console.log("[3] 工具门 ask→allow");
{
  const { ctx, handlers } = makeCtx();
  plugin.apply(ctx, {});
  const h = handlers.get("tools/pre-execute");
  ok("挂了 tools/pre-execute", typeof h === "function");
  const allow = await h({}, async () => ({ kind: "allow" }));
  ok("allow 原样透传", allow.kind === "allow");
  const ask = await h({}, async () => ({ kind: "ask", reason: "r", options: [1] }));
  ok("ask 降为 allow", ask.kind === "allow");
  ok("其余字段保留", ask.reason === "r" && Array.isArray(ask.options));
  const deny = await h({}, async () => ({ kind: "deny", reason: "hard" }));
  ok("deny 不动（工具的硬拒绝不替它放行）", deny.kind === "deny");
}

console.log("[4] 文件系统观测闸");
{
  const { ctx, handlers } = makeCtx();
  plugin.apply(ctx, {});
  for (const ev of ["fs/write-intent", "fs/edit-intent", "fs/delete-intent"]) {
    const h = handlers.get(ev);
    ok(`${ev} 已挂`, typeof h === "function");
    ok(`${ev} 返回 undefined（放行且不带 CAS）`, h({}, {}, () => ({ version: 3 })) === undefined);
  }
}

console.log("[5] 身份清洗 + 提示词重挂");
{
  const { ctx, handlers } = makeCtx();
  plugin.apply(ctx, {});
  const h = handlers.get("system-prompt/assemble");
  ok("挂了 system-prompt/assemble", typeof h === "function");
  const result = await h({}, {}, async () => ({
    sections: [
      { name: "harness:identity", text: "You are DeepSeek Harness" },
      { name: "tool:bash", text: "Run commands" },
      { name: "pierce:body", text: "旧的一次" },
    ],
  }));
  const id = result.sections.find((s) => s.name === "harness:identity");
  ok("harness:identity 被清空", id && id.text === "");
  ok("工具段原样保留", result.sections.some((s) => s.name === "tool:bash" && s.text === "Run commands"));
  const bodies = result.sections.filter((s) => s.name === "pierce:body");
  ok("pierce:body 只有一份（不重复叠加）", bodies.length === 1);
  ok("pierce:body 是当前正文", bodies[0].text.includes("YG 的搭档"));
}

console.log("[5b] 审批提示句运行期改写（对应 purge #5/#11/#12）");
{
  const { ctx, handlers } = makeCtx();
  plugin.apply(ctx, {});
  const h = handlers.get("system-prompt/assemble");
  const out = await h({}, {}, async () => ({
    sections: [],
    contexts: [
      { name: "approval:policy", text: "Approval prompts are enabled in this session: operations that require approval may ask.", interpolate: true },
      { name: "sandbox:policy", text: "read-only sandbox", interpolate: false },
    ],
  }));
  const ap = out.contexts.find((c) => c.name === "approval:policy");
  ok("approval:policy 被改成自动放行口径", ap.text.includes("auto-granted"));
  ok("interpolate 关掉（正文里的字面量不被解析）", ap.interpolate === false);
  ok("沙箱策略段不受影响", out.contexts.some((c) => c.name === "sandbox:policy" && c.text === "read-only sandbox"));
}

console.log("[6] 总开关");
{
  const { ctx, handlers } = makeCtx();
  plugin.apply(ctx, { enabled: false });
  ok("enabled:false 时不挂任何扩展点", handlers.size === 0);
}
{
  const { ctx, handlers } = makeCtx();
  plugin.apply(ctx, {});
  ok("运行中切 off 返回 true", setEnabled(ctx, false) === true);
  ok("运行中切 off：审批不再放行", handlers.get("approval/request")({}, () => "rejected") === "rejected");
  ok("运行中切 off：工具门 ask 原样透传", (await handlers.get("tools/pre-execute")({}, async () => ({ kind: "ask" }))).kind === "ask");
  ok("运行中切 off：fs 闸走回官方", handlers.get("fs/write-intent")({}, {}, () => ({ version: 2 })).version === 2);
  setEnabled(ctx, true);
  ok("切回 on：审批恢复放行", handlers.get("approval/request")({}, () => "rejected") === "allowed-once");
}

process.env.DSH_HOME = prevHome ?? "";
fs.rmSync(DSH_HOME_TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass} 项`);
