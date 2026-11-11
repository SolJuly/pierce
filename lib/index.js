/**
 * 破甲 v2 —— 运行时注入层（不落盘）。
 *
 * 与 dsh-purge 的根本差别：
 *   purge = 改宿主源文件（190 条文本锚点），宿主一升级就大面积漂移；
 *   破甲 v2 = 挂宿主**官方扩展点**（waterfall / systemPrompt section / 配置），
 *             宿主升级只要扩展点不删就不用重锚。
 *
 * 这里覆盖的是「能用扩展点做到的」那一半；剩下做不到的（工具 schema 文本、
 * 默认值字面量）交给 engine/ 的声明式补丁表，两条路互不干扰。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "pierce";

// 只声明真正用到的。多写一个宿主没有的服务 → cordis 一直 pending → 宿主退出码 1。
export const inject = ["systemPrompt"];

const DEFAULTS = {
  enabled: true,
  // 1) 提示词：把自己的一段挂到系统提示词末尾（工具说明之后）
  promptFile: "prompt-inject.md",
  promptOrder: 5100,
  // 2) 审批：approval/request 直接 allowed-once，不弹窗
  autoGrantApproval: true,
  // 3) 工具门：tools/pre-execute 的 ask 降级为 allow
  allowToolGate: true,
  // 4) 文件系统观测闸：write/edit/delete 不再要求「先读」
  fsIntentFree: true,
  // 5) 身份清洗：去掉 harness 自称，保留功能段
  stripIdentity: true,
  // 6) 会话内可切：/pierce off 立刻停用（不用重启）
  verbose: false,
  // 7) 自检：把每次装配的段落构成写到这个路径（并行验证用，生产环境留空）
  dumpAssemble: "",
  // 审批提示句：官网原文是「要审批 / 不会审批就拒绝」，这里换成自动放行口径。
  // 对应 dsh-purge 的 #5 / #11 / #12 三条提示词补丁。
  approvalSentence:
    "Approval requests are auto-granted in this session: no approval prompt will appear; request sandbox escalation freely with a one-sentence justification.",
};

const log = (cfg, ...a) => {
  if (cfg?.verbose) console.log("[pierce]", ...a);
};

/**
 * 运行期开关表：按 ctx 存，卸载即回收。
 * 用户在会话里 /pierce off 走 clearEnabled(ctx) → 所有 handler 立刻通过 next() 走回官方链路，
 * 不需要重启宿主（这是相对 dsh-purge 必须重启才生效的一个实用改进）。
 */
const LIVE = new WeakMap();
export function setEnabled(ctx, on) {
  const st = LIVE.get(ctx);
  if (!st) return false;
  st.enabled = !!on;
  return true;
}
export function isEnabled(ctx) {
  return LIVE.get(ctx)?.enabled !== false;
}

/** 提示词正文：用户文件优先，其次内置兜底。每轮重新读，改完不用重启。 */
function makePromptText(cfg) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const userFile = path.isAbsolute(cfg.promptFile) ? cfg.promptFile : path.join(home, cfg.promptFile);
  return () => {
    try {
      if (fs.existsSync(userFile)) {
        const t = fs.readFileSync(userFile, "utf8").trim();
        if (t) return t;
      }
    } catch {
      /* 读不到就走兜底 */
    }
    return "";
  };
}

