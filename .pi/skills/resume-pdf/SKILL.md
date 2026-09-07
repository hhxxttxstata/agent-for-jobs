---
name: resume-pdf
description: 把 markdown 简历渲染成投递版 PDF，排版复刻用户的 LaTeX 参考简历（同一 resume.cls 模板与 Adobe 字体）。当用户要求"转 PDF / 生成 PDF / 导出简历 / 投递版 / 排版"并给出某份简历（data/resumes/ 下的定制版或 data/profile/master-resume.md）时使用。调用 scripts/md2pdf.mjs 完成 markdown → LaTeX → PDF，落盘同名 .pdf。
---

# 简历 PDF 导出（resume-pdf）

解决痛点 P2「简历版本混乱」的最后一环：markdown 是唯一编辑界面，PDF 是唯一投递格式。排版与用户参考的 LaTeX 简历完全同源（复用其 resume.cls + Adobe 中文字体 + 紧凑 preamble，本机 TeX Live xelatex 编译），不用 HTML 近似模拟。

## 工作流

1. **确认输入 md**：默认 `data/resumes/<公司>-<岗位>.md`（或用户指定的任意简历 markdown，如 `data/profile/master-resume.md`）；文件不存在时提示先跑 resume-tailor，中止。
2. **运行转换脚本**（bash）：

   ```
   node .pi/skills/resume-pdf/scripts/md2pdf.mjs "data/resumes/<公司>-<岗位>.md"
   ```

   常用选项：`--no-photo` 头部不放证件照；`--photo <path>` 更换照片（frontmatter `照片:` 字段优先级低于它）；`--with-notes` 保留“定制说明”（仅调试/自读用，投递版不带）；`--density normal|medium|compact` 锁定密度（默认 auto；normal=11pt，medium=11pt+紧凑间距，适合“字大一点且 1 页”的折中，compact=10pt）。
3. **检查脚本输出**：确认 `✓ 已生成 …（N 页）`；投递版应为 **1 页**。auto 密度下脚本先用与参考版一致的 normal 密度，超 1 页自动降为 compact 重排；若 compact 仍超页，脚本会如实警告——此时把"内容偏长"反馈给用户，建议精简内容（转换器不改写内容），不要隐瞒页数。
4. **回复**：PDF 落盘路径 + 页数 + 所用密度（normal/compact）+ 照片与剥离定制说明等关键行为；编译失败时报告错误与保留的构建目录路径。

## 输出约定

- PDF 落盘 `data/resumes/<公司>-<岗位>.pdf`（与 md 同名；`-o` 可另指定）。
- 默认行为：剥离 `## 定制说明` 及其后内容（投递版不含 changelog）；头部含证件照（默认 `data/profile/寸照.png`，缺失时自动降级为无照片头部并提示）。
- markdown 源文件不做任何修改；PDF 是它的纯排版投影。

## 红线

1. **PDF 内容与 md 逐字一致**：转换只做排版，不改写、不增删、不"顺手优化"任何表述。
2. md 中残留的 LaTeX 片段（`\textbf{}`、`\%`、`\_` 等）按原义直通渲染，不做二次转义也不清洗报错。
3. 编译失败必须如实报告（含构建目录路径），禁止假装成功或交付半成品。
4. `## 定制说明` 默认不出现在投递版 PDF 中；用户明确要带说明时才加 `--with-notes`。
