/**
 * pierce 自己的 web fetch provider —— 清单第 4 项的「做法 A」。
 *
 * ## 为什么要单独写一个
 *
 * 先澄清一个事实，免得照着错误前提做：**官方 provider 本来就能抓内网。**
 * 实测 `dsh-web-fetch-http` 的 `validateFetchUrl` 只限制三件事——
 * URL 长度 ≤2048、只许 http/https、不许内嵌凭据。全树没有私有地址检查、
 * 没有 `setGlobalDispatcher`、没有回环拦截。直接拿 Node 的 fetch 打
 * `127.0.0.1:3080` 是通的（返回 401，那是 GUI 的鉴权）。
 *
 * 所以官方真正拦的是这四样，这才是本模块要放开的：
 *
 *   1. **协议**：只许 http/https。gopher:// 是 SSRF 打 Redis 的标准路子，
 *      file:// 是读本地文件的路子，都被 `parseFetchUrl` 挡掉。
 *   2. **URL 里的凭据**：`http://user:pass@host/` 被判 WEB_BLOCKED_URL。
 *   3. **跨域重定向**：`isSameOrigin` 一比对就拒，要求「对目标 URL 再发一次
 *      工具调用」。自动化场景里这条很碍事。
 *   4. **content-type 白名单**：`classifyContentType` 只认 html/text 几种，
 *      其余直接 WEB_UNSUPPORTED_CONTENT_TYPE。抓二进制头、抓 5xx 的错误页
 *      正文时会被拒。
 *
 * ## 边界在哪
 *
 * 这个 provider 交给操作者控制，不是无限制的：`webGuard` 那层白/黑名单
 * （lib/index.js 的 tools/pre-execute 钩子）拦在工具入口，对这个 provider
 * 同样生效 —— 因为它在工具调用之前，跟 provider 是谁无关。
 *
 * 另外 provider 默认不启用：只有 profile 里把 `fetchProvider` 指到 `pierce`
 * 才会用到它。默认仍走官方的 `http`。
 *
 * @module dsh-pierce/web-fetch
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { assertHopAllowed } from "./web-guard.js";

/** 注册用的稳定 id。profile 里 `fetchProvider: pierce` 指的就是它。 */
export const PIERCE_FETCH_PROVIDER_ID = "pierce";

const DEFAULTS = {
  timeoutMs: 30000,
  maxRedirects: 5,
  maxBodyChars: 200000,
  maxBodyBytes: 4 * 1024 * 1024,
  maxFileBytes: 4 * 1024 * 1024,
  userAgent: "dsh-pierce/1 (+web-fetch)",
};

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** 按字符截断，并报告是否截断了。 */
function capChars(text, max) {
  if (text.length <= max) return { content: text, truncated: false };
  return { content: text.slice(0, max), truncated: true };
}

/** 极简 content-type 分类：只要能区分 html 和 text 就够工具层排版用。 */
function classify(contentType) {
  const ct = String(contentType ?? "").toLowerCase();
  if (ct.includes("html")) return "html";
  return "text";
}

/** 把 fetch 的异常翻成可读信息，别把 undici 的内部错误直接抛给模型。 */
function describeNetworkError(error, url) {
  const cause = error?.cause;
  const code = cause?.code ?? error?.code;
  const detail = code ?? String(cause?.message ?? error?.message ?? error);
  return new Error(`fetch ${url} 失败：${detail}`);
}

/**
 * 带超时与外部取消的信号合成。返回 { signal, done }，done 必须调用。
 */
function composeSignal(external, timeoutMs) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort(new Error("aborted"));
  if (external) {
    if (external.aborted) ctl.abort(new Error("aborted"));
    else external.addEventListener?.("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  timer.unref?.();
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      external?.removeEventListener?.("abort", onAbort);
    },
  };
}

