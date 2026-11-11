/**
 * 补丁执行器：声明式规则 → 幂等应用 / 回滚 / 状态。
 *
 * 设计取舍（相对 dsh-purge 的改动）：
 * 1. 规则数据与引擎分离：规则在 engine/tables/*.json，引擎不写死任何锚点文本。
 * 2. 四态判定：marker / 原始锚点 / witness（删除型）/ drift，绝不靠往文件里塞注释假装成功。
 * 3. 漂移就报 drift 并落盘（ref/drift.json），不静默跳过 —— 宿主升级后最容易翻车的地方。
 * 4. 备份统一 .pierce.bak，回滚按备份还原；同一个文件只备份一次（第一次改动前）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolvePatch, backupPath, primaryAiBase } from "./paths.mjs";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

export function loadTable(file) {
  return readJson(file);
}

/**
 * 合并多张表。后表覆盖前表同 id 的条目 —— 这就是 overlay 的语义：
 * overlay 是针对当前宿主版本重锚过的锚点，优先级高于上游原表。
 * 不同 id 合并成一整张，apply 一次扫完。
 */
export function mergeTables(...tables) {
  const byId = new Map();
  const layers = [];
  const obsolete = {};
  for (const t of tables) if (t?.obsolete) Object.assign(obsolete, t.obsolete);
  for (const t of tables) {
    if (!t || t.obsolete) continue;
    layers.push({ source: t.source, counts: t.counts });
    for (const p of t.patches ?? []) {
      const prev = byId.get(p.id);
      // overlay 条目带 origin 字段；同 id 时 overlay 赢
      if (prev && !p.origin && prev.origin) continue;
      byId.set(p.id, { ...p, _from: p.origin ?? "base" });
    }
  }
  const patches = [...byId.values()].sort((a, b) => a.id - b.id);
  for (const p of patches) {
    if (obsolete[String(p.id)]) {
      p.obsolete = true;
      p.obsoleteReason = obsolete[String(p.id)];
    }
  }
  return {
    source: { merged: layers },
    counts: {
      patches: patches.length,
      rules: patches.reduce((a, p) => a + (p.rules?.length ?? 0), 0),
      overlaid: patches.filter((p) => p._from !== "base").length,
      fromBase: patches.filter((p) => p._from === "base").length,
    },
    patches,
  };
}

function toRegex(rule) {
  if (rule.kind === "literal") return null;
  return new RegExp(rule.pattern.source, rule.pattern.flags);
}

function countOccurrences(hay, rule) {
  const re = toRegex(rule);
  if (re) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    return [...hay.matchAll(g)].length;
  }
  if (!rule.pattern) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = hay.indexOf(rule.pattern, i);
    if (at === -1) break;
    n++;
    i = at + rule.pattern.length;
  }
  return n;
}

function replaceAll(hay, rule) {
  const re = toRegex(rule);
  if (re) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    return hay.replace(g, rule.replace);
  }
  // 字面量：不用 String.replace（会把 $& $1 当替换模式）
  const out = [];
  let i = 0;
  for (;;) {
    const at = hay.indexOf(rule.pattern, i);
    if (at === -1) {
      out.push(hay.slice(i));
      break;
    }
    out.push(hay.slice(i, at), rule.replace);
    i = at + rule.pattern.length;
  }
  return out.join("");
}

/** 单条补丁在单个文件上的判定。 */
export function judgeFile(text, patch) {
  const markers = patch.markers ?? [];
  if (markers.length && markers.every((m) => text.includes(m))) return "already";
  const rules = patch.rules ?? [];
  if (!rules.length) return markers.length ? "drift" : "no-rule";
  const hits = rules.map((r) => countOccurrences(text, r));
  const hitCount = hits.filter((n) => n > 0).length;
  if (hitCount === rules.length) return "pending";
  // 原始锚点全不在，但落点已经写着替换稿 → 上游/别人已经打过，算完成。
  const witnessed = rules.filter((r) => typeof r.replace === "string" && r.replace.length >= 12 && text.includes(r.replace)).length;
  if (hitCount === 0 && witnessed === rules.length) return "already";
  if (hitCount === 0 && witnessed > 0) return "already"; // 部分落点已写稿，其余是结构性缺席
  if (hitCount > 0) return "partial";
  return "drift";
}

/**
 * 应用到不动点：一趟规则可能给下一趟造出锚点（上游 #26 就是这种链式规则），
 * 单趟打会漏，第二趟又会再改一次 —— 那就不幂等了。这里循环到没有规则命中为止。
 */
export function applyPatchToText(text, patch, maxPass = 6) {
  let out = text;
  let applied = 0;
  for (let pass = 0; pass < maxPass; pass++) {
    let hitThisPass = 0;
    for (const r of patch.rules ?? []) {
      if (countOccurrences(out, r) > 0) {
        out = replaceAll(out, r);
        hitThisPass++;
      }
    }
    applied += hitThisPass;
    if (hitThisPass === 0) break;
  }
  return { text: out, applied, changed: out !== text };
}

export function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * 多文件聚合。
 *
 * 一条补丁常常挂多个文件（如 #4 同时挂 agent-preset / web-app / headless 等多个预设），
 * 而它的锚点只在其中一两个文件里出现。那些「本来就没有这条锚点」的文件
 * 不是失败，是*这条规则与该文件无关* —— 拿它去拉低整条补丁的状态是错的。
 *
 * 判定顺序：
 *   1. 只要有文件是 pending/partial → 还有活没干
 *   2. 否则只要有文件是 already → 这条补丁已经生效（其余 drift 视为与本文件无关）
 *   3. 全 drift / 全 missing → 真失败
 */
