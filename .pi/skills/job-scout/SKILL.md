---
name: job-scout
description: 获取最新发布的岗位信息。当用户要求"拉岗位 / 看看有没有新岗位 / 更新岗位信息 / jobs / 有什么新发布的招聘"时使用。运行 fetch-jobs.mjs 脚本从配置的源（GitHub 秋招聚合仓库、公司招聘门户）拉取最新岗位，去重后落盘 data/jds/（状态 collected），并向用户汇报新岗位摘要与建议。
---

# 岗位获取（job-scout）

自动化"盯岗位"：从配置源拉取最新发布岗位，过滤 AI/大模型/Agent/医疗方向，新条目进入求职漏斗"收集"阶段。

## 工作流

1. **跑脚本**：bash 执行 `node .pi/skills/job-scout/scripts/fetch-jobs.mjs`（选项：`--source <id>` 只拉单源；`--dry-run` 只报告不落盘）。脚本完成全部确定性工作：拉取、关键词过滤（AI/大模型/Agent/算法/医疗等）、与 `data/sources/seen.json` 指纹去重、新条目写 `data/jds/`（`状态: collected`）、生成拉取报告。
2. **读报告**：读取最新 `data/sources/report-*.md`，掌握本轮结果（各源条目数/新条数/失败源）。
3. **补充正文（如可）**：对带投递链接的新条目，用 bash `curl -sL --max-time 15 <链接>` 尝试抓取 JD 原文；抓到就 append 到对应 `data/jds/` 文件末尾（替换"JD 原文待补充"提示）；抓不到（JS 渲染/需登录）就如实保留提示，不编造。
4. **汇报**：给用户新岗位清单（公司｜岗位｜批次/届别｜城市｜截止），并给优先级建议——与 `data/profile/master-resume.md` 方向明显匹配的（AI 应用/Agent/医疗影像）标记"建议优先 jd-analysis"。岗位多时按相关性排 Top5，其余归一句话带过。
5. **衔接**：用户同意后对高优先条目逐个跑 jd-analysis（会覆盖 collected 文件为正式卡片）。

## 源管理（用户要求加源/修源时）

- 配置文件：`data/sources/sources.json`（`defaultKeywords` 全局关键词、`cohorts` 届别过滤、`sources[]` 各源）。
- 源类型：`github-json`（结构化 JSON，配 `format: xixicc` 解析器；urls 首个为 jsDelivr 镜像、备用 raw.githubusercontent）；`html`（公开页面锚点候选提取，正文由 agent 补）。
- **启用 html 源前必须先验证**：bash `curl -sL --max-time 15 <url> | head -100` 确认岗位数据出现在公开 HTML 里。若列表靠 JS/登录渲染，保持 `enabled: false` 并在 note 写明原因；可建议用户从浏览器 DevTools 找 JSON 接口后按 `github-json` 思路加 api 型源。
- 禁止：绕过登录/风控、伪造 cookie、高频轮询（脚本已限速：单次每源 ≥2s 间隔、15s 超时、重试 1 次）。

## 边界

- 脚本只做确定性工作；涉及理解页面结构、补充 JD 正文、判断相关性的部分由你完成。
- 抓取失败如实汇报失败源与原因，不用旧数据冒充新数据。
- seen.json 记录已报告过的指纹，保证同一岗位只汇报一次；用户想重看可删除对应指纹后重跑。
