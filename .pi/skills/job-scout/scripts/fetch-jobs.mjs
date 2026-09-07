#!/usr/bin/env node
/**
 * job-scout 拉取脚本（确定性部分，零依赖）
 *
 * 用法：
 *   node .pi/skills/job-scout/scripts/fetch-jobs.mjs                 # 拉取全部启用源
 *   node .pi/skills/job-scout/scripts/fetch-jobs.mjs --source <id>   # 只拉指定源
 *   node .pi/skills/job-scout/scripts/fetch-jobs.mjs --dry-run       # 只报告不落盘
 *
 * 职责：逐源拉取 → 归一化 → 关键词过滤 → 与 seen.json 去重 → 新岗位写 data/jds/（状态 collected）→ 报告。
 * 合规：只抓公开 URL，每源间隔 ≥2s，超时 15s，失败重试 1 次后跳过；不绕过任何登录/风控。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// 项目根 = 从脚本目录向上找到含 package.json 的目录（对脚本位置变化稳健）
const ROOT = (() => {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 6; i++) {
		if (fs.existsSync(path.join(dir, "package.json"))) return dir;
		dir = path.dirname(dir);
	}
	throw new Error("找不到项目根（未发现 package.json）");
})();
const SOURCES_FILE = path.join(ROOT, "data", "sources", "sources.json");
const SEEN_FILE = path.join(ROOT, "data", "sources", "seen.json");
const JDS_DIR = path.join(ROOT, "data", "jds");
const FETCH_TIMEOUT_MS = 15000;
const SOURCE_GAP_MS = 2000;

const args = process.argv.slice(2);
const argOf = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const DRY_RUN = args.includes("--dry-run");
const onlySource = argOf("--source");

function loadSeen() {
	if (!fs.existsSync(SEEN_FILE)) return {};
	try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")); } catch { return {}; }
}
function saveSeen(seen) {
	fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
	fs.writeFileSync(SEEN_FILE, JSON.stringify(seen, null, 2));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const res = await fetch(url, {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: { "User-Agent": "agent-for-jobs/0.1 (personal job hunting assistant)" },
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.text();
		} catch (e) {
			if (attempt === 2) throw e;
			await sleep(1500);
		}
	}
}

export function fingerprint(sourceId, item) {
	const raw = [sourceId, item["公司"], item["岗位"], item["批次"], item["届别"]].join("|");
	return crypto.createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

/** xixicc jobs.json 记录 → 岗位条目（按岗位方向拆分，关键词在岗位名上过滤） */
export function normalizeXixicc(record, cfg = {}) {
	const items = [];
	for (const pos of record.positions || []) {
		items.push({
			"公司": record.company || "未提及",
			"岗位": pos,
			"批次": record.batch || "",
			"届别": record.cohort || "",
			"城市": (record.locations || []).join("、") || "未提及",
			"行业": record.industry || "",
			"链接": record.apply_url || "",
			"截止": record.deadline || "未提及",
			"首见": record.first_seen || "",
			"摘要": `${record.batch || "校招"}｜${record.cohort || ""}｜${(record.locations || []).join("、")}`,
		});
	}
	return items;
}

/** html 页面 → 候选岗位条目（只做确定性锚点提取，正文提取交给 agent） */
export function normalizeHtml(pageUrl, html, keywords) {
	const items = [];
	const seen = new Set();
	for (const m of html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
		const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		if (!text || text.length < 4 || text.length > 60) continue;
		const hay = text.toLowerCase();
		if (!keywords.some((k) => hay.includes(k.toLowerCase()))) continue;
		let href = m[1];
		try { href = new URL(href, pageUrl).href; } catch { continue; }
		const fpKey = href + "|" + text;
		if (seen.has(fpKey)) continue;
		seen.add(fpKey);
		items.push({
			"公司": "待确认",
			"岗位": text,
			"批次": "",
			"届别": "",
			"城市": "未提及",
			"行业": "",
			"链接": href,
			"截止": "未提及",
			"首见": new Date().toISOString().slice(0, 10),
			"摘要": `页面锚点候选：${pageUrl}`,
		});
	}
	return items;
}

export function matchesKeywords(item, keywords) {
	const hay = `${item["公司"]} ${item["岗位"]}`.toLowerCase();
	return keywords.some((k) => hay.includes(k.toLowerCase()));
}

export function safeName(s) {
	return String(s).replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 40) || "未命名";
}

