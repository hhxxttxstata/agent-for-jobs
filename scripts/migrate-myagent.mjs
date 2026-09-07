#!/usr/bin/env node
/**
 * migrate-myagent.mjs —— 一次性迁移：把个人知识 Agent（D:\MyAgent）的历史数据
 * 接入本求职 Agent 工作区。两条轨道：
 *
 *   1) 原始归档  → data/history/myagent/
 *      traces/*.json + session_logs/*.jsonl 原样复制；MYWORLD 求职相关笔记按相对结构复制；
 *      memory.db 中求职相关记忆导出为 memory-extract.md；生成溯源 README.md。
 *
 *   2) pi 可回放会话 → ~/.pi/agent/sessions/--D--agent-for-jobs--/
 *      traces 按天、session_logs 按文件各合成一个 pi v3 JSONL 会话（user_intent→user、
 *      final_output/summary→assistant），时间戳沿用原始数据；真实手机号/邮箱与测试号统一脱敏。
 *      注意：这些会话仅可 --resume 回放/--export 导出，不会自动进入新会话上下文。
 *
 *   3) 质量标注 → data/telemetry/ratings.jsonl
 *      MyAgent eval 体系里带 known_issue 的 candidate case（badcase）→ score 1；
 *      golden/dataset.json + golden/regression.json 的用例 → score 5。
 *      字段补齐为 {time, score, note}，note 以【MyAgent …迁移】开头（架构不同，仅作历史
 *      信号供 evolve 参考）；迁移条目按原 created_at 插入文件头，保持整个文件时间有序。
 *
 * 用法：
 *   node scripts/migrate-myagent.mjs [--dry-run] [--skip-archive] [--skip-sessions] [--skip-ratings]
 *   node scripts/migrate-myagent.mjs --rollback        # 回退到未迁移状态（删归档+生成会话，剔除迁移评分行）
 *
 * 幂等性：会话文件名与 UUID 由来源键确定性派生（sha1），重跑覆盖同名文件不产生重复；
 *         ratings 迁移行按【MyAgent 标记先剔后插，重跑不重复。
 * 回滚：--rollback，或手动删 data/history/myagent/、生成的 ~/.pi/agent/sessions/--D--agent-for-jobs--/<新 jsonl>
 *       并剔除 ratings.jsonl 中含【MyAgent 的行。
 * 只读源：本脚本绝不写 D:\MyAgent 与 D:\MYWORLD 的任何文件。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = (() => {
  let dir = SCRIPT_DIR;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("找不到项目根（未发现 package.json）");
})();

const SRC_MYAGENT = "D:/MyAgent";
const SRC_VAULT = "D:/MYWORLD";
const SRC_TRACES = path.join(SRC_MYAGENT, "agent_data", "traces");
const SRC_SESSION_LOGS = path.join(SRC_MYAGENT, "agent_data", "session_logs");
const SRC_MEMORY_DB = path.join(SRC_MYAGENT, "agent_data", "memory.db");
const ARCHIVE = path.join(ROOT, "data", "history", "myagent");
const SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions", "--D--agent-for-jobs--");

// MYWOLD 求职相关笔记（相对 D:/MYWORLD；目录则整体复制）
const VAULT_SELECTIONS = [
  "notes/秋招准备",
  "notes/项目笔记/RAG项目简历描述.md",
  "notes/项目笔记/agent项目简历描述.md",
  "notes/项目笔记/对齐岗位JD.md",
  "notes/项目笔记/项目细节搞懂.md",
  "notes/技术沉淀/RAG系统技术问答.md",
  "简历.md",
];

const JOB_KEYWORDS = ["秋招", "简历", "面试", "求职", "投递", "JD", "offer"];
// 脱敏映射（真实手机号/邮箱）只保存在本地 scripts/redact-map.local.json（.gitignore 已排除），
// 仓库内提供 redact-map.example.json 占位模板；缺失时仍有下方 scrub() 的通用正则兜底。
const PII_LITERALS = (() => {
  const mapPath = path.join(SCRIPT_DIR, "redact-map.local.json");
  return fs.existsSync(mapPath) ? JSON.parse(fs.readFileSync(mapPath, "utf8")) : [];
})();

// ---------------------------------------------------------------- 工具 ----

function parseArgs(argv) {
  const opts = { dryRun: false, skipArchive: false, skipSessions: false, skipRatings: false, rollback: false };
  for (const a of argv) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--skip-archive") opts.skipArchive = true;
    else if (a === "--skip-sessions") opts.skipSessions = true;
    else if (a === "--skip-ratings") opts.skipRatings = true;
    else if (a === "--rollback") opts.rollback = true;
    else { console.error(`未知参数 ${a}`); process.exit(1); }
  }
  return opts;
}

function uuidFrom(key) {
  const h = crypto.createHash("sha1").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function entryId(key) {
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 8);
}

// "2026-09-03T01:16:03.464639"（可无 Z、微秒精度）→ pi 用的毫秒精度 UTC ISO
function normIso(ts) {
  if (!ts) return null;
  const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 23) + "Z";
}

function piFilename(iso, uuid) {
  return iso.replace(/:/g, "-").replace(/\./g, "-") + "_" + uuid + ".jsonl";
}

let scrubHits = 0;
function scrub(text) {
  let s = String(text ?? "");
  for (const [lit, ph] of PII_LITERALS) {
    if (s.includes(lit)) { scrubHits += s.split(lit).length - 1; s = s.split(lit).join(ph); }
  }
  s = s.replace(/1[3-9]\d{9}/g, (m) => { scrubHits++; return "【手机号】"; });
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => { scrubHits++; return "【邮箱】"; });
  return s;
}

function copyFileTo(src, dest, plan) {
  plan.copies.push({ src, dest });
}

function collectCopyPlan(srcPath, relDest, plan) {
  const st = fs.statSync(srcPath);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(srcPath)) collectCopyPlan(path.join(srcPath, e), relDest + "/" + e, plan);
  } else {
    copyFileTo(srcPath, path.join(ARCHIVE, "vault-notes", relDest), plan);
  }
}

function execCopies(plan, dryRun) {
  for (const { src, dest } of plan.copies) {
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// ------------------------------------------------------------- 归档 ----

async function buildArchivePlan() {
  const plan = { copies: [], memoryRows: 0, traceCount: 0, logCount: 0, span: null };
  for (const dir of [SRC_TRACES, SRC_SESSION_LOGS]) {
    if (!fs.existsSync(dir)) throw new Error(`源目录不存在：${dir}`);
  }
  // 1) traces + session_logs 原样
  for (const e of fs.readdirSync(SRC_TRACES)) {
    if (e.endsWith(".json")) { copyFileTo(path.join(SRC_TRACES, e), path.join(ARCHIVE, "traces", e), plan); plan.traceCount++; }
  }
  for (const e of fs.readdirSync(SRC_SESSION_LOGS)) {
    if (e.endsWith(".jsonl")) { copyFileTo(path.join(SRC_SESSION_LOGS, e), path.join(ARCHIVE, "session_logs", e), plan); plan.logCount++; }
  }
  // 2) vault 求职笔记
  for (const rel of VAULT_SELECTIONS) {
    const src = path.join(SRC_VAULT, ...rel.split("/"));
    if (!fs.existsSync(src)) { console.warn(`警告：vault 缺少 ${rel}，跳过`); continue; }
    collectCopyPlan(src, rel.split("/").join("/"), plan);
  }
  // 3) memory.db 求职相关记忆（episodic/task/stable_profile/conversation，跳过 2.5 万条计划快照）
  if (fs.existsSync(SRC_MEMORY_DB)) {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { throw new Error("当前 Node 不支持 node:sqlite，无法导出 memory-extract.md"); }
    const db = new DatabaseSync(SRC_MEMORY_DB, { readOnly: true });
    const like = JOB_KEYWORDS.map(() => "content LIKE ?").join(" OR ");
    const params = JOB_KEYWORDS.map((k) => `%${k}%`);
    plan.memoryRows = db.prepare(
      `SELECT memory_type, content, created_at, importance FROM memories
       WHERE (memory_type IN ('episodic','task','conversation') OR memory_type = 'stable_profile')
         AND (deprecated = 0 OR deprecated IS NULL) AND (${like})
       ORDER BY created_at`
    ).all(...params);
    plan.memoryRows = plan.memoryRows.map((r) => ({ ...r }));
    db.close();
  } else {
    console.warn("警告：memory.db 不存在，跳过记忆导出");
  }
  return plan;
}

function memoryExtractMarkdown(rows) {
  const lines = [
    "# MyAgent 记忆库导出（求职相关）",
    "",
    `> 来源：${SRC_MEMORY_DB}（memories 表）。只导出 episodic/task/conversation/stable_profile 四类中含求职关键词的未废弃条目；`,
    "> task_plan/task_todos（每日计划快照，共 2.5 万+ 条，大量重复）未导出。条目按创建时间排序，换行以 ⏎ 表示。",
    "",
  ];
  let cur = null;
  for (const r of rows) {
    if (r.memory_type !== cur) { cur = r.memory_type; lines.push(`## ${cur}`, ""); }
    const oneLine = String(r.content ?? "").replace(/\r?\n\s*/g, " ⏎ ");
    lines.push(`- [${r.created_at ?? "未知时间"}] (重要度 ${r.importance ?? "?"}) ${oneLine}`);
  }
  lines.push("");
  return lines.join("\n");
}

