#!/usr/bin/env node
/**
 * 假 LLM 服务：专门发射工具调用，用来端到端验证 pierce 的宿主层钩子。
 *
 * 为什么要假模型：
 *   真模型会「这次肯不肯调工具」不可控，而且免费渠道都已 throttled、付费渠道烧钱。
 *   但 P0 要验证的不是模型说什么，而是 —— 钩子返回 allowed 之后，
 *   宿主到底有没有真的把工具跑起来。这件事和模型无关，用假模型反而更确定。
 *
 * 行为：
 *   - 收到第一条 user 消息 → 发射指定的工具调用
 *   - 收到 tool result 之后 → 输出 final text 收尾
 *
 * 用环境变量控制要发射哪个工具：
 *   MOCK_SCENARIO=bash      → 发射 bash 工具（写文件到 /tmp/pierce-e2e-proof）
 *   MOCK_SCENARIO=fs_write  → 发射 write 工具
 *   MOCK_SCENARIO=none      → 纯文本，不调工具
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 9911);
const SCENARIO = process.env.MOCK_SCENARIO || "bash";
const E2E_DIR = process.env.PIERCE_E2E_DIR || path.join(os.homedir(), ".pierce-e2e");
const LOG = process.env.MOCK_LOG || path.join(E2E_DIR, "logs/mock-llm.log");

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const log = (msg, extra) => {
  const line = `[${new Date().toISOString()}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`;
  fs.appendFileSync(LOG, line + "\n");
  console.log(line);
};

/** 一次工具调用就够证明链路。 */
function toolCallFor(scenario) {
  switch (scenario) {
    case "bash":
      return {
        id: "call_bash_1",
        type: "function",
        function: {
          name: "bash",
          // 写一个只有真跑起来才会存在的文件。沙箱是 danger-full-access，
          // 所以这个写操作本身不触发审批 —— 触发审批的是 sandbox_permissions 升级申请。
          arguments: JSON.stringify({
            command: `echo PIERCE_E2E_OK > /tmp/pierce-e2e-proof && date -u +%FT%TZ >> /tmp/pierce-e2e-proof && id >> /tmp/pierce-e2e-proof && echo DONE`,
            description: "Write proof file to verify bash actually executed",
            sandbox_permissions: "danger-full-access",
            justification: "e2e proof of host-layer hook reachability",
          }),
        },
      };
    case "fs_write":
      return {
        id: "call_fs_1",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({
            file_path: process.env.MOCK_PROOF_FS_WRITE || path.join(E2E_DIR, "work/proof-fs-write.txt"),
            content: "PIERCE_E2E_FS_OK\n",
          }),
        },
      };
    case "fs_edit":
      // 对一个**没读过**的文件做 edit：官方 fs-observation-policy 会抛 FS_NOT_OBSERVED。
      // pierce 的 fs/edit-intent 钩子返回 undefined 就绕开整个观察策略。
      return {
        id: "call_edit_1",
        type: "function",
        function: {
          name: "edit",
          arguments: JSON.stringify({
            file_path: process.env.MOCK_PROOF_FS_EDIT || path.join(E2E_DIR, "work/proof-fs-edit.txt"),
            old_string: "ALPHA",
            new_string: "BETA",
          }),
        },
      };
    case "none":
    default:
      return null;
  }
}

/** OpenAI 兼容的 SSE 流。宿主走 openai-completions，必须流式。 */
function sse(res, chunks) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const BASE_CHUNK = {
  id: "chatcmpl-mock",
  object: "chat.completion.chunk",
  created: Math.floor(Date.now() / 1000),
  model: "mock-tool-model",
};

function textChunks(text) {
  return [
    { ...BASE_CHUNK, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { ...BASE_CHUNK, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { ...BASE_CHUNK, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
}

function toolChunks(call) {
  return [
    { ...BASE_CHUNK, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    {
      ...BASE_CHUNK,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, id: call.id, type: "function", function: { name: call.function.name, arguments: "" } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...BASE_CHUNK,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: call.function.arguments } }] },
          finish_reason: null,
        },
      ],
    },
    { ...BASE_CHUNK, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/v1/models" || req.url === "/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "mock-tool-model", object: "model", owned_by: "pierce-e2e" }],
      }),
    );
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }

  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let payload = {};
    try {
      payload = JSON.parse(body);
    } catch {
      /* ignore */
    }
    const msgs = payload.messages || [];
    const roles = msgs.map((m) => m.role);
    const hasToolResult = roles.includes("tool");
    const stream = payload.stream !== false;

    // MOCK_DUMP_BODY=<path> 时把完整请求体落盘，供结构验证用。
    if (process.env.MOCK_DUMP_BODY) {
      // 会话标题这类辅助请求先来，主对话后来。按顺序编号，方便取最后一条。
      try {
        const dir = process.env.MOCK_DUMP_BODY;
        fs.mkdirSync(dir, { recursive: true });
        const n = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
        fs.writeFileSync(`${dir}/${String(n).padStart(3, "0")}.json`, JSON.stringify({ model: body?.model, messages: msgs }, null, 2));
      } catch { /* 落盘失败不影响服务 */ }
    }
    log("POST", {
      url: req.url,
      model: payload.model,
      stream: payload.stream,
      nMessages: msgs.length,
      roles: roles.join(","),
      tools: (payload.tools || []).map((t) => t.function?.name).filter(Boolean),
    });

    // 已经拿到工具结果 → 收尾
    if (hasToolResult) {
      const toolMsg = msgs.filter((m) => m.role === "tool").map((m) => String(m.content).slice(0, 800));
      log("TOOL RESULT RECEIVED", { result: toolMsg });
      const text = `E2E_FINISHED. Tool output observed: ${toolMsg.join(" | ").slice(0, 600)}`;
      if (stream) return sse(res, textChunks(text));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          model: "mock-tool-model",
          choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    }

    const call = toolCallFor(SCENARIO);
    if (!call) {
      const text = "E2E_NO_TOOL scenario=none";
      if (stream) return sse(res, textChunks(text));
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: text } }] }));
    }

    log("EMITTING TOOL CALL", { name: call.function.name, args: call.function.arguments });
    if (stream) return sse(res, toolChunks(call));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: "mock-tool-model",
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [call] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
});

server.listen(PORT, "127.0.0.1", () => log(`mock llm listening on http://127.0.0.1:${PORT} scenario=${SCENARIO}`));