function aggregate(per) {
  const vs = per.map((p) => p.verdict);
  if (vs.includes("pending")) return "pending";
  if (vs.includes("partial")) return "partial";
  if (vs.includes("already")) return "already";
  if (vs.every((v) => v === "missing")) return "missing";
  if (vs.includes("no-rule")) return "no-rule";
  return "drift";
}

/** 一次完整判定：按宿主、按补丁、按文件。 */
export function status(aiBase = primaryAiBase(), table) {
  const rows = [];
  for (const patch of table.patches) {
    if (patch.obsolete) {
      rows.push({ id: patch.id, name: patch.name, status: "obsolete", reason: patch.obsoleteReason, files: [] });
      continue;
    }
    const { files, missing } = resolvePatch(aiBase, patch);
    if (!files.length) {
      rows.push({ id: patch.id, name: patch.name, status: missing.length ? "na" : "missing", missing, files: [] });
      continue;
    }
    const per = files.map((f) => {
      const text = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      return { file: f, verdict: judgeFile(text, patch) };
    });
    rows.push({ id: patch.id, name: patch.name, status: aggregate(per), files: per, missing });
  }
  const summary = {};
  for (const r of rows) summary[r.status] = (summary[r.status] || 0) + 1;
  return { aiBase, rows, summary };
}

/**
 * 应用：可选写盘；dryRun 只算不写。
 *
 * 整表跑到不动点：补丁之间有依赖（#43 改写的行正好是 #26 的锚点），
 * 单趟按序号扫会漏，第二趟才补上 —— 那就是「第二趟又改文件」，不幂等。
 * 这里每趟重扫全表，直到某一趟没有任何文件被写，才收工。
 */
export function apply(aiBase = primaryAiBase(), table, options = {}) {
  const { dryRun = false, only = null, backup = true, maxPass = 6 } = options;
  const backups = [];
  const touched = new Set();
  const perPatch = new Map(); // id → { status, details[] }
  let lastPassWrote = 0;

  for (let pass = 0; pass < maxPass; pass++) {
    lastPassWrote = 0;
    for (const patch of table.patches) {
      if (only && !only.includes(patch.id)) continue;
      if (patch.obsolete) {
        perPatch.set(patch.id, { id: patch.id, name: patch.name, status: "obsolete", reason: patch.obsoleteReason, details: [] });
        continue;
      }
      const { files, missing } = resolvePatch(aiBase, patch);
      const prev = perPatch.get(patch.id) ?? { id: patch.id, name: patch.name, status: "na", details: [], missing };
      if (!files.length) {
        perPatch.set(patch.id, { ...prev, status: "na", missing });
        continue;
      }
      let wroteThisPatch = 0;
      let unfinished = 0; // 只有「与本文件相关但打不上」才算未完成
      for (const file of files) {
        const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
        if (before === null) {
          prev.details.push({ file, verdict: "missing" });
          unfinished++;
          continue;
        }
        const verdict = judgeFile(before, patch);
        if (verdict === "already") continue;
        if (verdict === "no-rule") {
          // 这条补丁在这个文件上没有规则可打 —— 与该文件无关，不计入未完成
          continue;
        }
        if (verdict === "drift") {
          // 有多文件补丁的常见形态：锚点只在其中一部分文件里。
          // 只有当整条补丁在所有文件上都 drift 时，才是真失败（由下游 aggregate 判定）。
          prev.details.push({ file, verdict });
          continue;
        }
        const { text: after, applied, changed } = applyPatchToText(before, patch);
        if (!changed || applied === 0) {
          unfinished++;
          continue;
        }
        if (!dryRun) {
          if (backup && !touched.has(file)) {
            const bak = backupPath(file);
            if (!fs.existsSync(bak)) fs.writeFileSync(bak, before);
            backups.push({ file, bak, from: sha(before) });
            touched.add(file);
          }
          fs.writeFileSync(file, after);
        }
        wroteThisPatch++;
        lastPassWrote++;
        prev.details.push({ file, verdict: verdict === "partial" ? "completed-partial" : "applied", rules: applied });
      }
      // wroteEver：任何一趟写过就算 applied；收敛时仍有未完成落点才算 skipped。
      const wroteEver = (prev.wroteEver === true) || wroteThisPatch > 0;
      const status = wroteEver ? "applied" : unfinished > 0 ? "skipped" : "already";
      perPatch.set(patch.id, { ...prev, status, wroteEver });
    }
    if (lastPassWrote === 0) break;
  }

  const report = [...perPatch.values()].sort((a, b) => a.id - b.id);
  const summary = {};
  for (const r of report) summary[r.status] = (summary[r.status] || 0) + 1;
  return { aiBase, dryRun, report, backups, summary, passes: lastPassWrote === 0 ? "converged" : "max-pass" };
}

/** 回滚：按 .pierce.bak 还原；可选只回滚某几条（按文件粒度，因为备份是文件级）。 */
export function revert(aiBase = primaryAiBase(), table, options = {}) {
  const { dryRun = false, only = null } = options;
  const files = new Set();
  for (const patch of table.patches) {
    if (only && !only.includes(patch.id)) continue;
    for (const f of resolvePatch(aiBase, patch).files) files.add(f);
  }
  const done = [];
  const skipped = [];
  for (const file of files) {
    const bak = backupPath(file);
    if (!fs.existsSync(bak)) {
      skipped.push({ file, reason: "no-backup" });
      continue;
    }
    if (!dryRun) fs.copyFileSync(bak, file);
    done.push({ file, from: sha(fs.readFileSync(bak, "utf8")) });
  }
  return { aiBase, dryRun, restored: done, skipped };
}

export function writeDriftReport(out, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
}