function archiveReadme(plan, date, ratingsEntries = []) {
  const golden = ratingsEntries.filter((e) => e.score === 5).length;
  const bad = ratingsEntries.filter((e) => e.score === 1).length;
  return `# MyAgent 历史数据归档

> 迁移日期：${date}。来源：个人知识 Agent（"第二大脑"，LangGraph + Obsidian vault）。
> 本目录是**只读源材料库**：保留原始 trace 与求职知识笔记供溯源与后续蒸馏，agent 工作流不直接读写此目录；
> 评测快照只覆盖 data/ 下 jds/resumes/reviews/memory/telemetry，不会动本目录。

## 来源与去向

| 归档内容 | 来源 | 说明 |
|---|---|---|
| traces/（${plan.traceCount} 个 JSON） | D:/MyAgent/agent_data/traces/ | 单轮执行 trace：意图、上下文来源、工具调用、token、最终输出（2026-08-31 ~ 2026-09-06） |
| session_logs/（${plan.logCount} 个 JSONL） | D:/MyAgent/agent_data/session_logs/ | 会话摘要：goal/completed/summary/evidence_refs（2026-08-02 ~ 2026-08-28） |
| vault-notes/ | D:/MYWORLD/ | 求职相关笔记：notes/秋招准备/ 全部、项目笔记中简历/JD/面试准备相关、技术沉淀/RAG系统技术问答、简历.md |
| memory-extract.md | D:/MyAgent/agent_data/memory.db | 求职相关记忆 ${plan.memoryRows.length} 条（episodic/task/conversation/stable_profile），未导出 task_plan/task_todos 快照 |
| generated-sessions.manifest.txt | 本脚本生成 | 转换出的 pi 会话文件名清单，供 --rollback 精确回退 |

## vault-notes 清单

${plan.vaultList.map((f) => `- ${f}`).join("\n")}

## 相关

- 同日已把这些 trace/session 转成 pi 可回放会话（脱敏后）放进 ~/.pi/agent/sessions/--D--agent-for-jobs--/，可用 pi --resume 回放。
- MyAgent eval 体系中的 golden（${golden} 用例）与 badcase（${bad} 条）已按 5 分/1 分迁入 data/telemetry/ratings.jsonl（note 带【MyAgent 迁移】标记），作为 evolve 的历史质量信号。
- 生成脚本：scripts/migrate-myagent.mjs（重跑覆盖本目录同名文件；--rollback 回退全部三项迁移）。
`;
}

