#!/usr/bin/env node
/**
 * md2pdf.mjs —— 把 markdown 简历渲染成 PDF，排版与用户的 LaTeX 参考简历完全同源
 * （复用其 resume.cls + Adobe 中文字体 + 紧凑 preamble，xelatex 编译）。
 *
 * 用法：
 *   node .pi/skills/resume-pdf/scripts/md2pdf.mjs <input.md> [选项]
 *
 * 选项：
 *   -o, --output <path>  输出 PDF 路径（默认与输入同名 .pdf）
 *   --with-notes         保留“定制说明”及之后全部内容（默认剥离 changelog，投递版不含）
 *   --no-photo           头部不放证件照
 *   --photo <path>       指定照片文件；优先级 --photo > frontmatter“照片:” > data/profile/寸照.png
 *   --density <mode>     normal=与参考版同密度（11pt）/ compact=紧凑（真 10pt+收紧间距）/ auto=先 normal，
 *                        超 1 页自动降为 compact 重排（默认 auto）
 *   --keep-build         保留中间构建目录（调试用；编译失败时无论何种情况都会保留并打印路径）
 *
 * 输入约定（与 resume-tailor 产物一致）：
 *   frontmatter（剥离留存）→ `## 个人信息`（姓名/电话/邮箱/求职意向 等列表 → 头部，
 *   “在读院校/本科”两行不进头部，由教育背景小节承载）→ `## 小节` + `### 条目（日期）`
 *   + 加粗标签 bullets；`>` 引用行视为注释不进 PDF。
 *
 * 依赖：本机 TeX Live（xelatex，可用环境变量 XELATEX 指定完整路径）；
 *       模板资产位于 ../templates（resume.cls / *.sty / fonts/），脚本零第三方依赖。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(SCRIPT_DIR, "..", "templates");
const ROOT = (() => {
  let dir = SCRIPT_DIR;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("找不到项目根（未发现 package.json）");
})();

// ---------------------------------------------------------------- CLI ----

function usage() {
  console.log(`用法: node ${path.relative(ROOT, fileURLToPath(import.meta.url))} <input.md> [选项]
  -o, --output <path>  输出 PDF 路径（默认与输入同名 .pdf）
  --density <mode>     auto（默认）/ normal（11pt）/ medium（11pt+紧凑间距）/ compact（10pt）
  --with-notes         保留“定制说明”及之后内容（默认剥离）
  --no-photo           头部不放证件照
  --photo <path>       指定照片文件
  --keep-build         保留中间构建目录`);
}

function parseArgs(argv) {
  const opts = { input: null, output: null, withNotes: false, noPhoto: false, photo: null, keepBuild: false, density: "auto" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { usage(); process.exit(0); }
    else if (a === "-o" || a === "--output") opts.output = argv[++i];
    else if (a === "--with-notes") opts.withNotes = true;
    else if (a === "--no-photo") opts.noPhoto = true;
    else if (a === "--photo") opts.photo = argv[++i];
    else if (a === "--density") {
      opts.density = argv[++i];
      if (!(["auto", "normal", "medium", "compact"].includes(opts.density))) {
        console.error(`错误：--density 只支持 auto | normal | medium | compact，收到 ${opts.density}`);
        process.exit(1);
      }
    }
    else if (a === "--keep-build") opts.keepBuild = true;
    else if (!opts.input) opts.input = a;
    else { console.error(`错误：多余参数 ${a}`); usage(); process.exit(1); }
  }
  if (!opts.input) { usage(); process.exit(1); }
  return opts;
}

// -------------------------------------------------------- markdown 解析 ----

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([^:]+):\s*(.*)$/);
    if (kv) meta[kv[1].trim()] = kv[2].trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

// 解析为 {meta, sections:[{title, blocks}]}；H1 及其前的引用说明忽略。
function parseMarkdown(text) {
  const { meta, body } = parseFrontmatter(text);
  const sections = [];
  let cur = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (/^#\s/.test(line)) continue;
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) { cur = { title: h2[1].trim(), blocks: [] }; sections.push(cur); continue; }
    if (!cur) continue; // H1 前的导语/引用说明
    pushBlock(cur.blocks, line);
  }
  return { meta, sections };
}

function listTarget(blocks) {
  const last = blocks[blocks.length - 1];
  return last && last.type === "entry" ? last.children : blocks;
}

function pushBlock(blocks, line) {
  const t = line.trim();
  if (!t) return;
  if (t.startsWith(">")) return; // 引用说明不进 PDF
  if (/^(-{3,}|\*{3,})$/.test(t)) return; // 分隔线
  const h3 = line.match(/^###\s+(.+)$/);
  if (h3) { blocks.push({ type: "entry", title: h3[1].trim(), children: [] }); return; }
  const li = line.match(/^(\s*)-\s+(.+)$/);
  if (li) {
    const level = Math.floor(li[1].replace(/\t/g, "  ").length / 2);
    const target = listTarget(blocks);
    const last = target[target.length - 1];
    if (last && last.type === "list") last.items.push({ level, text: li[2].trim() });
    else target.push({ type: "list", items: [{ level, text: li[2].trim() }] });
    return;
  }
  const target = listTarget(blocks);
  const last = target[target.length - 1];
  if (last && last.type === "para") last.text += "\n" + t;
  else target.push({ type: "para", text: t });
}

// ---------------------------------------------------------- 行内转换 ----

// markdown 行内 → LaTeX；对主简历可能残留的 \textbf{}/\%/\_ 等直通不二次转义。
const LATEX_SPECIALS = /[\\%&#$_{}]/g;
function latexInline(md) {
  const kept = [];
  let s = md;
  s = s.replace(/\\(?:textbf|textit|texttt|emph|url|href)\{[^{}]*\}/g, (m) => (kept.push(m), `\u0000${kept.length - 1}\u0000`));
  s = s.replace(/\\([%&#$_{}])/g, (m) => (kept.push(m), `\u0000${kept.length - 1}\u0000`));
  s = s.replace(LATEX_SPECIALS, (c) => {
    if (c === "\\") return "\\textbackslash{}";
    return "\\" + c;
  });
  s = s.replace(/~/g, "\\textasciitilde{}").replace(/\^/g, "\\textasciicircum{}");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
  // markdown 行内语法最后套用（内容已转义）
  s = s.replace(/\*\*([^*]+)\*\*/g, "\\textbf{$1}");
  s = s.replace(/`([^`]+)`/g, "\\texttt{$1}");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `\\href{${u}}{${t}}`);
  return s;
}

// 剥离末尾全角/半角括号中的日期，如 “个人数据管理 Agent 系统（2026.03 - 2026.06）”
function splitDate(title) {
  let m = title.match(/（([^（()]+)）\s*$/);
  if (!m) m = title.match(/\s\(([^()]+)\)\s*$/);
  if (!m) return { title: title.trim(), date: "" };
  return { title: title.slice(0, m.index).trim(), date: m[1].trim() };
}

// H3 条目标题：参考版将公司/项目名加粗，遇 “——” 只加粗前半
function entryTitleLatex(rawTitle) {
  const { title } = splitDate(rawTitle);
  const sep = title.includes("——") ? "——" : title.includes(" — ") ? " — " : null;
  if (sep) {
    const idx = title.indexOf(sep);
    return `\\textbf{${latexInline(title.slice(0, idx).trim())}}~${sep.trim()}~${latexInline(title.slice(idx + sep.length).trim())}`;
  }
  return `\\textbf{${latexInline(title)}}`;
}

// ------------------------------------------------------------- 渲染 ----

// 列表项按缩进分组成树，再递归展开为嵌套 itemize（nosep/缩进由 preamble 的 enumitem 控制）
function listTree(items, start, level) {
  const nodes = [];
  let i = start;
  while (i < items.length) {
    if (items[i].level < level) break;
    if (items[i].level === level) {
      const node = { text: items[i].text, children: [] };
      const res = listTree(items, i + 1, level + 1);
      node.children = res.nodes;
      nodes.push(node);
      i = res.next;
    } else { i++; } // 跳级缩进按最近层级处理
  }
  return { nodes, next: i };
}

function emitTree(node) {
  let s = `  \\item ${latexInline(node.text)}\n`;
  if (node.children.length) s += emitGroup(node.children);
  return s;
}

function emitGroup(nodes) {
  let s = "\\begin{itemize}%\n";
  for (const n of nodes) s += emitTree(n);
  s += "\\end{itemize}%\n";
  return s;
}

// 教育背景：顶层条目 → \datedsubsection（对应参考版学校写法），子级 → itemize
function renderEduList(items, out) {
  const { nodes } = listTree(items, 0, 0);
  for (const n of nodes) {
    const { title, date } = splitDate(n.text);
    out.push(`\\datedsubsection{${latexInline(title)}}{${latexInline(date)}}`);
    if (n.children.length) out.push(emitGroup(n.children));
  }
}

function renderBlocks(blocks, out, indentFirstPara = false) {
  let first = true;
  for (const b of blocks) {
    if (b.type === "list") out.push(emitGroup(listTree(b.items, 0, 0).nodes));
    else if (b.type === "para") out.push((indentFirstPara && first ? "\\ " : "") + latexInline(b.text));
    first = false;
  }
}

function renderSection(section, out) {
  out.push(`\\section{${latexInline(section.title)}}`);
  const isEdu = section.title.includes("教育");
  let entryCount = 0;
  for (const b of section.blocks) {
    if (b.type === "entry") {
      const cmd = entryCount === 0 ? "\\datedsubsection" : "\\datedsubsectionOther";
      const { title, date } = splitDate(b.title);
      out.push(`${cmd}{${entryTitleLatex(b.title)}}{${latexInline(date)}}`);
      renderBlocks(b.children, out, true);
      entryCount++;
    } else if (b.type === "list" && isEdu) {
      renderEduList(b.items, out);
    } else {
      renderBlocks([b], out);
    }
  }
}

const HEADER_SKIP_LABELS = new Set(["姓名", "在读院校", "本科", "教育", "教育背景"]);

function renderHeader(doc, opts) {
  const info = doc.sections.find((s) => s.title.includes("个人信息"));
  const items = [];
  for (const b of info ? info.blocks : []) {
    if (b.type !== "list") continue;
    for (const it of b.items) {
      const m = it.text.match(/^(.+?)：([\s\S]*)$/);
      if (m) items.push({ label: m[1].trim(), value: m[2].trim() });
    }
  }
  const name = items.find((i) => i.label === "姓名")?.value || doc.meta["姓名"] || "";
  if (!name) console.warn("警告：个人信息小节未找到“姓名”，头部姓名为空");
  const contacts = items.filter((i) => !HEADER_SKIP_LABELS.has(i.label));
  const photo = resolvePhoto(opts, doc.meta);

  const rows = contacts.map((c) => `        ${latexInline(c.label)}：${latexInline(c.value)} \\\\`);
  let s = "\\begin{minipage}[c]{0.72\\textwidth}\n";
  s += `    {\\Large\\scshape ${latexInline(`姓名：${name}`)}} \\\\[0.6ex]\n`;
  s += "    \\normalsize\n";
  s += "    \\begin{tabular}{@{}l@{}}\n";
  s += rows.join("\n") + "\n";
  s += "    \\end{tabular}\n";
  s += "\\end{minipage}\n";
  if (photo) {
    s += "\\hfill\n";
    s += "\\begin{minipage}[c]{0.24\\textwidth}\n";
    s += "    \\centering\n";
    s += "    \\includegraphics[width=2.1cm]{photo}\n";
    s += "\\end{minipage}\n";
  }
  s += "\\vspace{-0.8ex}\n";
  return s;
}

function resolvePhoto(opts, meta) {
  if (opts.noPhoto) return null;
  const wanted = [];
  if (opts.photo) wanted.push({ p: opts.photo, explicit: true });
  if (meta["照片"]) wanted.push({ p: meta["照片"], explicit: true });
  wanted.push({ p: path.join(ROOT, "data", "profile", "寸照.png"), explicit: false });
  for (const { p, explicit } of wanted) {
    const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
    if (fs.existsSync(abs)) return abs;
    if (explicit) console.warn(`警告：照片 ${p} 不存在，尝试下一候选`);
  }
  if (opts.photo || meta["照片"]) console.warn("警告：所有候选照片均不存在，头部降级为无照片");
  return null;
}

// preamble 逐条复刻参考 .tex（10pt resume 类 + 紧凑标题/列表/段距 + Adobe 中文字体）
const PREAMBLE = String.raw`\documentclass[10pt]{resume}
\usepackage{zh_CN-Adobefonts_external} % Adobe 宋体/黑体/楷体（fonts/zh_CN-Adobe/）
\usepackage{linespacing_fix} % disable extra space before next section
\usepackage{amsmath}
\usepackage{hyperref}
\hypersetup{hidelinks}
\usepackage{graphicx}
\usepackage{geometry}
\geometry{top=0.02in, bottom=0.05in, left=0.58in, right=0.53in}
% tighten sections
\usepackage{titlesec}
\titlespacing*{\section}{0pt}{0.35ex}{0.12ex}
\titlespacing*{\subsection}{0pt}{0.25ex}{0ex}
\usepackage{setspace}
\setstretch{1.0}
% paragraph spacing: slightly larger than line spacing, so blocks breathe
\setlength{\parskip}{2pt}
\setlist[itemize]{nosep, leftmargin=1.1pc, after=\vspace{0.4ex}}
% tighten role spacing from resume.cls
\renewcommand{\role}[2]{{\par \textit{#1} ~ #2 \par}\vspace{0.4ex}}
% manually control section spacing a bit more
\titlespacing*{\section}{0pt}{0.6ex}{0.25ex}
\titlespacing*{\subsection}{0pt}{0.65ex}{0.15ex}
% shrink section headers for density
\titleformat{\section}{\large\scshape\raggedright}{}{0em}{}[\titlerule]
\newcommand{\datedsubsectionOther}[2]{%
  \vspace{3.0ex}\subsection[#1]{#1 \hfill #2}%
}
`;

// compact / medium 密度共用：在 PREAMBLE 之后追加（后写的覆盖先写的）；compact 额外把 resume.cls 的 11pt 改为真 10pt，medium 保持 11pt
const COMPACT_EXTRA = String.raw`\setlength{\parskip}{0pt}
\titlespacing*{\section}{0pt}{0.45ex}{0.2ex}
\titlespacing*{\subsection}{0pt}{0.4ex}{0.1ex}
\setlist[itemize]{nosep, leftmargin=1.1pc}
\renewcommand{\datedsubsectionOther}[2]{%
  \vspace{1.2ex}\subsection[#1]{#1 \hfill #2}%
}
`;

// ------------------------------------------------------------- 编译 ----

function findXelatex() {
  const env = process.env.XELATEX;
  if (env && fs.existsSync(env)) return env;
  const probe = spawnSync("xelatex", ["--version"], { encoding: "utf8", shell: false });
  if (probe.status === 0) return "xelatex";
  for (const drive of ["D", "C"]) {
    const base = path.join(drive + ":", "texlive");
    if (!fs.existsSync(base)) continue;
    for (const year of fs.readdirSync(base).sort().reverse()) {
      const exe = path.join(base, String(year), "bin", "windows", "xelatex.exe");
      if (fs.existsSync(exe)) return exe;
      const exe64 = path.join(base, String(year), "bin", "win64", "xelatex.exe");
      if (fs.existsSync(exe64)) return exe64;
    }
  }
  throw new Error("找不到 xelatex：请确认 TeX Live 已安装，或设置环境变量 XELATEX 指向 xelatex.exe");
}

function copyTemplates(src, dest) {
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(d, { recursive: true });
      copyTemplates(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function compileOnce(preambleTex, bodyTex, photoPath, preset) {
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-pdf-"));
  copyTemplates(TEMPLATES, buildDir);
  if (preset === "compact") {
    const clsPath = path.join(buildDir, "resume.cls");
    const cls = fs.readFileSync(clsPath, "utf8");
    if (!cls.includes("\\LoadClass[11pt]{article}")) {
      console.warn("警告：resume.cls 内容与预期不符，compact 密度的 10pt 未生效");
    }
    fs.writeFileSync(clsPath, cls.replace("\\LoadClass[11pt]{article}", "\\LoadClass[10pt]{article}"), "utf8");
  }
  if (photoPath) fs.copyFileSync(photoPath, path.join(buildDir, "photo" + path.extname(photoPath).toLowerCase()));
  const tex = preambleTex
    + (preset === "normal" ? "" : "\n" + COMPACT_EXTRA)
    + "\n\\begin{document}\n\\pagenumbering{gobble}\n\n" + bodyTex + "\n\\end{document}\n";
  fs.writeFileSync(path.join(buildDir, "main.tex"), tex, "utf8");

  const xelatex = findXelatex();
  process.stdout.write(`→ xelatex 编译中（${path.basename(buildDir)}，${preset}）…\n`);
  const r = spawnSync(xelatex, ["-interaction=nonstopmode", "-halt-on-error", "main.tex"], {
    cwd: buildDir,
    encoding: "utf8",
    timeout: 240000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const pdfPath = path.join(buildDir, "main.pdf");
  if (!fs.existsSync(pdfPath)) {
    const logPath = path.join(buildDir, "main.log");
    if (fs.existsSync(logPath)) {
      const log = fs.readFileSync(logPath, "utf8");
      console.error("—— main.log 末尾 ——\n" + log.slice(-2500));
    }
    const err = new Error(`xelatex 编译失败（exit=${r.status ?? r.error?.code ?? "?"}），构建目录已保留：${buildDir}`);
    err.buildDir = buildDir;
    throw err;
  }
  const log = fs.existsSync(path.join(buildDir, "main.log")) ? fs.readFileSync(path.join(buildDir, "main.log"), "utf8") : "";
  const pages = Number(log.match(/Output written on main\.pdf \((\d+) page/)?.[1] ?? 0);
  return { buildDir, pdfPath, pages, preset };
}

// density=auto：先按与参考版一致的 normal 密度编译，超 1 页则降级 compact 重排
function compile(preambleTex, bodyTex, photoPath, keepBuild, density) {
  const presets = density === "auto" ? ["normal", "compact"] : [density];
  let result = null;
  for (let i = 0; i < presets.length; i++) {
    result = compileOnce(preambleTex, bodyTex, photoPath, presets[i]);
    if (result.pages === 1 || i === presets.length - 1) return result;
    if (!keepBuild) fs.rmSync(result.buildDir, { recursive: true, force: true });
  }
  return result;
}

// ------------------------------------------------------------- 主流程 ----

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let input = path.isAbsolute(opts.input) ? opts.input : path.resolve(process.cwd(), opts.input);
  if (!fs.existsSync(input) && !path.isAbsolute(opts.input)) input = path.join(ROOT, opts.input);
  if (!fs.existsSync(input)) {
    console.error(`错误：找不到输入文件 ${opts.input}`);
    process.exit(1);
  }
  const output = opts.output
    ? (path.isAbsolute(opts.output) ? opts.output : path.join(ROOT, opts.output))
    : input.replace(/\.md$/i, ".pdf");

  const md = fs.readFileSync(input, "utf8");
  const doc = parseMarkdown(md);
  if (!doc.sections.length) {
    console.error("错误：未解析到任何 `## ` 小节，输入似乎不是简历 markdown");
    process.exit(1);
  }

  const out = [renderHeader(doc, opts)];
  for (const s of doc.sections) {
    if (s.title.includes("个人信息")) continue;
    if (!opts.withNotes && s.title.includes("定制说明")) break; // changelog 及之后内容不进投递版
    renderSection(s, out);
  }
  const photo = resolvePhoto(opts, doc.meta);
  const { buildDir, pdfPath, pages, preset } = compile(PREAMBLE, out.join("\n\n"), photo, opts.keepBuild, opts.density);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.copyFileSync(pdfPath, output);
  if (!opts.keepBuild) fs.rmSync(buildDir, { recursive: true, force: true });

  const densityNote = preset === "compact" ? "，紧凑密度" : preset === "medium" ? "，中等密度（11pt+紧凑间距）" : "";
  console.log(`✓ 已生成 ${path.relative(ROOT, output) || output}${pages ? `（${pages} 页${densityNote}）` : ""}`);
  if (pages > 1) console.warn(`注意：${preset} 密度下仍超过 1 页，投递版建议精简内容（转换器不改写内容）`);
}

try {
  main();
} catch (err) {
  console.error(`✗ ${err.message}`);
  if (err.buildDir) console.error(`  可进入该目录查看 main.tex / main.log 排查；修复后重新运行即可。`);
  process.exit(1);
}
