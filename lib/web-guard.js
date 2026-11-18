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
import dns from "node:dns/promises";
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

// ── IPv6 ─────────────────────────────────────────────────────────────

/**
 * 解析 IPv6 字面量为 16 字节数组。
 *
 * 为什么必须支持：`new URL("http://[::1]:3080/").hostname` 返回 `"[::1]"`，
 * 而 `isIPv4` 不认 —— 上一版直接放过，等于 IPv6 回环完全不设防。
 * 审核实测过 `http://[::1]:3080/` 能通。
 *
 * 支持 `::` 压缩、`::ffff:1.2.3.4` 嵌入 IPv4、大小写。
 * @returns {Uint8Array|null} 16 字节；非法返回 null
 */
export function parseIPv6(input) {
  let h = String(input ?? "").trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h.includes(":")) return null;
  // 去掉 zone id（fe80::1%eth0）
  const pct = h.indexOf("%");
  if (pct >= 0) h = h.slice(0, pct);
  if (h.includes(":::")) return null;

  const halves = h.split("::");
  if (halves.length > 2) return null;

  const expand = (part) => {
    if (!part) return [];
    const out = [];
    for (const g of part.split(":")) {
      if (!g) return null;
      if (g.includes(".")) {
        // 尾部嵌入 IPv4：a.b.c.d → 两组
        const n = ipv4ToInt(g);
        if (n === null) return null;
        out.push((n >>> 16) & 0xffff, n & 0xffff);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  const head = expand(halves[0]);
  const tail = halves.length === 2 ? expand(halves[1]) : [];
  if (head === null || tail === null) return null;

  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = (groups[i] >>> 8) & 0xff;
    bytes[i * 2 + 1] = groups[i] & 0xff;
  }
  return bytes;
}

/** 是不是 IP 字面量（v4 或 v6）。 */
export function isIpLiteral(host) {
  const h = String(host ?? "").replace(/^\[|\]$/g, "");
  return isIPv4(h) || parseIPv6(h) !== null;
}

/**
 * IPv6 CIDR 匹配，例如 `::1/128`、`fc00::/7`、`fe80::/10`。
 * @param host - IPv6 字面量（可带方括号）
 * @param cidr - 形如 "fc00::/7"
 */
export function ipv6InCidr(host, cidr) {
  const [net, bitsRaw] = String(cidr ?? "").split("/");
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  const h = parseIPv6(host);
  const n = parseIPv6(net);
  if (!h || !n) return false;
  let remaining = bits;
  for (let i = 0; i < 16; i++) {
    if (remaining <= 0) return true;
    const take = Math.min(8, remaining);
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
    if ((h[i] & mask) !== (n[i] & mask)) return false;
    remaining -= take;
  }
  return true;
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
  if (p.includes("/")) return ipv4InCidr(host, p) || ipv6InCidr(host, p);
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
    // 把 realPath 带出去：provider 必须用这个真实路径去读，
    // 否则「检查用 realpath、读取用原路径」之间留一个符号链接替换窗口（TOCTOU）。
    return r.ok ? { ok: true, realPath: r.realPath } : { ok: false, reason: r.reason };
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
 * 异步版完整判定：静态检查之后，**把域名解析成 IP 再过一遍 deny**。
 *
 * ## 为什么必须有这一层
 *
 * deny 是字符串/CIDR 匹配，不做解析。所以这些写法能绕过只做字面匹配的实现：
 *
 *     http://localhost:3080/          → 解析到 127.0.0.1
 *     http://0.0.0.0:3080/            → Linux 上等价回环
 *     http://[::1]:3080/              → IPv6 回环（hostOfWebTarget 给 "[::1]"）
 *     http://127.0.0.1.nip.io:3080/   → 任意 DNS 名指向回环
 *
 * 审核实测过前三条都能真连上。所以"内网会被拦"这句话只在解析之后才成立。
 *
 * ## 失败模式
 *
 * DNS 解析失败按**放行**处理：解析不了的域名后面 fetch 也会失败，
 * 没必要为了一个本来就连不上的目标去拒绝 —— 而且 DNS 抖动会误伤正常公网抓取。
 *
 * @param rawUrl - 原始 URL
 * @param g - cfg.webGuard
 * @returns {Promise<{ok:true, realPath?:string}|{ok:false, reason:string}>}
 */
export async function checkWebTargetResolved(rawUrl, g) {
  const base = checkWebTarget(rawUrl, g);
  if (!base.ok || !g || g.enabled === false) return base;

  const scheme = schemeOfWebTarget(rawUrl);
  if (scheme === "file:") return base; // file 没有 DNS

  const deny = Array.isArray(g.deny) ? g.deny : [];
  if (!deny.length) return base;

  const host = hostOfWebTarget(rawUrl);
  if (!host) return base;
  const bare = host.replace(/^\[|\]$/g, "");
  // 字面 IP 已经在 checkWebTarget 里判过了，不用再解析
  if (isIpLiteral(bare)) return base;

  let addrs = [];
  try {
    addrs = await dns.lookup(bare, { all: true, verbatim: true });
  } catch {
    return base; // 解析不了 → 放行，让 fetch 自己报错
  }
  for (const { address } of addrs) {
    const ip = String(address).toLowerCase();
    const hit = deny.find((p) => hostMatchesPattern(ip, p));
    if (hit) {
      return {
        ok: false,
        reason: `${bare} 解析到 ${ip}，命中拒绝名单（${hit}）`,
      };
    }
  }
  return base;
}

/**
 * 检查配置本身有没有明显写错的地方，启动时打一次告警。
 *
 * 典型坑：`deny: ["example.com/path"]` —— 含 `/` 会走 CIDR 分支，
 * 但既不是合法 v4 也不是合法 v6 CIDR，结果是**永不命中且静默失效**。
 *
 * @returns {string[]} 告警列表（空 = 没问题）
 */
export function validateGuardConfig(g) {
  const out = [];
  if (!g || typeof g !== "object") return out;
  for (const key of ["allow", "deny"]) {
    const list = Array.isArray(g[key]) ? g[key] : [];
    for (const entry of list) {
      const p = String(entry ?? "").trim();
      if (!p) { out.push(`${key} 有空条目`); continue; }
      if (!p.includes("/")) continue;
      const [net, bits] = p.split("/");
      const v4ok = isIPv4(net) && Number.isInteger(Number(bits)) && Number(bits) >= 0 && Number(bits) <= 32;
      const v6ok = parseIPv6(net) !== null && Number.isInteger(Number(bits)) && Number(bits) >= 0 && Number(bits) <= 128;
      if (!v4ok && !v6ok) {
        out.push(`${key} 里的 "${p}" 不是合法 CIDR（永远匹配不上，等于没写）`);
      }
    }
  }
  const schemes = Array.isArray(g.allowSchemes) ? g.allowSchemes : [];
  for (const sch of schemes) {
    if (!normalizeScheme(sch)) out.push(`allowSchemes 里有空条目`);
  }
  if (schemes.map(normalizeScheme).includes("file:") && !(Array.isArray(g.fileRoots) && g.fileRoots.length)) {
    out.push("开了 file:// 但 fileRoots 为空 → 所有 file:// 都会被拒");
  }
  return out;
}

/**
 * 判定一次工具调用是否被 web 管控拦下（工具入口用）。
 *
 * @param exec - tools/pre-execute 的 exec（字段：name、arguments）
 * @param g - cfg.webGuard
 * @returns 拦下的 gate 对象 {kind:"deny", reason}；放行返回 null
 */
export async function webVerdict(exec, g) {
  if (!g || g.enabled === false) return null;
  const tools = Array.isArray(g.tools) && g.tools.length ? g.tools : ["web_fetch"];
  const name = exec?.name ?? exec?.toolName ?? "";
  if (!tools.includes(name)) return null;
  const raw = exec?.arguments?.url;
  if (typeof raw !== "string" || !raw.trim()) return null;

  const r = await checkWebTargetResolved(raw, g);
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
export async function assertHopAllowed(url, g) {
  if (!g || g.enabled === false) return { ok: true };
  const r = await checkWebTargetResolved(String(url), g);
  if (!r.ok) throw new Error(`破甲 web 管控（逐跳）：${r.reason}`);
  return r;
}