/** file:// —— 读本地文件。大小上限用 stat 预判，免得把整块内存吃掉。 */
async function fetchFile(url, limits, realPath) {
  // realPath 由 checkFileRoot 给出（已 realpath、已验证在根内）。
  // 拿不到才退回解析 url.pathname。
  const filePath = realPath ?? decodeURIComponent(url.pathname);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw new Error(`读不到本地文件 ${filePath}：${error.code ?? error.message}`);
  }
  if (!stat.isFile()) throw new Error(`${filePath} 不是普通文件`);
  if (stat.size > limits.maxFileBytes) {
    const buf = Buffer.alloc(limits.maxFileBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buf, 0, limits.maxFileBytes, 0);
    } finally {
      fs.closeSync(fd);
    }
    const { content } = capChars(buf.toString("utf8"), limits.maxBodyChars);
    return { url: url.toString(), statusCode: 200, body: { kind: "text", content }, truncated: true };
  }
  const { content, truncated } = capChars(fs.readFileSync(filePath, "utf8"), limits.maxBodyChars);
  return { url: url.toString(), statusCode: 200, body: { kind: "text", content }, truncated };
}

/**
 * gopher:// —— 「发一段过去，收回来」。RFC 1436 的 selector 规则：
 * `gopher://host:port/<itemtype><selector>`，itemtype 是第一个字符，
 * selector 逐段百分号解码后以 CRLF 结尾发出去。
 *
 * 这一条之所以要支持：gopher 是打 Redis / MySQL / FastCGI 这类内网服务的
 * 标准 SSRF 通道，官方 provider 直接按协议拒掉。
 */
function fetchGopher(url, limits, signal) {
  const host = url.hostname;
  const port = Number(url.port || 70);
  // gopher 的 selector 在 pathname 里，去掉开头的 "/"，再按 "/" 分段解码
  const segments = url.pathname.replace(/^\/+/, "").split("/").map((s) => decodeURIComponent(s));
  const itemType = segments[0]?.[0] ?? "";
  const rest = segments[0] ? segments[0].slice(1) : "";
  const selector = [rest, ...segments.slice(1)].filter((s, i) => i > 0 || s !== "").join("\t");
  const payload = `${selector}\r\n`;

  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const socket = net.connect({ host, port });
    const onAbort = () => {
      socket.destroy();
      finish(reject, new Error(`gopher ${host}:${port} 被取消`));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    socket.setTimeout(limits.timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      finish(reject, new Error(`gopher ${host}:${port} 超时`));
    });
    socket.on("error", (error) => finish(reject, new Error(`gopher ${host}:${port} 失败：${error.code ?? error.message}`)));
    socket.on("data", (buf) => {
      total += buf.length;
      chunks.push(buf);
      if (total >= limits.maxBodyBytes) socket.destroy();
    });
    socket.on("close", () => {
      signal?.removeEventListener?.("abort", onAbort);
      const raw = Buffer.concat(chunks);
      const { content, truncated } = capChars(raw.toString("utf8"), limits.maxBodyChars);
      finish(resolve, {
        url: url.toString(),
        statusCode: 0,
        body: { kind: "text", content },
        truncated: truncated || total >= limits.maxBodyBytes || raw.length > limits.maxBodyBytes,
      });
    });
    socket.on("connect", () => socket.write(payload));
    if (itemType) void itemType; // 保留变量名，说明我们读到了 item type
  });
}