// --------------------------------------------------------- 会话转换 ----

function collectUnits() {
  const units = []; // {sourceKey, sourceLabel, date, items:[{ts, user, assistant}]}
  // traces 按天分组；chatbot/plan/带对话的 memory trace 取 intent→output，
  // reflect 取 subject→summary；纯记忆操作与 daily_plan 快照无对话内容，归档里已有、不进回放
  const byDay = new Map();
  let skipped = 0;
  let nonDialog = 0;
  for (const e of fs.readdirSync(SRC_TRACES)) {
    if (!e.endsWith(".json")) continue;
    let t;
    try { t = JSON.parse(fs.readFileSync(path.join(SRC_TRACES, e), "utf8")); } catch { skipped++; continue; }
    const iso = normIso(t.timestamp);
    if (!iso) { skipped++; continue; }
    let item = null;
    if (t.user_intent || t.final_output) {
      item = {
        ts: iso,
        user: t.user_intent || "（该 trace 无用户意图字段）",
        assistant: t.final_output || `（该轮执行失败：${t.error || "未知错误"}）`,
      };
    } else if (t.task_type === "reflect" && (t.subject || t.summary)) {
      item = { ts: iso, user: t.subject || "自我反思", assistant: t.summary || "" };
    } else {
      nonDialog++;
      continue;
    }
    const date = iso.slice(0, 10);
    if (!byDay.has(date)) byDay.set(date, []);
    byDay.get(date).push(item);
  }
  for (const [date, items] of byDay) {
    items.sort((a, b) => a.ts.localeCompare(b.ts));
    units.push({ sourceKey: `myagent-traces-${date}`, sourceLabel: `MyAgent traces ${date}`, date, items });
  }
  // session_logs 每个文件一个会话
  for (const e of fs.readdirSync(SRC_SESSION_LOGS).sort()) {
    if (!e.endsWith(".jsonl")) continue;
    const items = [];
    for (const line of fs.readFileSync(path.join(SRC_SESSION_LOGS, e), "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const iso = normIso(o.timestamp);
      if (!iso || (!o.goal && !o.summary)) continue;
      items.push({ ts: iso, user: o.goal, assistant: o.summary });
    }
    if (items.length) {
      items.sort((a, b) => a.ts.localeCompare(b.ts));
      const date = e.replace(/\.jsonl$/, "");
      units.push({ sourceKey: `myagent-session-${date}`, sourceLabel: `MyAgent 会话日志 ${date}`, date, items });
    }
  }
  units.sort((a, b) => a.items[0].ts.localeCompare(b.items[0].ts));
  return { units, skipped, nonDialog };
}

function sessionJsonl(unit) {
  const uuid = uuidFrom(unit.sourceKey);
  const firstIso = unit.items[0].ts;
  const header = { type: "session", version: 3, id: uuid, timestamp: firstIso, cwd: "D:\\agent-for-jobs" };
  const entries = [header];
  let prev = null;
  unit.items.forEach((it, i) => {
    const prefix = i === 0 ? `【迁移自 ${unit.sourceLabel} · 原时间 ${firstIso}】\n\n` : "";
    const userId = entryId(unit.sourceKey + ":u" + i);
    entries.push({
      type: "message", id: userId, parentId: prev, timestamp: it.ts,
      message: { role: "user", content: [{ type: "text", text: scrub(prefix + it.user) }] },
    });
    prev = userId;
    const assistantId = entryId(unit.sourceKey + ":a" + i);
    entries.push({
      type: "message", id: assistantId, parentId: prev, timestamp: it.ts,
      message: {
        role: "assistant", content: [{ type: "text", text: scrub(it.assistant) }],
        api: "openai-completions", provider: "deepseek", model: "deepseek-chat",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cacheWrite1h: 0 },
        stopReason: "stop", timestamp: Date.parse(it.ts), responseId: `migrated_${unit.sourceKey}_${i}`, rawStopReason: "stop",
      },
    });
    prev = assistantId;
  });
  return { filename: piFilename(firstIso, uuid), body: entries.map((e) => JSON.stringify(e)).join("\n") + "\n", rounds: unit.items.length };
}

