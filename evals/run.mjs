#!/usr/bin/env node
/**
 * 评测 runner：golden-set 评测
 *
 * 用法：
 *   node evals/run.mjs                 # 全量评测（真实调用 pi + GLM）
 *   node evals/run.mjs --dry-run       # 只校验 harness 结构，不调 API
 *   node evals/run.mjs --case id1,id2  # 只跑指定 case
 *   node evals/run.mjs --judge         # 断言通过后追加 LLM-as-Judge 打分（额外 API 调用）
 *
 * 评测期间对 data/（jds/resumes/reviews/memory/telemetry）做快照，结束后恢复，保证幂等。
 * 产物：evals/reports/eval-<ts>.md（人读）+ eval-<ts>.json（evolve.mjs 消费）。
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, runPi, timestamp, readIfExists, copyDir } from "./lib.mjs";

const SNAPSHOT_DIRS = ["data/jds", "data/resumes", "data/reviews", "data/memory", "data/telemetry"];
const VALID_KINDS = new Set(["file_exists", "contains", "not_contains", "regex", "frontmatter", "min_count"]);

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const JUDGE = args.includes("--judge");
const caseFlagIdx = args.indexOf("--case");
const caseFilter = caseFlagIdx !== -1 ? args[caseFlagIdx + 1] : null;

// ---------- 加载 cases ----------
// 用例中的 {{name}} / {{school}} 占位符在加载时从本机 master-resume 提取替换，
// 真实姓名与学校不写入仓库。
function loadCases() {
	const dir = path.join(ROOT, "evals", "cases");
	const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
	const masterPath = path.join(ROOT, "data", "profile", "master-resume.md");
	const master = fs.existsSync(masterPath) ? fs.readFileSync(masterPath, "utf8") : "";
	const vars = {
		name: (master.match(/^-\s*姓名：\s*(\S+)/m) || ["", ""])[1],
		school: ((master.split(/^## 教育背景/m)[1] || "").match(/\*\*(.+?)\*\*/) || ["", ""])[1],
	};
	const cases = [];
	for (const f of files) {
		let text = fs.readFileSync(path.join(dir, f), "utf8");
		for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
		const def = JSON.parse(text);
		def._file = f;
		cases.push(def);
	}
	return cases;
}

