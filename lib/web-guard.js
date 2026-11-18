/**
 * web 管控的判定核心 —— 从 lib/index.js 抽出来的独立模块。
 *
 * ## 为什么要单独一个文件
 *
 * 判定逻辑有两个使用者：
 *   1. `lib/index.js` 的 `tools/pre-execute` 钩子 —— 拦工具入口的**初始 URL**
 *   2. `lib/web-fetch.js` 的 provider —— 拦**重定向的每一跳**
 *
 * 为什么第二个必须存在：钩子只看得到 `exec.arguments.url`，也就是初始地址。
 * 官方 `http` provider 拒跨域重定向，所以只靠钩子时白名单是有效的；但 pierce
 * 自己的 provider 会跟随跨域重定向：
 *
 *     allow: [github.com] → 请求 github.com/x → 302 到 evil.com → 实际抓到 evil.com
 *
 * 钩子检查的是 github.com，放行了；真正被抓的是 evil.com。白名单形同虚设。
 *
 * 抽成独立文件是为了避免 index.js ↔ web-fetch.js 循环依赖。
 *
 * ## 三层判定，顺序固定
 *
 *   ① scheme   —— 协议白名单。默认只许 http/https；要用 file:// 必须显式开。
 *   ② file     —— file:// 的路径必须落在 fileRoots 里（realpath 之后），防穿越。
 *   ③ host     —— 域名 / IP / CIDR 的黑白名单。
 *
 * 顺序不能换：scheme 先挡掉不该出现的协议，file 在 host 之前因为 file:// 没有 host。
 *
 * @module dsh-pierce/web-guard
 */
import fs from "node:fs";
import path from "node:path";

/** 默认允许的协议。file:// 必须显式加进 allowSchemes 才放行。 */
export const DEFAULT_SCHEMES = ["http:", "https:"];

/** 归一化协议名："http" / "http:" / "HTTP" 都收成 "http:"。 */
export function normalizeScheme(s) {
  const t = String(s ?? "").trim().toLowerCase();
  if (!t) return "";
  return t.endsWith(":") ? t : `${t}:`;
}

export function hostOfWebTarget(u) {
  const raw = String(u ?? "").trim();
  if (!raw) return null;
  try {
    const withScheme = raw.includes("://") ? raw : `http://${raw}`;
    const h = new URL(withScheme).hostname.toLowerCase();
    return h || null;
  } catch {
    return null;
  }
}

/** 取协议（带冒号，小写）。解析失败返回 null。 */
export function schemeOfWebTarget(u) {
  const raw = String(u ?? "").trim();
  if (!raw) return null;
  try {
    const withScheme = raw.includes("://") ? raw : `http://${raw}`;
    return new URL(withScheme).protocol.toLowerCase();
  } catch {
    return null;
  }
}

// ── IPv4 / CIDR ──────────────────────────────────────────────────────

/** 是不是 IPv4 字面量。 */
export function isIPv4(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(host ?? ""));
}

/** 点分四段 → 32 位无符号整数；非法返回 null。 */
export function ipv4ToInt(ip) {
  if (!isIPv4(ip)) return null;
  const parts = String(ip).split(".").map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * IPv4 CIDR 匹配，例如 `192.168.0.0/16`。
 * 只支持 IPv4 —— IPv6 的 CIDR 在 web 管控这个场景里用不上，不实现免得半吊子。
 *
 * @param host - 小写 host（IPv4 字面量）
 * @param cidr - 形如 "10.0.0.0/8"
 */
export function ipv4InCidr(host, cidr) {
  const [net, bitsRaw] = String(cidr ?? "").split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const h = ipv4ToInt(host);
  const n = ipv4ToInt(net);
  if (h === null || n === null) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((h & mask) >>> 0) === ((n & mask) >>> 0);
}

/**
 * 域名 / IP / CIDR 匹配。
 *
 * 规则（大小写不敏感）：
 *   `*`            全部
 *   `*.example.com` 裸域和所有子域
 *   `.example.com`  只匹配子域
 *   `example.com`   完全相等
 *   `10.0.0.0/8`     IPv4 网段（host 必须是 IPv4 字面量）
 */
export function hostMatchesPattern(host, pattern) {
  const p = String(pattern ?? "").trim().toLowerCase();
  if (!p) return false;
  if (p === "*") return true;
  if (p.includes("/")) return ipv4InCidr(host, p);
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  if (p.startsWith(".")) return host.endsWith(p);
  return host === p;
}

// ── file:// 路径护栏 ─────────────────────────────────────────────────

/**
 * 判断 file:// 的路径是否落在允许的根目录内。
 *
 * 这是 `file://` 唯一的防线，三个坑都在这儿挡住：
 *
 *   1. `..` 穿越 —— 先 `path.resolve` 归一，再比前缀
 *   2. 目录符号链接 —— `realpath` 之后比前缀，`root/link -> /etc` 会被识破
 *   3. 文件本身是符号链接 —— 文件存在时对**整个路径**做 realpath（跟着链接走），
 *      所以 `root/passwd -> /etc/passwd` 也会被识破
 *
 * 文件不存在时无法 realpath 整个路径，退化成「realpath(父目录) + 文件名」——
 * 这样至少目录层的穿越和链接仍然被挡住。
 *
 * @param fileUrl - file:// 的 URL 实例
 * @param roots - 允许的根目录列表
 * @returns {{ok:true, realPath:string} | {ok:false, reason:string}}
 */
export function checkFileRoot(fileUrl, roots) {
  const list = (Array.isArray(roots) ? roots : []).filter((r) => typeof r === "string" && r.trim());
  if (!list.length) {
    return { ok: false, reason: "file:// 未配置 fileRoots，默认拒绝" };
  }

  let decoded;
  try {
    decoded = decodeURIComponent(fileUrl.pathname);
  } catch {
    return { ok: false, reason: `file:// 路径编码非法（${String(fileUrl.pathname).slice(0, 80)}）` };
  }
  const abs = path.resolve(decoded);

  // 先试整个路径（文件存在时能抓到文件级符号链接）
  let real = null;
  try {
    real = fs.realpathSync(abs);
  } catch {
    // 文件不存在：退化成 realpath(父目录) + basename
    try {
      real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return { ok: false, reason: `file:// 路径不可解析（${abs.slice(0, 100)}）` };
    }
  }

  for (const root of list) {
    let realRoot;
    try {
      realRoot = fs.realpathSync(path.resolve(root));
    } catch {
      realRoot = path.resolve(root);
    }
    const rel = path.relative(realRoot, real);
    // rel === "" → 就是根本身；不以 .. 开头且不是绝对路径 → 在根内
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      return { ok: true, realPath: real };
    }
  }
  return {
    ok: false,
    reason: `file:// 路径不在允许的根目录内（${real.slice(0, 80)}；允许 ${list.join(", ")}）`,
  };
}

