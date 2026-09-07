#!/usr/bin/env node
/**
 * job-scout 离线自测：归一化/关键词过滤/指纹/文件名/JD stub 落盘（不联网）。
 * 用法：node evals/selftest-job-scout.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lib.mjs";
import {
	fingerprint, normalizeXixicc, matchesKeywords, normalizeHtml, safeName, writeJdStub,
} from "../.pi/skills/job-scout/scripts/fetch-jobs.mjs";

let failed = 0;
const assert = (name, cond) => {
	console.log(`${cond ? "✓" : "✗"} ${name}`);
	if (!cond) failed++;
};

// ---------- normalizeXixicc ----------
const record = {
	company: "强脑科技", cohort: "2027届", batch: "实习", industry: "半导体/硬件",
	positions: ["AI算法类（大模型/机器人）", "硬件工程", "嵌入式软件"],
	locations: ["深圳", "杭州"], apply_url: "https://example.com/apply",
	deadline: "2026-10-01", first_seen: "2026-07-16",
};
const items = normalizeXixicc(record);
assert("xixicc 记录按岗位方向拆分为 3 条", items.length === 3);
assert("字段归一化正确", items[0]["公司"] === "强脑科技" && items[0]["城市"] === "深圳、杭州"
	&& items[0]["截止"] === "2026-10-01" && items[0]["链接"] === "https://example.com/apply");
assert("缺字段容错（null 链接/空 locations）", normalizeXixicc({
	company: null, positions: ["算法实习"], locations: null, apply_url: null,
})[0]["城市"] === "未提及" && normalizeXixicc({ positions: ["算法实习"] })[0]["公司"] === "未提及");

// ---------- matchesKeywords ----------
const kw = ["AI", "大模型", "Agent", "算法", "医疗"];
assert("关键词命中（岗位含 AI）", matchesKeywords({ "公司": "某公司", "岗位": "AI产品实习" }, kw));
assert("关键词命中（公司名含医疗）", matchesKeywords({ "公司": "熙牛医疗", "岗位": "后端开发" }, kw));
assert("关键词不命中", !matchesKeywords({ "公司": "某钢厂", "岗位": "炉前工" }, kw));

// ---------- fingerprint ----------
const a = fingerprint("s1", { "公司": "X", "岗位": "AI算法", "批次": "秋招", "届别": "2027届" });
const b = fingerprint("s1", { "公司": "X", "岗位": "AI算法", "批次": "秋招", "届别": "2027届" });
const c = fingerprint("s1", { "公司": "X", "岗位": "后端开发", "批次": "秋招", "届别": "2027届" });
const d = fingerprint("s2", { "公司": "X", "岗位": "AI算法", "批次": "秋招", "届别": "2027届" });
assert("指纹稳定（同输入同指纹）", a === b);
assert("岗位不同指纹不同", a !== c);
assert("源不同指纹不同", a !== d);

// ---------- normalizeHtml ----------
const html = `<html><body>
<a href="/job/1">AI应用开发工程师（2027校招）</a>
<a href="/job/2">炉前操作员招聘</a>
<a href="https://other.example.com/a">大模型算法实习生</a>
<a href="/campus">校园招聘首页</a>
</body></html>`;
const htmlItems = normalizeHtml("https://hr.example.com/jobs", html, kw);
assert("html 锚点过滤出 2 条相关候选", htmlItems.length === 2);
assert("相对链接解析为绝对 URL", htmlItems[0]["链接"] === "https://hr.example.com/job/1");
assert("锚点文本进入岗位字段", htmlItems.some((i) => i["岗位"].includes("大模型算法实习生")));

// ---------- safeName + writeJdStub（写入后清理） ----------
assert("文件名去除非法字符与空格", safeName('A/B: C*D?"E<F>G|公司.md') === "ABCDEFG公司.md");
const stubSource = { id: "selftest", name: "自测源", note: "自测备注" };
const stubItem = {
	"公司": "自测/公司", "岗位": "AI 算法实习", "城市": "杭州", "链接": "https://x.y",
	"截止": "2026-10-01", "批次": "实习", "届别": "2027届", "摘要": "实习｜2027届｜杭州",
};
const stubFile = path.join(ROOT, "data", "jds", `${safeName(stubItem["公司"])}-${safeName(stubItem["岗位"])}.md`);
const suffixedFile = path.join(ROOT, "data", "jds", `${safeName(stubItem["公司"])}-${safeName(stubItem["岗位"])}-正式批.md`);
try {
	const written = writeJdStub(stubSource, stubItem);
	assert("JD stub 落盘路径符合 data/jds 约定", written === stubFile);
	const content = fs.readFileSync(stubFile, "utf8");
	assert("stub frontmatter 含状态 collected 与来源", content.includes("状态: collected") && content.includes("来源: job-scout/selftest"));

	// 防覆盖：同公司同岗位不同批次 → 追加批次后缀，不覆盖已有 stub
	const other = writeJdStub(stubSource, { ...stubItem, "批次": "正式批" });
	assert("批次不同时追加批次后缀", other === suffixedFile && fs.existsSync(suffixedFile));
	// 幂等：同批次重写同名文件（覆盖自身）
	const again = writeJdStub(stubSource, stubItem);
	assert("同批次重写保持幂等", again === stubFile);
	// analyzed 卡片永远不被 stub 覆盖
	fs.writeFileSync(stubFile, content.replace("状态: collected", "状态: analyzed"), "utf8");
	const guarded = writeJdStub(stubSource, stubItem);
	assert("analyzed 卡片不被 stub 覆盖", guarded !== stubFile);
	fs.rmSync(guarded, { force: true });
} finally {
	fs.rmSync(stubFile, { force: true });
	fs.rmSync(suffixedFile, { force: true });
}

console.log(failed === 0 ? "\njob-scout 自测全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
