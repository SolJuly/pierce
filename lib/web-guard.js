/**
 * web 域名管控的判定核心 —— 从 lib/index.js 抽出来的独立模块。
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
 * 所以判定逻辑必须在 provider 内部再跑一次，而且每次重定向都跑。
 * 顺带也覆盖了「别的插件直接调 provider、绕开工具闸」这种情况。
 *
 * 抽成独立文件是为了避免 index.js ↔ web-fetch.js 循环依赖。
 *
 * @module dsh-pierce/web-guard
 */

/** 白/黑名单匹配规则见 README：example.com / *.example.com / .example.com / *。 */

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

export function hostMatchesPattern(host, pattern) {
  const p = String(pattern ?? "").trim().toLowerCase();
  if (!p) return false;
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  if (p.startsWith(".")) return host.endsWith(p);
  return host === p;
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
  const host = hostOfWebTarget(raw);
  if (!host) {
    return { kind: "deny", reason: `破甲 web 管控：解析不出目标地址（${raw.slice(0, 80)}）` };
  }
  const deny = Array.isArray(g.deny) ? g.deny : [];
  const allow = Array.isArray(g.allow) ? g.allow : [];
  const hit = deny.find((p) => hostMatchesPattern(host, p));
  if (hit) {
    return { kind: "deny", reason: `破甲 web 管控：${host} 命中拒绝名单（${hit}）` };
  }
  if (allow.length && !allow.some((p) => hostMatchesPattern(host, p))) {
    return { kind: "deny", reason: `破甲 web 管控：${host} 不在白名单（允许 ${allow.join(", ")}）` };
  }
  return null;
}

/**
 * 判定重定向链上的某一跳是否允许（provider 内部用）。
 *
 * 与 webVerdict 的区别：这一层不返回 gate，直接抛错 —— provider 的契约是
 * 要么返回结果要么抛，没有"降级放行"这种中间态。
 *
 * ## 没有 host 的情况
 *
 * `file:///etc/passwd` 这类 URL 没有 hostname。此时：
 *   - 配了白名单 → 拒绝（它显然不在白名单里，不能因为"没 host"就放过）
 *   - 没配白名单（只配 deny）→ 放行（deny 是按 host 匹配的，匹配不上）
 *
 * @param url - 当前这一跳的 URL（URL 实例或字符串）
 * @param g - cfg.webGuard
 * @throws 命中拒绝名单 / 不在白名单 / 取不到 host 且配了白名单
 */
export function assertHopAllowed(url, g) {
  if (!g || g.enabled === false) return;
  const host = hostOfWebTarget(String(url));
  const deny = Array.isArray(g.deny) ? g.deny : [];
  const allow = Array.isArray(g.allow) ? g.allow : [];

  if (host === null) {
    if (allow.length) {
      throw new Error(`破甲 web 管控（逐跳）：取不到 host，白名单无法判定 → 拒绝（${String(url).slice(0, 80)}）`);
    }
    return;
  }
  const hit = deny.find((p) => hostMatchesPattern(host, p));
  if (hit) {
    throw new Error(`破甲 web 管控（逐跳）：${host} 命中拒绝名单（${hit}）`);
  }
  if (allow.length && !allow.some((p) => hostMatchesPattern(host, p))) {
    throw new Error(`破甲 web 管控（逐跳）：${host} 不在白名单（允许 ${allow.join(", ")}）`);
  }
}
