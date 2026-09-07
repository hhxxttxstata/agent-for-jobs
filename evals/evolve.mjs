#!/usr/bin/env node
/**
 * 自进化：失败分析 → harness 补丁 → （--apply）应用 → 回归 → 失败回滚
 *
 * 用法：
 *   node evals/evolve.mjs           # 只分析，产出补丁建议（不改任何文件）
 *   node evals/evolve.mjs --apply   # 应用补丁 + 回归验证 + 失败自动回滚
 *
 * 输入信号：
 *   1. data/telemetry/ratings.jsonl 中 ≤3 分的用户评分
 *   2. evals/reports/ 下最新 eval-*.json 中的失败断言
 * 进化对象：harness 本身（AGENTS.md / SKILL.md 的具体小节），不是模型。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ROOT, runPi, timestamp, readIfExists, copyDir } from "./lib.mjs";

const APPLY = process.argv.includes("--apply");
const PATCHABLE = [
	"AGENTS.md",
	".pi/skills/jd-analysis/SKILL.md",
	".pi/skills/resume-tailor/SKILL.md",
	".pi/skills/interview-review/SKILL.md",
];
const SECTION_TO_SKILL = {
	".pi/skills/jd-analysis/SKILL.md": "jd-analysis",
	".pi/skills/resume-tailor/SKILL.md": "resume-tailor",
	".pi/skills/interview-review/SKILL.md": "interview-review",
};

// ---------- 收集输入信号 ----------
function collectSignals() {
	const signals = [];

	const ratingsRaw = readIfExists("data/telemetry/ratings.jsonl");
	if (ratingsRaw) {
		const low = ratingsRaw
			.split(/\r?\n/)
			.filter(Boolean)
			.map((l) => { try { return JSON.parse(l); } catch { return null; } })
			.filter((r) => r && typeof r.score === "number" && r.score <= 3)
			.slice(-20);
		for (const r of low) signals.push(`[低分评分 ${r.score}/5] ${r.time} 备注: ${r.note || "（无）"}`);
	}

	const reportsDir = path.join(ROOT, "evals", "reports");
	if (fs.existsSync(reportsDir)) {
		const latest = fs.readdirSync(reportsDir)
			.filter((f) => /^eval-.*\.json$/.test(f))
			.sort()
			.pop();
		if (latest) {
			const report = JSON.parse(fs.readFileSync(path.join(reportsDir, latest), "utf8"));
			for (const c of report.cases || []) {
				for (const a of (c.assertions || []).filter((x) => !x.ok)) {
					signals.push(`[评测失败 ${c.id}] 断言「${a.label}」${a.detail}`);
				}
			}
		}
	}
	return signals;
}

// ---------- markdown 小节替换/追加 ----------
export function findSectionRange(lines, heading) {
	// 计算每行是否处于 ``` 代码围栏内，围栏内的标题（如输出模板示例）不作为小节边界
	const fenced = new Array(lines.length).fill(false);
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) { fenced[i] = true; inFence = !inFence; continue; }
		fenced[i] = inFence;
	}
	const target = heading.trim();
	let idx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (!fenced[i] && lines[i].trim() === target) { idx = i; break; }
	}
	if (idx === -1) return null;
	const level = (target.match(/^#+/) || ["##"])[0].length;
	let end = lines.length;
	for (let i = idx + 1; i < lines.length; i++) {
		if (fenced[i]) continue;
		const m = lines[i].match(/^(#+)\s/);
		if (m && m[1].length <= level) { end = i; break; }
	}
	return { idx, end };
}

export function applyPatch(content, patch) {
	const lines = content.split(/\r?\n/);
	const range = findSectionRange(lines, patch.section);
	if (!range) return null;
	if (patch.action === "replace") {
		lines.splice(range.idx, range.end - range.idx, patch.section, "", patch.content.trim(), "");
	} else if (patch.action === "append") {
		lines.splice(range.end, 0, "", patch.content.trim());
	} else {
		return null;
	}
	return lines.join("\n");
}

// ---------- 补丁块解析：YAML 风格，content 用缩进块，完全免转义 ----------
// 格式：
// ```evolve-patch
// file: <路径>
// section: <标题>
// action: replace 或 append
// content: |
//   <缩进的多行 markdown>
// ```
export function parsePatchBlocks(text) {
	const patches = [];
	for (const m of text.matchAll(/```evolve-patch\s*\n([\s\S]*?)```/g)) {
		const lines = m[1].split(/\r?\n/);
		const header = {};
		let content = null;
		let i = 0;
		for (; i < lines.length; i++) {
			const hm = lines[i].match(/^(\w+):\s*(.*)$/);
			if (!hm) break;
			if (hm[1] === "content") {
				if (hm[2].trim() === "|") {
					const collected = [];
					for (i = i + 1; i < lines.length; i++) {
						const l = lines[i];
						if (l.trim() === "") { collected.push(""); continue; }
						if (/^[ \t]/.test(l)) { collected.push(l.replace(/^(?:\t| {1,8})/, "")); continue; }
						break;
					}
					content = collected.join("\n").replace(/\s+$/, "");
				} else {
					content = hm[2];
				}
				break;
			}
			header[hm[1]] = hm[2].trim();
		}
		patches.push({ file: header.file, section: header.section, action: header.action, content });
	}
	return patches;
}

// ---------- 主流程 ----------
async function main() { 
	const signals = collectSignals();
	if (signals.length === 0) {
		console.log("没有可进化的输入信号（无 ≤3 分评分、无评测失败）。当前 harness 状态良好。");
		process.exit(0);
	}
	console.log(`[输入] ${signals.length} 条失败/低分信号`);

	const harnessDocs = PATCHABLE.map((f) => {
		const content = readIfExists(f);
		return content === null ? `### 文件 ${f}（不存在）` : `### 文件 ${f}\n\`\`\`markdown\n${content}\n\`\`\``;
	}).join("\n\n");

	const prompt = `你是 pi harness 的自进化分析器。以下是一个秋招求职 agent 的 harness 配置文件与失败证据。

请完成两件事：

1. 归纳失败模式（最多 3 条，每条一句话 + 引用对应证据编号）。
2. 给出补丁建议，用于改进 harness（提示词/模板/规则），要求小而准。只允许修改这些文件：
${PATCHABLE.map((f) => `- ${f}`).join("\n")}

每个补丁输出为一个独立的 evolve-patch 代码块，固定字段 + 缩进内容块（不要用 JSON，不要转义，直接写明文）：
\`\`\`evolve-patch
file: <文件路径>
section: <该文件中已存在的标题，一字不差>
action: replace 或 append
content: |
  <replace：该小节的完整新内容；append：追加到该小节末尾的内容。均为 markdown，整体缩进 2 空格，内部格式原样保留>
\`\`\`

规则：
- section 必须是文件中已存在的标题（含 # 号层级），一字不差；
- 补丁解决的是"规则/模板/措辞导致的失败"，不是模型能力问题；
- 拿不准就不给补丁；禁止修改与失败无关的小节；
- 全文最后输出一行：补丁数：<n>

【harness 配置文件】

${harnessDocs}

【失败证据】
${signals.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

	console.log("[分析] 调用 pi 归纳失败模式并生成补丁建议…");
	const res = runPi(prompt, { timeoutMs: 600000 });
	if (!res.ok) {
		console.error("pi 执行失败：", (res.stderr || res.stdout).slice(0, 500));
		process.exit(1);
	}
	const ts = timestamp();
	const reportPath = path.join(ROOT, "evals", "reports", `evolve-${ts}.md`);
	fs.writeFileSync(reportPath, res.stdout, "utf8");
	console.log(`[报告] ${path.relative(ROOT, reportPath)}`);

	const patches = [];
	for (const p of parsePatchBlocks(res.stdout)) {
		if (!PATCHABLE.includes(p.file) || !p.section || !p.action || typeof p.content !== "string" || !p.content.trim()) {
			console.warn(`  跳过非法补丁（字段不全或文件不在白名单）: ${p.file ?? "?"}`);
			continue;
		}
		patches.push(p);
	}
	if (patches.length === 0) {
		console.log("本轮没有生成可应用的补丁（分析报告已保存，供人工参考）。");
		process.exit(0);
	}
	console.log(`\n[补丁] 共 ${patches.length} 个：`);
	for (const p of patches) {
		console.log(`  - ${p.file} ${p.section}（${p.action === "replace" ? "整节替换" : "追加"}）`);
	}

	if (!APPLY) {
		console.log("\n当前为只分析模式。确认无误后执行 `npm run evolve:apply`（或 node evals/evolve.mjs --apply）应用补丁并自动回归。");
		process.exit(0);
	}

	// ---------- 应用 + 回归 + 回滚 ----------
	const backupDir = path.join(ROOT, ".pi", "backup", `evolve-${ts}`);
	const touched = [...new Set(patches.map((p) => p.file))];
	console.log(`\n[备份] ${touched.join(", ")} → ${path.relative(ROOT, backupDir)}`);
	for (const f of touched) {
		const src = path.join(ROOT, f);
		copyDir(path.dirname(src), path.join(backupDir, path.dirname(f)));
	}

	let applied = 0;
	for (const p of patches) {
		const abs = path.join(ROOT, p.file);
		const original = fs.readFileSync(abs, "utf8");
		const next = applyPatch(original, p);
		if (next === null) {
			console.warn(`  ✗ 补丁无法应用（标题不存在或 action 非法）：${p.section} @ ${p.file}，跳过`);
			continue;
		}
		fs.writeFileSync(abs, next, "utf8");
		applied++;
		console.log(`  ✓ 应用 ${p.section}（${p.action}）@ ${p.file}`);
	}
	if (applied === 0) {
		console.log("没有补丁成功应用，未做任何修改。");
		process.exit(1);
	}

	// 回归：AGENTS.md 的补丁影响全部 case，SKILL.md 的补丁只影响对应技能的 case
	const caseFiles = fs.readdirSync(path.join(ROOT, "evals", "cases")).filter((f) => f.endsWith(".json"));
	const allIds = caseFiles.map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, "evals", "cases", f), "utf8")).id);
	const affected = touched.includes("AGENTS.md")
		? allIds
		: [...new Set(touched.filter((f) => SECTION_TO_SKILL[f]).map((f) => SECTION_TO_SKILL[f]))]
			.flatMap((skill) => caseFiles
				.map((f) => JSON.parse(fs.readFileSync(path.join(ROOT, "evals", "cases", f), "utf8")))
				.filter((c) => c.skill === skill)
				.map((c) => c.id));

	console.log(`\n[回归] 重跑受影响 case: ${affected.join(", ")}`);
	const reg = spawnSync(process.execPath, [path.join(ROOT, "evals", "run.mjs"), "--case", affected.join(",")],
		{ cwd: ROOT, encoding: "utf8", timeout: 1800000, maxBuffer: 32 * 1024 * 1024 });
	console.log((reg.stdout || "").trim());
	if (reg.status === 0) {
		const entry = `- [${new Date().toISOString()}] 进化成功：应用 ${applied} 个补丁（${touched.map((f) => `${path.basename(path.dirname(f))}/${path.basename(f)}`).join(", ")}），回归 ${affected.length} 个 case 全部通过。\n`;
		fs.appendFileSync(path.join(ROOT, "evals", "evolve-log.md"), entry, "utf8");
		console.log(`\n[结果] ✅ 进化成功并保留，回归 ${affected.length} 个 case 全部通过。已记录到 evals/evolve-log.md`);
	} else {
		console.log("[回归] 有 case 失败，自动回滚补丁…");
		for (const f of touched) {
			const backupFile = path.join(backupDir, f);
			if (fs.existsSync(backupFile)) fs.copyFileSync(backupFile, path.join(ROOT, f));
		}
		const entry = `- [${new Date().toISOString()}] 回滚：应用 ${applied} 个补丁后回归失败，已恢复原文件（备份在 .pi/backup/evolve-${ts}/）。\n`;
		fs.appendFileSync(path.join(ROOT, "evals", "evolve-log.md"), entry, "utf8");
		console.log("[结果] ❌ 已回滚到进化前状态。请查看失败明细，调整补丁后重试。");
		process.exit(1);
	}
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
	main().catch((e) => { console.error(e); process.exit(2); });
}
