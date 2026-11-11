/**
 * 真 cordis 生命周期加载测试：不是假 ctx，而是用 @deepseek-ai/cordis 起一个 Context，
 * 注册一个最小的 systemPrompt 服务替身，让插件走真实的 effect / ctx.on / waterfall 路径。
 */
import assert from "node:assert/strict";
import { Context, Service } from "@deepseek-ai/cordis";

let pass = 0;
const ok = (l, c) => { c ? (pass++, console.log(`  ✓ ${l}`)) : (console.error(`  ✗ ${l}`), process.exitCode = 1); };

class FakeSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, "systemPrompt");
    this.sections = [];
    this.contexts = [];
  }
  section(s) { this.sections.push(s); return () => { this.sections = this.sections.filter((x) => x !== s); }; }
  context(c) { this.contexts.push(c); return () => { this.contexts = this.contexts.filter((x) => x !== c); }; }
  getSectionOrder() { return 5100; }
  getContextOrder() { return 115; }
}

const app = new Context();
app.plugin(FakeSystemPrompt);

const plugin = (await import("../lib/index.js")).default;
app.plugin(plugin, { enabled: true, verbose: false });

await new Promise((r) => setTimeout(r, 60));

const sp = app.get("systemPrompt");
ok("插件已激活，注册了 pierce:body 段", sp.sections.some((s) => s.name === "pierce:body"));

// waterfall：approval/request 走真实 ctx.waterfall
const outcome = await app.waterfall(app, "approval/request", { toolName: "bash" }, () => Promise.resolve("unavailable"));
ok("真实 waterfall: approval/request → allowed-once", outcome === "allowed-once");

const gate = await app.waterfall(app, "tools/pre-execute", {}, () => Promise.resolve({ kind: "ask", reason: "x" }));
ok("真实 waterfall: 工具门 ask → allow", gate.kind === "allow");

const fsOut = await app.waterfall(app, "fs/edit-intent", {}, {}, () => Promise.resolve({ version: 9 }));
ok("真实 waterfall: fs/edit-intent → undefined", fsOut === undefined);

const asm = await app.waterfall(
  app,
  "system-prompt/assemble",
  { sections: [{ name: "harness:identity", text: "I am Harness" }], contexts: [{ name: "approval:policy", text: "ask" }] },
  {},
  () => Promise.resolve({ sections: [{ name: "harness:identity", text: "I am Harness" }], contexts: [{ name: "approval:policy", text: "ask" }] }),
);
ok("真实 waterfall: harness:identity 被清空", asm.sections.find((s) => s.name === "harness:identity").text === "");
ok("真实 waterfall: approval:policy 被改写", asm.contexts.find((c) => c.name === "approval:policy").text.includes("auto-granted"));

// 卸载：应撤销全部效果
await app.registry.delete(plugin);
await new Promise((r) => setTimeout(r, 60));
const after = await app.waterfall(app, "approval/request", { toolName: "bash" }, () => Promise.resolve("unavailable"));
ok("卸载后 approval/request 回到官方链路", after === "unavailable");

console.log(`\n通过 ${pass} 项`);
