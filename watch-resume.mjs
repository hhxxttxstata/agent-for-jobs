#!/usr/bin/env node
/**
 * watch-resume.mjs —— 监听投递版简历 md，保存后自动编译 PDF
 *
 * 用法：npm run resume-watch   （或 node watch-resume.mjs）
 * 效果：data/resumes/AI应用开发.md 每次保存 → 1.5s 防抖后自动调用
 *       resume-pdf 技能编译（medium 密度），无需人工干预。
 *
 * 注意：若 PDF 正被 Adobe/Edge 等阅读器占用会 EBUSY 编译失败，
 *       下次保存会自动重试；建议用 SumatraPDF（不锁文件）预览。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const TARGET = "data/resumes/AI应用开发.md";
const DENSITY = "medium";
const DEBOUNCE_MS = 1500;

let timer = null;
let compiling = false;
let pending = false;

function compile() {
	compiling = true;
	const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
	console.log(`[${ts}] 检测到修改，编译中…`);
	const r = spawnSync(
		process.execPath,
		[".pi/skills/resume-pdf/scripts/md2pdf.mjs", TARGET, "--density", DENSITY],
		{ stdio: "inherit" },
	);
	if (r.status !== 0) console.log("✗ 编译失败（若为 EBUSY：PDF 被阅读器占用，改完后会随下次保存自动重试）");
	compiling = false;
	if (pending) {
		pending = false;
		compile();
	}
}

fs.watch(path.dirname(TARGET), (_event, filename) => {
	if (filename !== path.basename(TARGET)) return;
	clearTimeout(timer);
	timer = setTimeout(() => {
		if (compiling) {
			pending = true; // 编译期间的改动，编完补一次
		} else {
			compile();
		}
	}, DEBOUNCE_MS);
});

console.log(`正在监听 ${TARGET}（保存后自动编译 PDF，Ctrl+C 退出）`);