// ── 统一判定 ─────────────────────────────────────────────────────────

/**
 * 对单个 URL 做完整判定（scheme → file 路径 → host 名单）。
 *
 * 工具入口和 provider 每一跳都调这个函数，**只有一处真相** —— 两边各写一份
 * 迟早分叉（上一版就是：钩子只看初始 URL，provider 不查，302 就绕过去了）。
 *
 * @param rawUrl - 原始 URL 字符串
 * @param g - cfg.webGuard
 * @returns {ok:true} | {ok:false, reason:string}
 */
export function checkWebTarget(rawUrl, g) {
  if (!g || g.enabled === false) return { ok: true };

  const raw = String(rawUrl ?? "");
  if (!raw.trim()) return { ok: false, reason: "目标地址为空" };

  // ① scheme
  const scheme = schemeOfWebTarget(raw);
  if (scheme === null) return { ok: false, reason: `解析不出目标地址（${raw.slice(0, 80)}）` };
  const allowed = Array.isArray(g.allowSchemes) && g.allowSchemes.length
    ? g.allowSchemes.map(normalizeScheme)
    : DEFAULT_SCHEMES;
  if (!allowed.includes(scheme)) {
    return {
      ok: false,
      reason: `协议 ${scheme} 不在允许范围（允许 ${allowed.join(", ")}）`,
    };
  }

  // ② file:// 路径
  if (scheme === "file:") {
    let u;
    try {
      u = new URL(raw.includes("://") ? raw : `file://${raw}`);
    } catch {
      return { ok: false, reason: `file:// 地址非法（${raw.slice(0, 80)}）` };
    }
    const r = checkFileRoot(u, g.fileRoots);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  // ③ host 名单
  const host = hostOfWebTarget(raw);
  if (host === null) return { ok: false, reason: `解析不出 host（${raw.slice(0, 80)}）` };

  const deny = Array.isArray(g.deny) ? g.deny : [];
  const allow = Array.isArray(g.allow) ? g.allow : [];
  const hitDeny = deny.find((p) => hostMatchesPattern(host, p));
  if (hitDeny) return { ok: false, reason: `${host} 命中拒绝名单（${hitDeny}）` };
  if (allow.length && !allow.some((p) => hostMatchesPattern(host, p))) {
    return { ok: false, reason: `${host} 不在白名单（允许 ${allow.join(", ")}）` };
  }
  return { ok: true };
}

/**
 * 判定一次工具调用是否被 web 管控拦下（工具入口用）。
 *
 * @param exec - tools/pre-execute 的 exec（字段：name、arguments）
 * @param g - cfg.webGuard
 * @returns 拦下的 gate 对象 {kind:"deny", reason}；放行返回 null
 */
export function webVerdict(exec, g) {
  if (!g || g.enabled === false) return null;
  const tools = Array.isArray(g.tools) && g.tools.length ? g.tools : ["web_fetch"];
  const name = exec?.name ?? exec?.toolName ?? "";
  if (!tools.includes(name)) return null;
  const raw = exec?.arguments?.url;
  if (typeof raw !== "string" || !raw.trim()) return null;

  const r = checkWebTarget(raw, g);
  return r.ok ? null : { kind: "deny", reason: `破甲 web 管控：${r.reason}` };
}

/**
 * 判定重定向链上的某一跳是否允许（provider 内部用）。
 *
 * 与 webVerdict 的区别：这一层不返回 gate，直接抛错 —— provider 的契约是
 * 要么返回结果要么抛，没有"降级放行"这种中间态。
 *
 * @param url - 当前这一跳的 URL（URL 实例或字符串）
 * @param g - cfg.webGuard
 * @throws 任何一个检查不过
 */
export function assertHopAllowed(url, g) {
  if (!g || g.enabled === false) return;
  const r = checkWebTarget(String(url), g);
  if (!r.ok) throw new Error(`破甲 web 管控（逐跳）：${r.reason}`);
}