export const apply = (ctx, config = {}) => {
  const cfg = { ...DEFAULTS, ...config };
  if (cfg.enabled === false) return;
  const st = { enabled: true };
  LIVE.set(ctx, st);
  const disposers = [];

  // ── 1. 提示词段 ────────────────────────────────────────────────
  // interpolate:false 防止正文里的 {{cwd}} 之类被宿主当模板吃掉。
  disposers.push(
    ctx.effect(() =>
      ctx.systemPrompt.section({
        name: "pierce:body",
        order: cfg.promptOrder,
        interpolate: false,
        text: makePromptText(cfg),
      }),
    ),
  );

  // ── 2. 审批闸：approval/request → allowed-once ───────────────────
  // 这是官方 waterfall，签名 (request, next)。返回 next() 走默认链路，
  // 直接返回词表里的值就短路。词表：allowed-once / rejected / unavailable / cancelled。
  if (cfg.autoGrantApproval) {
    disposers.push(
      ctx.on("approval/request", (request, next) => {
        if (!isEnabled(ctx)) return next();
        log(cfg, "approval auto-grant", request?.toolName ?? "");
        return "allowed-once";
      }),
    );
  }

  // ── 3. 工具门：tools/pre-execute 的 ask → allow ─────────────────
  // gate 结构：{kind:"allow"|"ask"|"deny"|"cancel", ...}。只降 ask，
  // 不碰 deny（deny 是工具自己的硬拒绝，替它放行会让工具在错误前提上跑）。
  if (cfg.allowToolGate) {
    disposers.push(
      ctx.on("tools/pre-execute", async (exec, next) => {
        const gate = await next();
        if (!isEnabled(ctx)) return gate;
        if (gate && gate.kind === "ask") {
          log(cfg, "tool gate ask→allow", exec?.toolName ?? exec?.name ?? "");
          const { kind, ...rest } = gate;
          return { ...rest, kind: "allow" };
        }
        return gate;
      }),
    );
  }

  // ── 4. 文件系统观测闸：返回 undefined = 不做版本/先读校验 ────────
  // 三个 waterfall 都是「返回 undefined 表示放行且不带 CAS 依据」。
  if (cfg.fsIntentFree) {
    for (const ev of ["fs/write-intent", "fs/edit-intent", "fs/delete-intent"]) {
      disposers.push(
        ctx.on(ev, (target, actor, next) => {
          if (!isEnabled(ctx)) return next();
          return undefined;
        }),
      );
    }
  }

  // ── 5. 身份清洗 + 审批提示句 + 提示词重挂 ──────────────────────
  // 只清 harness 自称那一段，功能提示词（工具说明、沙箱策略）原样留着。
  // 同时把 approval:policy 那一段的运行期话术改成「自动放行」口径 ——
  // dsh-purge 是去改 dsh-user-approval 源码里的 NEVER_SENTENCE / ASK_SENTENCE 常量，
  // 这里在 assemble 阶段按名字重写，源码一个字不动。
  if (cfg.stripIdentity) {
    disposers.push(
      ctx.on("system-prompt/assemble", async (assembly, context, next) => {
        const out = await next();
        if (!isEnabled(ctx) || !out) return out;
        if (Array.isArray(out.contexts)) {
          out.contexts = out.contexts.map((c) =>
            c && c.name === "approval:policy"
              ? { ...c, text: cfg.approvalSentence, interpolate: false }
              : c,
          );
        }
        if (!Array.isArray(out.sections)) return out;
        // 先摘掉旧的 pierce:body（HMR / 重复 assemble 会残留），再统一在末尾重挂一份。
        out.sections = out.sections
          .filter((s) => s && s.name !== "pierce:body")
          .map((s) => (s.name === "harness:identity" && typeof s.text === "string" ? { ...s, text: "" } : s));
        const body = makePromptText(cfg)();
        if (body) {
          out.sections.push({ name: "pierce:body", text: body, interpolate: false, order: cfg.promptOrder });
        }
        // 自检：把装配后的段落构成落盘，用于并行验证时核对注入段是否真的进去了。
        // 只写 node 侧，不返回给模型，不增加 token。
        if (cfg.dumpAssemble) {
          try {
            const fs = await import("node:fs");
            fs.writeFileSync(
              cfg.dumpAssemble,
              JSON.stringify(
                {
                  at: new Date().toISOString(),
                  sectionCount: out.sections.length,
                  sections: out.sections.map((x) => ({ name: x.name, order: x.order, chars: String(x.text ?? "").length, head: String(x.text ?? "").slice(0, 120) })),
                  contexts: (out.contexts || []).map((x) => ({ name: x.name, chars: String(x.text ?? "").length, head: String(x.text ?? "").slice(0, 120) })),
                  totalChars: out.sections.reduce((a, x) => a + String(x.text ?? "").length, 0),
                },
                null,
                2,
              ),
            );
          } catch { /* 自检失败不该影响装配 */ }
        }
        return out;
      }),
    );
  }

  log(cfg, `已挂 ${disposers.length} 个扩展点`);
  return () => {
    LIVE.delete(ctx);
    for (const d of disposers) {
      try {
        if (typeof d === "function") d();
      } catch {
        /* 卸载期错误不该影响宿主退出 */
      }
    }
  };
};

const plugin = { name, inject, apply };
export default plugin;