// ---------- harness 结构校验（dry-run 主体，live 模式也会先跑） ----------
function harnessChecks() {
	const results = [];
	const check = (name, ok, detail = "") => results.push({ name, ok, detail });

	check("AGENTS.md 存在且非空", fs.existsSync(path.join(ROOT, "AGENTS.md")) &&
		fs.statSync(path.join(ROOT, "AGENTS.md")).size > 100);
	check(".pi/SYSTEM.md 存在", fs.existsSync(path.join(ROOT, ".pi", "SYSTEM.md")));
	check("REQUIREMENTS.md 存在", fs.existsSync(path.join(ROOT, "REQUIREMENTS.md")));

	for (const skill of ["jd-analysis", "resume-tailor", "interview-review"]) {
		const p = path.join(ROOT, ".pi", "skills", skill, "SKILL.md");
		if (!fs.existsSync(p)) { check(`skill ${skill} 存在`, false); continue; }
		const content = fs.readFileSync(p, "utf8");
		const fm = content.match(/^---\n([\s\S]*?)\n---/);
		const name = fm ? (fm[1].match(/^name:\s*(.+)$/m) || [])[1] : null;
		const desc = fm ? (fm[1].match(/^description:\s*(.+)$/m) || [])[1] : null;
		check(`skill ${skill} frontmatter 完整`,
			Boolean(name?.trim()) && name.trim() === skill && Boolean(desc?.trim()) && desc.length <= 1030,
			`name=${name ?? "缺失"}`);
	}

	for (const prompt of ["jd.md", "resume.md", "review.md", "evolve.md"]) {
		const p = path.join(ROOT, ".pi", "prompts", prompt);
		const ok = fs.existsSync(p) && /^---\n[\s\S]*?description:/m.test(fs.readFileSync(p, "utf8"));
		check(`prompt /${prompt.replace(".md", "")} 存在且带 description`, ok);
	}

	for (const ext of ["pipeline.ts", "telemetry.ts"]) {
		const p = path.join(ROOT, ".pi", "extensions", ext);
		const ok = fs.existsSync(p) && fs.readFileSync(p, "utf8").includes("registerCommand");
		check(`extension ${ext} 存在且注册命令`, ok);
	}

	check("data/profile/master-resume.md 存在",
		fs.existsSync(path.join(ROOT, "data", "profile", "master-resume.md")));
	const styleGuide = path.join(ROOT, "data", "profile", "resume-style-guide.md");
	const tailorSkill = path.join(ROOT, ".pi", "skills", "resume-tailor", "SKILL.md");
	check("resume-style-guide.md 存在且被 resume-tailor 引用",
		fs.existsSync(styleGuide) && fs.existsSync(tailorSkill)
		&& fs.readFileSync(tailorSkill, "utf8").includes("resume-style-guide.md"));
	const sourcesCfg = path.join(ROOT, "data", "sources", "sources.json");
	let sourcesOk = fs.existsSync(sourcesCfg);
	if (sourcesOk) {
		try {
			const parsed = JSON.parse(fs.readFileSync(sourcesCfg, "utf8"));
			sourcesOk = Array.isArray(parsed.sources) && parsed.sources.every((s) => s.id && s.type && Array.isArray(s.urls) && s.urls.length > 0);
		} catch { sourcesOk = false; }
	}
	check("data/sources/sources.json 存在且结构合法（job-scout）", sourcesOk);
	check("data 骨架目录齐全", SNAPSHOT_DIRS.every((d) => fs.existsSync(path.join(ROOT, d))));

	try {
		JSON.parse(fs.readFileSync(path.join(ROOT, "models.example.json"), "utf8"));
		check("models.example.json 是合法 JSON", true);
	} catch (e) {
		check("models.example.json 是合法 JSON", false, e.message);
	}

	const userModels = path.join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "models.json");
	if (fs.existsSync(userModels)) {
		try {
			JSON.parse(fs.readFileSync(userModels, "utf8"));
			check("~/.pi/agent/models.json 存在且合法", true);
		} catch (e) {
			check("~/.pi/agent/models.json 存在且合法", false, e.message);
		}
	} else {
		check("~/.pi/agent/models.json 存在且合法", false, "未找到，请参考 models.example.json 配置");
	}

	return results;
}

// ---------- 断言引擎 ----------
function frontmatterValue(content, field) {
	const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!fm) return null;
	const line = fm[1].match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
	return line ? line[1].trim() : null;
}