// --------------------------------------------------------- 质量标注 ----

const RATINGS_PATH = path.join(ROOT, "data", "telemetry", "ratings.jsonl");
const RATINGS_MARKER = "【MyAgent";

// golden 用例 → 5 分；带 known_issue 的 candidate（badcase）→ 1 分。
// note 只在结果层面描述问题（两边架构与动作空间不同，不迁移机制细节）。
function buildRatingsEntries() {
  const evalDir = path.join(SRC_MYAGENT, "agent_data", "eval");
  const entries = [];
  const readCases = (p) => {
    const o = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(o) ? o : [o];
  };
  const clip = (s, n = 90) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

  for (const f of ["golden/dataset.json", "golden/regression.json"]) {
    const p = path.join(evalDir, ...f.split("/"));
    if (!fs.existsSync(p)) continue;
    for (const c of readCases(p)) {
      if (!c.input && !c.intent) continue;
      entries.push({
        time: `${c.created_at ?? "2026-07-26"}T00:00:00.000Z`,
        score: 5,
        note: `【MyAgent golden 迁移】${c.id ?? ""}：${clip(c.intent)}——"${clip(c.input)}"（MyAgent 回归用例，历史质量基线）`,
      });
    }
  }

  const candDir = path.join(evalDir, "candidate");
  if (fs.existsSync(candDir)) {
    for (const f of fs.readdirSync(candDir).sort()) {
      if (!f.endsWith(".json")) continue;
      let cases;
      try { cases = readCases(path.join(candDir, f)); } catch { console.warn(`警告：candidate/${f} 解析失败，跳过`); continue; }
      for (const c of cases) {
        // badcase 判定：带 known_issue，或文件名即 bad case（如 bad case.json 里的条目没有 known_issue 字段）
        const looksBad = c.known_issue || /bad/i.test(f);
        if (!looksBad) continue; // 中性候选用例不是 badcase
        const issue = c.known_issue
          ? clip(c.known_issue, 140)
          : "应有行为：" + clip((c.required_outcomes ?? []).join("；"), 120);
        entries.push({
          time: `${c.created_at ?? "2026-07-27"}T00:00:00.000Z`,
          score: 1,
          note: `【MyAgent badcase 迁移】${c.id ?? f}：${clip(c.intent)}——"${clip(c.input)}"；问题：${issue}（MyAgent 架构下的失败，仅作历史信号）`,
        });
      }
    }
  }
  entries.sort((a, b) => a.time.localeCompare(b.time));
  return entries;
}