export function writeJdStub(source, item) {
	let file = path.join(JDS_DIR, `${safeName(item["公司"])}-${safeName(item["岗位"])}.md`);
	// 防覆盖：目标已存在且（是已解析卡片 或 批次不同）→ 文件名追加批次后缀
	if (fs.existsSync(file)) {
		const existing = fs.readFileSync(file, "utf8");
		const isAnalyzed = existing.includes("状态: analyzed");
		const existingBatch = (existing.match(/^- 批次\/届别：(.+?) \/ /m) || [])[1] || "";
		const newBatch = item["批次"] || "未提及";
		if (isAnalyzed || (existingBatch && existingBatch !== newBatch)) {
			file = path.join(JDS_DIR, `${safeName(item["公司"])}-${safeName(item["岗位"])}-${safeName(newBatch)}.md`);
		}
	}
	const fm = [
		"---",
		`公司: ${item["公司"]}`,
		`岗位: ${item["岗位"]}`,
		`城市: ${item["城市"]}`,
		`来源: job-scout/${source.id}`,
		`薪资范围: 未提及`,
		`收录日期: ${new Date().toISOString().slice(0, 10)}`,
		`状态: collected`,
		"---",
		"",
		`# ${item["公司"]} - ${item["岗位"]}（自动收录）`,
		"",
		`- 批次/届别：${item["批次"] || "未提及"} / ${item["届别"] || "未提及"}`,
		`- 投递链接：${item["链接"] || "未提及"}`,
		`- 截止日期：${item["截止"]}`,
		`- 源备注：${source.note || source.name}`,
		"",
		`> 本条由 job-scout 自动收录（${item["摘要"]}）。JD 原文待补充：运行 /jd 或让 agent 抓取投递链接提取原文后，用 jd-analysis 生成正式卡片（覆盖本文件）。`,
		"",
	];
	fs.writeFileSync(file, fm.join("\n"), "utf8");
	return file;
}

async function fetchSource(source, cfg, seen) {
	const result = { id: source.id, source, ok: false, total: 0, fresh: [], error: null };
	try {
		let text = null;
		let lastErr = null;
		for (const url of source.urls) {
			try { text = await fetchText(url); break; } catch (e) { lastErr = e; }
		}
		if (text === null) throw lastErr;

		let items = [];
		if (source.type === "github-json" && source.format === "xixicc") {
			const records = JSON.parse(text);
			const kw = cfg.defaultKeywords || [];
			for (const rec of records) items.push(...normalizeXixicc(rec, cfg));
			items = items.filter((it) => matchesKeywords(it, kw));
			if (cfg.cohorts?.length) items = items.filter((it) => cfg.cohorts.includes(it["届别"]) || !it["届别"]);
		} else if (source.type === "html") {
			const kw = cfg.defaultKeywords || [];
			items = normalizeHtml(source.urls[0], text, kw);
		} else {
			throw new Error(`未知源类型: ${source.type}`);
		}
		result.total = items.length;
		result.fresh = items.filter((it) => {
			const fp = fingerprint(source.id, it);
			return !seen[fp];
		});
		result.ok = true;
	} catch (e) {
		result.error = e.message;
	}
	return result;
}

export async function main() {
	const cfg = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8"));
	const sources = cfg.sources.filter((s) => s.enabled && (!onlySource || s.id === onlySource));
	if (sources.length === 0) {
		console.log(onlySource ? `源 ${onlySource} 不存在或未启用` : "没有启用的源（data/sources/sources.json）");
		process.exit(1);
	}
	const seen = loadSeen();
	const results = [];

	for (const source of sources) {
		if (results.length > 0) await sleep(SOURCE_GAP_MS);
		console.error(`[${source.id}] 拉取中…`);
		const r = await fetchSource(source, cfg, seen);
		results.push(r);
		console.error(r.ok
			? `[${source.id}] 条目 ${r.total}，新 ${r.fresh.length}`
			: `[${source.id}] 失败：${r.error}`);
	}

	const ts = new Date();
	const tsName = ts.toISOString().replace(/[:T]/g, "-").slice(0, 19);
	const reportLines = [
		`# job-scout 拉取报告 ${tsName}`,
		"",
	];
	let written = 0;
	for (const r of results) {
		reportLines.push(`## ${r.id}：${r.ok ? `条目 ${r.total}，新 ${r.fresh.length}` : `失败（${r.error}）`}`);
		reportLines.push("");
		for (const it of r.fresh) {
			const fp = fingerprint(r.id, it);
			let fileNote = "";
			if (!DRY_RUN) {
				const file = writeJdStub(r.source, it);
				seen[fp] = ts.toISOString();
				fileNote = ` → 已落盘 ${path.basename(file)}`;
				written++;
			}
			reportLines.push(`- ${it["公司"]}｜${it["岗位"]}｜${it["城市"]}｜批次 ${it["批次"] || "未提及"}｜截止 ${it["截止"]}${fileNote}`);
		}
		if (r.fresh.length === 0) reportLines.push("（无新岗位）");
		reportLines.push("");
	}
	if (!DRY_RUN) {
		saveSeen(seen);
		const reportFile = path.join(ROOT, "data", "sources", `report-${tsName.replace(/:/g, "")}.md`);
		fs.mkdirSync(path.dirname(reportFile), { recursive: true });
		fs.writeFileSync(reportFile, reportLines.join("\n"), "utf8");
		console.log(reportLines.join("\n"));
		console.log(`\n新岗位 ${written} 条${written > 0 ? `，已写入 data/jds/（状态 collected），报告：${path.basename(reportFile)}` : ""}。`);
	} else {
		console.log(reportLines.join("\n"));
		console.log("\n[dry-run] 未写入任何文件。");
	}
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
	main().catch((e) => { console.error(e); process.exit(2); });
}