function runAssertions(caseDef) {
	const results = [];
	const defaultTarget = caseDef.outputs?.[0];
	const cache = {};
	const getContent = (target) => {
		if (!target) return null;
		if (!(target in cache)) cache[target] = readIfExists(target);
		return cache[target];
	};

	for (const a of caseDef.assertions || []) {
		const label = a.name || `${a.kind}${a.target ? `@${path.basename(a.target)}` : ""}${a.field ? `:${a.field}` : ""}${a.text ? `「${a.text}」` : ""}`;
		let ok = false;
		let detail = "";
		try {
			const target = a.target || defaultTarget;
			if (a.kind === "file_exists") {
				ok = fs.existsSync(path.join(ROOT, target));
				if (!ok) detail = `文件不存在: ${target}`;
			} else {
				const content = getContent(target);
				if (content === null) {
					detail = `无法读取: ${target}`;
				} else if (a.kind === "contains") {
					ok = content.includes(a.text);
					if (!ok) detail = `未找到文本「${a.text}」`;
				} else if (a.kind === "not_contains") {
					ok = !content.includes(a.text);
					if (!ok) detail = `不应出现的文本「${a.text}」出现了`;
				} else if (a.kind === "regex") {
					ok = new RegExp(a.pattern, a.flags || "m").test(content);
					if (!ok) detail = `正则不匹配: ${a.pattern}`;
				} else if (a.kind === "min_count") {
					const count = content.split(a.text).length - 1;
					ok = count >= a.count;
					if (!ok) detail = `出现 ${count} 次 < 要求 ${a.count} 次`;
				} else if (a.kind === "frontmatter") {
					const value = frontmatterValue(content, a.field);
					ok = value !== null && value !== "" && value !== "未提及";
					if (ok && a.pattern) {
						ok = a.partial
							? new RegExp(a.pattern).test(value)
							: new RegExp(`^(?:${a.pattern})$`).test(value);
					}
					if (ok && a.minValue !== undefined) ok = Number(value) >= a.minValue;
					if (ok && a.maxValue !== undefined) ok = Number(value) <= a.maxValue;
					if (!ok) detail = `${a.field}=${value ?? "缺失"}（期望${a.pattern ? ` 匹配 ${a.pattern}` : ""}${a.minValue !== undefined ? ` ≥${a.minValue}` : ""}${a.maxValue !== undefined ? ` ≤${a.maxValue}` : ""}）`;
				}
			}
		} catch (e) {
			detail = `断言执行异常: ${e.message}`;
		}
		results.push({ label, ok, detail });
	}
	return results;
}

// ---------- 快照与恢复 ----------
function snapshot() {
	const backupRoot = path.join(ROOT, ".pi", "backup", `eval-snapshot-${timestamp()}`);
	for (const dir of SNAPSHOT_DIRS) {
		const src = path.join(ROOT, dir);
		if (fs.existsSync(src)) copyDir(src, path.join(backupRoot, dir));
	}
	return backupRoot;
}

function restore(backupRoot) {
	for (const dir of SNAPSHOT_DIRS) {
		const src = path.join(backupRoot, dir);
		const dest = path.join(ROOT, dir);
		fs.rmSync(dest, { recursive: true, force: true });
		if (fs.existsSync(src)) copyDir(src, dest);
	}
}

