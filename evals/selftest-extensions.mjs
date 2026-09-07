#!/usr/bin/env node
/**
 * 扩展行为自测：不进 TUI，直接以 fake ExtensionAPI 调用真实扩展代码。
 * 覆盖 /pipeline（看板渲染）与 /rate（评分落盘）。
 * 依赖 Node ≥ 22.6 的 TypeScript 类型剥离（import type 会被自动去除）。
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.mjs";

let failed = 0;
const assert = (name, cond) => {
	console.log(`${cond ? "✓" : "✗"} ${name}`);
	if (!cond) failed++;
};

/** 装载扩展模块并收集其注册的命令 */
async function loadExtension(relPath) {
	const mod = await import(new URL(`../${relPath}`, import.meta.url).href);
	const commands = {};
	mod.default({ registerCommand: (name, opts) => { commands[name] = opts; } });
	return commands;
}

// ---------- /pipeline ----------
const tempCards = [
	{ file: "data/jds/自测甲科技-算法.md", content: "---\n公司: 自测甲科技\n岗位: 算法\n城市: 北京\n状态: analyzed\n匹配度: 88\n薪资范围: 25k-30k\n---\n# x" },
	{ file: "data/jds/自测乙科技-后端.md", content: "---\n公司: 自测乙科技\n岗位: 后端\n城市: 杭州\n状态: applied\n匹配度: 41\n---\n# x" },
	{ file: "data/jds/自测丙科技-产品.md", content: "---\n公司: 自测丙科技\n岗位: 产品\n状态: rejected\n匹配度: 30\n---\n# x" },
];
for (const c of tempCards) fs.writeFileSync(path.join(ROOT, c.file), c.content, "utf8");

try {
	const commands = await loadExtension(".pi/extensions/pipeline.ts");
	assert("pipeline 扩展注册了 /pipeline 命令", Boolean(commands.pipeline));
	let board = "";
	await commands.pipeline.handler("", { ui: { notify: (m) => { board = m; } } });
	assert("看板包含漏斗计数行", board.includes("已解析") && board.includes("已投递") && board.includes("已挂"));
	assert("看板按阶段分组列出岗位", board.includes("自测甲科技-算法") && board.includes("自测乙科技-后端"));
	assert("看板展示匹配度", board.includes("匹配度 88"));
	assert("看板展示转化统计", board.includes("转化："));
	assert("看板包含真实解析过的卡片", board.includes("灵犀医疗"));
} finally {
	for (const c of tempCards) fs.rmSync(path.join(ROOT, c.file), { force: true });
}

// ---------- /rate ----------
const ratingsPath = path.join(ROOT, "data", "telemetry", "ratings.jsonl");
const before = fs.existsSync(ratingsPath) ? fs.readFileSync(ratingsPath, "utf8") : "";
try {
	const commands = await loadExtension(".pi/extensions/telemetry.ts");
	assert("telemetry 扩展注册了 /rate 命令", Boolean(commands.rate));

	const notified = [];
	const ctx = { ui: { notify: (m, t) => notified.push({ m, t }) } };

	await commands.rate.handler("bad input", ctx);
	assert("非法评分给出用法提示", notified.some((n) => n.m.includes("用法")));

	await commands.rate.handler("2 匹配度打得太乐观", ctx);
	const after = fs.readFileSync(ratingsPath, "utf8");
	const lastLine = after.trim().split("\n").pop();
	const rec = JSON.parse(lastLine);
	assert("评分 2 分追加到 ratings.jsonl", rec.score === 2 && rec.note === "匹配度打得太乐观");
	assert("低分提示与自进化关联", notified.some((n) => n.m.includes("evolve")));
} finally {
	fs.writeFileSync(ratingsPath, before, "utf8");
}

console.log(failed === 0 ? "\n扩展自测全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
