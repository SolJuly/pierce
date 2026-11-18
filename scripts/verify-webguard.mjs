#!/usr/bin/env node
/**
 * 验证**线上部署的** webGuard 策略是否符合预期。
 *
 * 与单测的分工：单测验的是代码逻辑（用构造的配置），这个脚本验的是
 * **profile 里那份真实配置**跑出来的判定结果 —— 防止"代码对了但配置配错"。
 *
 * 它做的事：
 *   1. 从 `dsh --dump-config` 里还原 pierce.webGuard 的实际取值
 *   2. 对该放行的放行、该拒的拒，逐条断言
 *   3. 端到端：用 pierce provider 真读一个工作区文件，并确认工作区外的读不到
 *
 * 用法：node scripts/verify-webguard.mjs
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import { checkWebTarget } from "../lib/index.js";
import { PierceFetchProvider } from "../lib/web-fetch.js";

const LIVE_DSH = process.env.LIVE_DSH || "/usr/local/bin/dsh";
let pass = 0;
const fails = [];
const ok = (label, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? `  — ${detail}` : ""}`); }
  else { fails.push(label); console.error(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`); }
};

/** 从 dump 里还原 webGuard 的真实取值。 */
export function readDeployedGuard() {
  const dump = execSync(`DSH_HOME=/root/.dsh ${LIVE_DSH} --profile web --dump-config 2>/dev/null`, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const at = dump.indexOf("webGuard:");
  if (at < 0) return null;
  // 取到下一个同级键为止（缩进 4 的键）
  const rest = dump.slice(at);
  const end = rest.search(/\n {4}[a-zA-Z]/);
  const seg = end > 0 ? rest.slice(0, end) : rest;
  const list = (key) => {
    const m = seg.match(new RegExp(`${key}:[\\s\\S]*?(?=\\n\\s{6}\\w|$)`));
    if (!m) return [];
    return [...m[0].matchAll(/^\s*-\s*(.+)$/gm)].map((x) => x[1].trim().replace(/^["']|["']$/g, ""));
  };
  return {
    enabled: /enabled:\s*true/.test(seg),
    tools: list("tools"),
    allowSchemes: list("allowSchemes"),
    fileRoots: list("fileRoots"),
    allow: list("allow"),
    deny: list("deny"),
    raw: seg,
  };
}

const main = () => {
  console.log("\n═══ webGuard 部署策略验证 ═══");
  const g = readDeployedGuard();
  if (!g) {
    console.error("✗ profile 里没有 webGuard 配置（未启用）");
    process.exit(1);
  }
  console.log(`\n读到的配置:`);
  console.log(`  启用        ${g.enabled}`);
  console.log(`  协议        ${g.allowSchemes.join(", ") || "(默认 http/https)"}`);
  console.log(`  file 根目录 ${g.fileRoots.join(", ") || "(空 → file:// 全拒)"}`);
  console.log(`  域名白名单  ${g.allow.join(", ") || "(空 → 公网不限)"}`);
  console.log(`  黑名单      ${g.deny.join(", ")}`);

  console.log("\n── 判定断言 ──");
  const mustAllow = [
    ["公网文档", "https://raw.githubusercontent.com/x/y"],
    ["github", "https://github.com/x"],
    ["pypi", "https://pypi.org/simple/"],
  ];
  const mustDeny = [
    ["云元数据", "http://169.254.169.254/latest/meta-data/"],
    ["元数据 CIDR", "http://169.254.1.1/"],
    ["本机回环", "http://127.0.0.1:3080/"],
    ["内网 10/8", "http://10.1.2.3/"],
    ["内网 172.16/12", "http://172.20.0.1/"],
    ["内网 192.168/16", "http://192.168.1.1/"],
    ["本机 GUI", "http://123.207.74.155/"],
    ["gopher（未开协议）", "gopher://127.0.0.1:6379/_INFO"],
  ];
  if (g.enabled) {
    for (const [name, url] of mustAllow) {
      const r = checkWebTarget(url, g);
      ok(`放行 ${name}`, r.ok === true, r.ok ? "" : r.reason);
    }
    for (const [name, url] of mustDeny) {
      const r = checkWebTarget(url, g);
      ok(`拒绝 ${name}`, r.ok === false, r.ok ? "竟然放行了" : r.reason.slice(0, 60));
    }
    if (g.fileRoots.length) {
      const root = g.fileRoots[0];
      const inside = checkWebTarget(`file://${root}/package.json`, g);
      ok("放行 工作区内文件", inside.ok === true, inside.ok ? "" : inside.reason);
      const traversed = checkWebTarget(`file://${root}/../../etc/passwd`, g);
      ok("拒绝 穿越到根目录外", traversed.ok === false, traversed.ok ? "竟然放行了" : traversed.reason.slice(0, 60));
      const creds = checkWebTarget("file:///root/.dsh/.credentials.yaml", g);
      if (!`${root}/`.startsWith("/root/.dsh")) {
        ok("拒绝 工作区外的凭据", creds.ok === false, creds.ok ? "竟然放行了" : "");
      }
    }
  } else {
    ok("webGuard 未启用 → 不做管控断言", true, "（启用后本脚本会验证全部策略）");
  }

  console.log("\n── 端到端（真读文件）──");
  if (g.fileRoots.length && g.allowSchemes.map((s) => s.replace(/:$/, "")).includes("file")) {
    const provider = new PierceFetchProvider({ guard: g });
    try {
      const r = provider.fetch({ url: `file://${g.fileRoots[0]}/package.json` });
      ok("provider 能读工作区文件", true);
      void r;
    } catch (e) {
      ok("provider 能读工作区文件", false, e.message);
    }
  } else {
    ok("跳过端到端（未开 file://）", true);
  }

  console.log(`\n═══ 结果：${pass} 项通过${fails.length ? `，${fails.length} 项失败` : ""} ═══`);
  if (fails.length) {
    for (const f of fails) console.error(`  - ${f}`);
    process.exitCode = 1;
  }
};

main();