// ---------- 主流程 ----------
async function main() {
	const allCases = loadCases();
	const selected = caseFilter
		? allCases.filter((c) => caseFilter.split(",").map((s) => s.trim()).includes(c.id))
		: allCases;

	const harnessResults = harnessChecks();
	const harnessFailed = harnessResults.filter((r) => !r.ok);
	console.log(`[harness] 结构校验 ${harnessResults.length - harnessFailed.length}/${harnessResults.length} 通过`);
	for (const r of harnessFailed) console.log(`  ✗ ${r.name} ${r.detail}`);

	const caseResults = [];
	if (!DRY_RUN) {
		if (harnessFailed.length > 0) {
			console.error("harness 结构校验未通过，先修复再跑全量评测（或用 --dry-run 查看明细）");
			process.exit(1);
		}
		const backupRoot = snapshot();
		let piFailed = false;
		try {
			for (const caseDef of selected) {
				console.log(`\n▶ ${caseDef.id}（${caseDef.skill}）运行中…`);
				// 清掉本 case 的期望产物，防止旧文件让断言假通过
				for (const out of caseDef.outputs || []) {
					const abs = path.join(ROOT, out);
					if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
				}
				const res = runPi(caseDef.prompt, { timeoutMs: caseDef.timeoutMs || 300000 });
				if (!res.ok) {
					piFailed = true;
					caseResults.push({
						id: caseDef.id, skill: caseDef.skill, ok: false,
						assertions: [{ label: "pi 进程执行", ok: false, detail: (res.stderr || res.stdout || "无输出").slice(0, 500) }],
					});
					console.log(`  ✗ pi 执行失败: ${(res.stderr || res.stdout).slice(0, 200)}`);
					continue;
				}
				const assertions = runAssertions(caseDef);
				const passed = assertions.filter((a) => a.ok).length;
				let judge = null;
				if (JUDGE && assertions.every((a) => a.ok) && caseDef.outputs?.[0]) {
					const jPrompt = `请阅读文件 ${caseDef.outputs[0]}（用 read 工具），作为严格评审对它作为"${caseDef.skill}"技能产物的质量打 1-5 分（5 最好，考察完整性、结构、内容真实合理）。第一行必须输出 SCORE: <1-5 数字>，第二行必须输出 REASON: <一句话理由>。不要输出其他内容。`;
					const jRes = runPi(jPrompt, { timeoutMs: 180000 });
					const score = (jRes.stdout.match(/SCORE:\s*([1-5])/) || [])[1];
					const reason = (jRes.stdout.match(/REASON:\s*(.+)/) || [])[1] || "";
					judge = { score: score ? Number(score) : null, reason: reason.trim() };
				}
				caseResults.push({ id: caseDef.id, skill: caseDef.skill, ok: assertions.every((a) => a.ok), assertions, judge });
				console.log(`  ${assertions.every((a) => a.ok) ? "✓" : "✗"} 断言 ${passed}/${assertions.length} 通过${judge ? `，judge=${judge.score}分` : ""}`);
				for (const a of assertions.filter((x) => !x.ok)) console.log(`    ✗ ${a.label} ${a.detail}`);
			}
		} finally {
			restore(backupRoot);
			console.log(`\n[data] 已从快照恢复（${path.basename(backupRoot)}）`);
		}
		if (piFailed) console.log("提示：若报模型不可用，请检查 ANTHROPIC_AUTH_TOKEN / ZHIPU_API_KEY 环境变量。");
	}

	// ---------- 报告 ----------
	const total = caseResults.length;
	const passed = caseResults.filter((c) => c.ok).length;
	const ts = timestamp();
	const report = {
		time: new Date().toISOString(),
		dryRun: DRY_RUN,
		harness: harnessResults,
		summary: { total, passed, failed: total - passed, harnessFailed: harnessFailed.length },
		cases: caseResults,
	};

	const mdLines = [
		`# 评测报告 ${ts}`,
		"",
		`- 模式：${DRY_RUN ? "dry-run（结构校验）" : "全量评测"}`,
		`- 结果：**${passed}/${total} case 通过**，harness 校验 ${harnessResults.length - harnessFailed.length}/${harnessResults.length}`,
		"",
		"| case | 技能 | 结果 | 断言 | judge |",
		"|---|---|---|---|---|",
	];
	for (const c of caseResults) {
		const p = c.assertions.filter((a) => a.ok).length;
		mdLines.push(`| ${c.id} | ${c.skill} | ${c.ok ? "✅" : "❌"} | ${p}/${c.assertions.length} | ${c.judge?.score ?? "-"} |`);
	}
	mdLines.push("", "## 失败明细", "");
	for (const c of caseResults.filter((x) => !x.ok)) {
		mdLines.push(`### ${c.id}`);
		for (const a of c.assertions.filter((x) => !x.ok)) mdLines.push(`- ✗ ${a.label} ${a.detail}`);
		mdLines.push("");
	}
	if (harnessFailed.length > 0) {
		mdLines.push("## harness 校验失败项", "");
		for (const r of harnessFailed) mdLines.push(`- ✗ ${r.name} ${r.detail}`);
	}

	fs.mkdirSync(path.join(ROOT, "evals", "reports"), { recursive: true });
	fs.writeFileSync(path.join(ROOT, "evals", "reports", `eval-${ts}.md`), mdLines.join("\n"), "utf8");
	fs.writeFileSync(path.join(ROOT, "evals", "reports", `eval-${ts}.json`), JSON.stringify(report, null, 2), "utf8");
	console.log(`\n[report] evals/reports/eval-${ts}.md`);
	process.exit(passed === total && harnessFailed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