// 迁移条目按原时间插入文件头（都早于本 agent 真实评分），保持整个文件时间有序；
// 先剔除已有迁移行再插入，保证重跑幂等。
function applyRatings(entries, dryRun) {
  const existing = fs.existsSync(RATINGS_PATH)
    ? fs.readFileSync(RATINGS_PATH, "utf8").split(/\r?\n/).filter((l) => l.trim())
    : [];
  const kept = existing.filter((l) => !l.includes(RATINGS_MARKER));
  const migrated = entries.map((e) => JSON.stringify(e));
  if (!dryRun) fs.writeFileSync(RATINGS_PATH, [...migrated, ...kept].join("\n") + "\n", "utf8");
  return { inserted: migrated.length, kept: kept.length };
}

function rollbackRatings(dryRun) {
  if (!fs.existsSync(RATINGS_PATH)) return 0;
  const lines = fs.readFileSync(RATINGS_PATH, "utf8").split(/\r?\n/).filter((l) => l.trim());
  const kept = lines.filter((l) => !l.includes(RATINGS_MARKER));
  const removed = lines.length - kept.length;
  if (removed && !dryRun) fs.writeFileSync(RATINGS_PATH, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  return removed;
}

// ------------------------------------------------------------- 主流程 ----

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const today = new Date().toISOString().slice(0, 10);

  if (opts.rollback) {
    const removed = [];
    const manifest = path.join(ARCHIVE, "generated-sessions.manifest.txt");
    if (fs.existsSync(manifest)) {
      for (const line of fs.readFileSync(manifest, "utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const p = path.join(SESSIONS_DIR, line.trim());
        if (fs.existsSync(p)) { removed.push(p); if (!opts.dryRun) fs.rmSync(p); }
      }
    } else {
      console.warn("警告：找不到 generated-sessions.manifest.txt，无法定位曾生成的会话文件（归档目录可能已删）");
    }
    const ratingsRemoved = rollbackRatings(opts.dryRun);
    const archiveExisted = fs.existsSync(ARCHIVE);
    if (archiveExisted && !opts.dryRun) fs.rmSync(ARCHIVE, { recursive: true, force: true });
    console.log(`${opts.dryRun ? "[dry] 将回退" : "✓ 已回退到未迁移状态"}：生成会话 ${removed.length} 个、ratings 迁移行 ${ratingsRemoved} 条、归档目录 ${archiveExisted ? 1 : 0} 个`);
    return;
  }

  const ratingsEntries = opts.skipRatings ? [] : buildRatingsEntries();

  if (!opts.skipArchive) {
    const plan = await buildArchivePlan();
    plan.vaultList = [...new Set(plan.copies.filter((c) => c.dest.includes("vault-notes")).map((c) => path.relative(path.join(ARCHIVE, "vault-notes"), c.src).replaceAll("\\", "/")))];
    console.log(`归档计划：traces ${plan.traceCount} 个、session_logs ${plan.logCount} 个、vault 笔记 ${plan.vaultList.length} 个、记忆导出 ${plan.memoryRows.length} 条（共 ${plan.copies.length + 2} 个落盘文件）`);
    if (opts.dryRun) {
      for (const c of plan.copies) console.log(`  copy ${c.src} → ${path.relative(ROOT, c.dest)}`);
    } else {
      execCopies(plan, false);
      fs.writeFileSync(path.join(ARCHIVE, "memory-extract.md"), memoryExtractMarkdown(plan.memoryRows), "utf8");
      fs.writeFileSync(path.join(ARCHIVE, "README.md"), archiveReadme(plan, today, ratingsEntries), "utf8");
      console.log(`✓ 归档完成 → ${path.relative(ROOT, ARCHIVE)}`);
    }
  }

  if (!opts.skipSessions) {
    const { units, skipped, nonDialog } = collectUnits();
    const built = units.map(sessionJsonl);
    const rounds = built.reduce((n, s) => n + s.rounds, 0);
    console.log(`会话转换计划：${built.length} 个会话（${rounds} 轮对话）；无对话内容不入回放 ${nonDialog} 个（纯记忆操作/计划快照，已归档）、解析失败跳过 ${skipped} 个${scrubHits ? `；脱敏替换 ${scrubHits} 处` : ""}`);
    for (const s of built) console.log(`  ${opts.dryRun ? "[dry] " : ""}${s.filename}（${s.rounds} 轮）`);
    if (!opts.dryRun) {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      for (const s of built) fs.writeFileSync(path.join(SESSIONS_DIR, s.filename), s.body, "utf8");
      fs.mkdirSync(ARCHIVE, { recursive: true });
      fs.writeFileSync(path.join(ARCHIVE, "generated-sessions.manifest.txt"), built.map((s) => s.filename).join("\n") + "\n", "utf8");
      console.log(`✓ 会话写入 → ${SESSIONS_DIR}`);
      console.log("  提示：pi --resume 即可看到这些会话；pi --export <会话文件> <输出.html> 可导出 HTML 回放。");
    }
  }

  if (!opts.skipRatings) {
    const res = applyRatings(ratingsEntries, opts.dryRun);
    const byScore = { 1: 0, 5: 0 };
    for (const e of ratingsEntries) byScore[e.score]++;
    console.log(`质量标注：golden ${byScore[5]} 条（5 分）+ badcase ${byScore[1]} 条（1 分）→ ${path.relative(ROOT, RATINGS_PATH)} 插入文件头（本 agent 真实评分保留 ${res.kept} 条）`);
  }

  if (opts.dryRun) console.log("（dry-run：未写任何文件）");
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