/** http/https —— 跟随重定向，**不要求同源**（官方 provider 会拒跨域）。 */
async function fetchHttp(url, limits, signal, checkHop) {
  let current = url;
  let hops = 0;
  for (;;) {
    let response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": limits.userAgent, accept: "*/*" },
        signal,
      });
    } catch (error) {
      throw describeNetworkError(error, current.toString());
    }
    if (REDIRECT_STATUS.has(response.status)) {
      const location = response.headers.get("location");
      if (location === null) {
        await response.body?.cancel();
        throw new Error(`重定向 ${response.status} 但没有 Location 头`);
      }
      if (hops >= limits.maxRedirects) {
        await response.body?.cancel();
        throw new Error(`重定向超过 ${limits.maxRedirects} 次`);
      }
      await response.body?.cancel();
      current = new URL(location, current);
      // ★ 关键一行：重定向目标也要过护栏，否则 allow: [a.com] 可以被
      // a.com 302 到任意地址绕过。官方 http provider 靠「拒跨域重定向」
      // 规避了这个问题，本 provider 跟随重定向就必须自己校验每一跳。
      await checkHop(current);
      hops += 1;
      continue;
    }
    const contentType = response.headers.get("content-type");
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw describeNetworkError(error, current.toString());
    }
    const { content, truncated } = capChars(text, limits.maxBodyChars);
    return {
      url: current.toString(),
      statusCode: response.status,
      body: { kind: classify(contentType), content },
      truncated,
    };
  }
}

/**
 * pierce 的 fetch provider。接口对齐官方 `HttpFetchProvider`：
 * `id` / `available()` / `fetch(request, signal)`。
 */
export class PierceFetchProvider {
  id = PIERCE_FETCH_PROVIDER_ID;
  /**
   * @param config - 覆盖 DEFAULTS 的一部分；`guard` 是 cfg.webGuard 的引用
   *
   * guard 在这里也要跑一遍（而且每一跳都跑），因为工具入口那道闸只能看到
   * 初始 URL。官方 http provider 拒跨域重定向所以看不出问题，但本 provider
   * 会跟随 —— 只看初始地址等于白名单可被 302 绕过。
   */
  constructor(config = {}) {
    const { guard, ...limits } = config;
    this.limits = { ...DEFAULTS, ...limits };
    this.guard = guard ?? null;
  }

  /**
   * 重定向链的每一跳都在这里过一遍护栏。
   * 异步：除了字面匹配，还要把域名解析成 IP 再比 deny（防 localhost / nip.io 之类）。
   * @returns 判定结果（file:// 时会带 realPath，供 fetchFile 用真实路径读）
   */
  async checkHop(url) {
    return await assertHopAllowed(url, this.guard);
  }

  /** 匿名抓取器，恒可用。 */
  available() {
    return true;
  }

  /**
   * @param request - 至少含 `url`
   * @param signal - 可选的取消信号
   * @returns {{url:string,statusCode:number,body:{kind:"html"|"text",content:string},truncated:boolean}}
   */
  async fetch(request, signal) {
    const raw = String(request?.url ?? "");
    let url;
    try {
      url = new URL(raw);
    } catch (error) {
      throw new Error(`无效 URL：${raw}`, { cause: error });
    }
    const { signal: merged, done } = composeSignal(signal, this.limits.timeoutMs);
    try {
      if (merged.aborted) throw new Error("抓取已取消");
      // 入口先校验一次：覆盖「别的插件直接调 provider、绕开工具闸」的情况
      const entry = await this.checkHop(url);
      switch (url.protocol) {
        case "file:":
          // 用护栏算出来的真实路径去读，而不是重新打开原路径 ——
          // 否则「检查用 realpath、读取用原路径」之间留一个符号链接替换窗口。
          return await fetchFile(url, this.limits, entry?.realPath);
        case "gopher:":
          return await fetchGopher(url, this.limits, merged);
        case "http:":
        case "https:":
          return await fetchHttp(url, this.limits, merged, (u) => this.checkHop(u));
        default:
          throw new Error(
            `pierce provider 不支持协议 "${url.protocol}"（支持 http/https/file/gopher）`,
          );
      }
    } finally {
      done();
    }
  }
}

/**
 * 从 profile 的 pierce 配置里拼出 provider 参数。
 *
 * 注意 `guard`：把 cfg.webGuard **整个引用**传进去，不是快照。
 * 这样 /pierce webguard off 之后，provider 的逐跳校验也会立刻失效，
 * 不用重启 —— 和工具闸那层的行为保持一致。
 */
export function providerConfigFrom(cfg) {
  const c = cfg?.webFetchProvider ?? {};
  return {
    guard: cfg?.webGuard ?? null,
    timeoutMs: Number(c.timeoutMs ?? DEFAULTS.timeoutMs),
    maxRedirects: Number(c.maxRedirects ?? DEFAULTS.maxRedirects),
    maxBodyChars: Number(c.maxBodyChars ?? DEFAULTS.maxBodyChars),
    maxBodyBytes: Number(c.maxBodyBytes ?? DEFAULTS.maxBodyBytes),
    maxFileBytes: Number(c.maxFileBytes ?? DEFAULTS.maxFileBytes),
    ...(c.userAgent ? { userAgent: String(c.userAgent) } : {}),
  };
}

/** 显式引用一次，避免 path 被 lint 当成未使用（保留给将来规范化本地路径）。 */
void path;