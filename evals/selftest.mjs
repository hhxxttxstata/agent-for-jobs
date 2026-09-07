#!/usr/bin/env node
/**
 * 单元自测：evolve 补丁机制（findSectionRange / applyPatch）不调 API。
 * 用法：node evals/selftest.mjs
 */
import { applyPatch, findSectionRange, parsePatchBlocks } from "./evolve.mjs";

const SAMPLE = `# 标题

## 甲节
内容甲1
### 甲子节
内容甲子
## 乙节
内容乙1

## 丙节
内容丙1
`;

let failed = 0;
const assert = (name, cond) => {
	console.log(`${cond ? "✓" : "✗"} ${name}`);
	if (!cond) failed++;
};

// 小节定位：甲节范围应止于乙节（同级），不吞甲子节（子级保留在范围内）
const lines = SAMPLE.split("\n");
const rangeA = findSectionRange(lines, "## 甲节");
assert("定位 ## 甲节", rangeA && lines[rangeA.idx].trim() === "## 甲节");
assert("甲节范围止于乙节", rangeA && lines[rangeA.end].trim() === "## 乙节");
assert("不存在的标题返回 null", findSectionRange(lines, "## 不存在") === null);

// 整节替换
const replaced = applyPatch(SAMPLE, { section: "## 甲节", action: "replace", content: "新内容甲" });
assert("replace：新内容进入", replaced.includes("新内容甲") && !replaced.includes("内容甲1"));
assert("replace：甲子节被替换掉", !replaced.includes("甲子节"));
assert("replace：后续小节不受影响", replaced.includes("## 乙节") && replaced.includes("内容丙1"));

// 追加
const appended = applyPatch(SAMPLE, { section: "## 乙节", action: "append", content: "追加乙2" });
assert("append：追加到小节末尾", appended.includes("内容乙1") && appended.includes("追加乙2"));
assert("append：追加内容落在丙节之前", appended.indexOf("追加乙2") < appended.indexOf("## 丙节"));

// 非法输入
assert("未知 action 返回 null", applyPatch(SAMPLE, { section: "## 甲节", action: "delete", content: "" }) === null);
assert("未知标题返回 null", applyPatch(SAMPLE, { section: "## 不存在", action: "replace", content: "" }) === null);

// 对真实 SKILL.md 的只读演练（副本上应用，不动原文件）
import fs from "node:fs";
import { ROOT } from "./lib.mjs";
const skillPath = new URL("../.pi/skills/jd-analysis/SKILL.md", import.meta.url);
const skill = fs.readFileSync(skillPath, "utf8");
const patched = applyPatch(skill, { section: "## 评分标准", action: "append", content: "- **自测追加行**：不应落盘。" });
assert("真实 SKILL.md 小节定位成功", patched !== null);
assert("补丁只动目标小节", patched.length > skill.length && patched.includes("- **自测追加行**"));
const other = patched.match(/^## 输出模板.*?^```/ms);
assert("其他小节内容保持不变", Boolean(other) && skill.includes(other[0].slice(0, -3).slice(0, 50)));

// 补丁块解析：YAML 风格，多行内容免转义
const PATCH_TEXT = `前置说明文字。

\`\`\`evolve-patch
file: .pi/skills/jd-analysis/SKILL.md
section: ## 评分标准
action: append
content: |
  ### 投递建议分级（必须执行）

  - **高优先**：匹配度 ≥ 80。
  - 含"引号"和【括号】都应原样保留。
  表格 | 也 | 保留
\`\`\`

\`\`\`evolve-patch
file: AGENTS.md
section: ### 工作流 A：JD 解析（P1）
action: replace
content: |
  用户给出 JD → 产出卡片 → 回复带优先级标签的投递建议。
\`\`\`

补丁数：2`;

const parsed = parsePatchBlocks(PATCH_TEXT);
assert("解析出 2 个补丁块", parsed.length === 2);
assert("补丁字段正确", parsed[0].file === ".pi/skills/jd-analysis/SKILL.md"
	&& parsed[0].section === "## 评分标准" && parsed[0].action === "append"
	&& parsed[1].file === "AGENTS.md" && parsed[1].action === "replace");
assert("多行内容免转义保留（含引号/表格）", parsed[0].content.includes("### 投递建议分级（必须执行）")
	&& parsed[0].content.includes('含"引号"和【括号】') && parsed[0].content.includes("表格 | 也 | 保留"));
assert("缩进已去除", !/^ {2}###/.test(parsed[0].content.split("\n")[0]));
assert("含全角冒号的 section 完整保留", parsed[1].section === "### 工作流 A：JD 解析（P1）");

// 围栏感知：模板代码块内的示例标题不作为定位目标
const FENCED = `## 输出模板

\`\`\`markdown
## 投递建议
<占位符>
\`\`\`

## 投递建议
真实小节内容
`;
const fencedRange = findSectionRange(FENCED.split("\n"), "## 投递建议");
const fencedLines = FENCED.split("\n");
const realIdx = fencedLines.findIndex((l, i) => l.trim() === "## 投递建议" && i > 4);
assert("跳过围栏内示例标题，定位到真实小节", fencedRange && fencedRange.idx === realIdx);
const onlyFenced = "## 模板\n\n```markdown\n## 仅在围栏内\n```\n";
assert("标题只存在于围栏内时返回 null", findSectionRange(onlyFenced.split("\n"), "## 仅在围栏内") === null);

console.log(failed === 0 ? "\n自测全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
