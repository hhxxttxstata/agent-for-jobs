# 秋招求职 Agent —— 需求文档

> 版本：v0.1（MVP） · 日期：2026-09-05 · 运行框架：[pi](https://pi.dev)（`@earendil-works/pi-coding-agent`） · 模型：GLM（glm-5.3-flash，智谱 openai-compatible 接入）

---

## 1. 业务需求

### 1.1 背景

秋招季（每年 7 月—11 月）应届生要在 2—3 个月内处理上百条招聘信息、准备数十场笔试面试。信息分散在牛客、Boss 直聘、公司官网、招聘群，决策与产出（改简历、面试准备）全靠人肉驱动，导致三个反复出现的真实痛点：

| 编号 | 痛点 | 具体表现 | 代价 |
|---|---|---|---|
| P1 | **JD 信息过载** | 一条 JD 几百到上千字，宣传文案淹没关键信息；几十条 JD 之间无法横向比较，"值不值得投"全凭感觉 | 错过匹配岗位 / 浪费时间投低匹配岗位 |
| P2 | **多版本简历来回改** | 每投一家都要按 JD 调整简历；Word/LaTeX 多版本散落各处，改了什么、为什么改无从追溯 | 重复劳动；好版本被坏版本覆盖；经验无法沉淀 |
| P3 | **面试复盘流失** | 面试后回忆散落在聊天记录与脑子里，没有沉淀成题库；高频问题、自己的薄弱点没有结构化记录 | 同样的坑反复踩；下一轮面试准备从零开始 |

### 1.2 目标用户

- **主要用户**：2026/2027 届参加秋招的应届生（本仓库第一用户即仓库所有者：AI 图像算法 / AI 应用部署方向）。
- **典型场景**：白天收集到一批 JD → 晚上批量解析、决定投递顺序 → 投递前 10 分钟生成定制简历 → 面试当晚花 10 分钟口述回忆 → 系统自动沉淀题库。

### 1.3 用户故事与能力映射

| 用户故事 | 对应能力 |
|---|---|
| US-1 作为求职者，我粘贴一段 JD，就能得到一张结构化卡片（硬性要求/加分项/红线/薪资/流程），好让我 1 分钟内判断要不要投 | F1 JD 解析与匹配 |
| US-2 作为求职者，我想看到这份 JD 与我的简历的匹配度和差距清单，以及应对建议，好让我决定投入多少精力准备 | F1 JD 解析与匹配 |
| US-3 作为求职者，我选定一个 JD 后，能基于我的主简历一键生成定制版简历，且每一处修改都有理由说明，好让我放心地投出去 | F2 简历定制 |
| US-4 作为求职者，我的所有简历版本集中管理、可追溯，好让我面试前快速回忆"这家公司我写了什么" | F2 简历定制 |
| US-5 作为求职者，面试结束后我口述一段回忆，就能得到复盘报告：问了什么、我答得如何、更好的答案是什么 | F3 面试复盘 |
| US-6 作为求职者，每次面试的问题自动汇入题库（含出现频率与最佳答案），好让我下一轮准备有的放矢 | F3 面试复盘 |
| US-7 作为求职者，我想随时看到求职漏斗全局（收集了多少、投了多少、面到哪一轮），好让我管理节奏 | F4 求职漏斗看板 |
| US-8 作为 agent 的使用者，我对任务结果打分，agent 根据低分反馈和评测失败自动改进自己的提示词与模板 | F5 评分遥测 + F7 自进化 |

### 1.4 成功指标（MVP 验收口径）

1. 一条 JD 从粘贴到产出结构化卡片，人工介入 ≤ 1 次粘贴；
2. 每份定制简历附带完整 changelog（位置/原文/修改后/理由），零虚构内容；
3. 每场面试产出复盘报告 + 题库增量合并，题库按频率可检索；
4. golden-set 评测断言 100% 通过；evolve 的"补丁 → 回归 → 回滚"路径可实际演练。

---

## 2. 功能需求

### 2.1 F1 JD 解析与匹配（skill：`jd-analysis`）

- **输入**：JD 原文（用户消息粘贴）或本地文件路径；隐式依赖 `data/profile/master-resume.md`。
- **处理**：抽取关键信息 → 对照主简历打分 → 生成差距与应对。
- **输出**：`data/jds/<公司>-<岗位>.md`，结构化卡片，YAML frontmatter（公司/岗位/城市/来源/薪资范围/解析日期/状态/匹配度）+ 固定小节：基本信息、硬性要求、加分项、红线与风险、关键词、匹配度分析（分项打分：技能 40 / 经历 30 / 学历门槛 15 / 方向意向 15）、差距与应对、投递建议。
- **契约**：小节标题固定（供评测断言）；JD 未写明的字段标 `未提及`，**禁止编造**。
- **状态机**：`collected → analyzed → applied → interviewing → offer/rejected`，由用户口头更新或 /pipeline 交互更新。

### 2.2 F2 简历定制（skill：`resume-tailor`）

- **输入**：JD 标识（公司/岗位或 `data/jds/` 文件名）+ `data/profile/master-resume.md`。
- **处理**：按 JD 重排模块顺序、调整措辞与量化侧重、匹配关键词；产出风格遵循 `data/profile/resume-style-guide.md`（F8a，从用户简历模板提炼）；**只重排/改写/侧重，不虚构**任何经历、数据、技能；不删除教育背景。
- **输出**：`data/resumes/<公司>-<岗位>.md`（定制简历，含 frontmatter 指向源 JD 与 master 版本）+ 文内 `## 定制说明` changelog 表格（位置/原文摘要/修改后/理由）；更新 `data/resumes/index.md` 版本索引表。

### 2.3 F3 面试复盘（skill：`interview-review`）

- **输入**：面试回忆文本（口述转写/笔记，允许零散、口语化）+ 公司与轮次信息。
- **处理**：还原问题清单 → 评估我的回答 → 给出改进版答案 → 归纳知识盲区。
- **输出**：`data/reviews/<公司>-<轮次>-<日期>.md`（面试信息、问题清单、表现总结、盲区与补漏计划）；**增量合并** `data/memory/question-bank.md`：语义相同的问题频率 +1 并合并最佳答案，新问题按主题（技术基础/项目深挖/行为面/反问环节）追加。

### 2.4 F4 求职漏斗看板（extension：`pipeline.ts`，命令 `/pipeline`）

- 扫描 `data/jds/*.md` 的 frontmatter 状态字段，渲染漏斗：收集 → 解析 → 投递 → 面试 → offer/挂，含各阶段数量与明细列表。纯文件读取，无副作用。

### 2.5 F5 评分遥测（extension：`telemetry.ts`，命令 `/rate`）

- `/rate <1-5> [备注]`：对刚完成的任务评分，追加写入 `data/telemetry/ratings.jsonl`（时间戳/分数/备注/最近产物线索）。为 F7 提供数据。

### 2.6 F6 评测体系（`evals/`）

- **golden cases**（≥6）：3 个不同形态 JD（高匹配算法岗 / 低匹配后端岗 / 极简边界 JD）、1 个简历定制、1 个面试复盘、1 个结构自检；每个 case 定义 prompt 与对落盘产物的规则断言（文件存在、frontmatter 字段、固定小节标题、关键内容包含）。
- **runner（`evals/run.mjs`）**：以 `pi -p` 子进程执行 case，对产物跑断言，输出记分卡 `evals/reports/<时间戳>.md`；评测前快照、评测后恢复 `data/` 保证幂等；`--dry-run` 不调 API 只验 harness 结构完整性；`--case <id>` 单跑。
- **可测性来源**：所有 skill 输出遵守固定模板 → LLM 自由文本退化为可断言结构。这是本 harness 的核心设计。

### 2.7 F7 自进化（`evals/evolve.mjs`，命令入口 `/evolve` 或 `npm run evolve`）

- **输入**：低分 ratings（≤3 分）+ 最近评测报告中的失败断言。
- **分析**：调用 pi 归纳失败模式，产出针对具体 harness 文件（SKILL.md / AGENTS.md）具体段落的补丁建议，格式为严格的 `evolve-patch` JSON 块。
- **应用（`--apply`）**：备份原文件至 `.pi/backup/<时间戳>/` → 按段落替换应用补丁 → 仅重跑受影响 case 回归 → 全过则保留并记录进化日志 `evals/evolve-log.md`，任一失败则自动回滚并报告。
- **长期记忆**：`data/memory/self-notes.md`（agent 经验笔记，AGENTS.md 引用）与 question-bank.md 一起构成记忆层的进化。

### 2.8 F8 简历风格模板 + 岗位获取（2026-09-06 新增）

- **F8a 风格基准（resume-style-guide）**：`data/profile/resume-style-guide.md` 从用户简历模板（`D:\个人简历网站\实习简历.tex`）提炼：结构骨架、项目条目解剖（`### 项目名（时间）` + 核心技术行 + `**加粗标签**：方案+量化结果`）、语言规范（量化加粗、拒绝空话）。resume-tailor 产出必须遵循；内容红线（不虚构）优先于风格规则。仅描述风格，不做 LaTeX/PDF 排版（PDF 导出由 F9 承接）。
- **F8b 岗位获取（skill：`job-scout`，命令 `/jobs` 或 `npm run jobs`）**：从配置源拉取最新发布岗位 → 关键词过滤（AI/大模型/Agent/算法/医疗等）→ 指纹去重（`data/sources/seen.json`）→ 新条目以 `状态: collected` 落盘 `data/jds/` → 拉取报告落盘 `data/sources/`。源配置 `data/sources/sources.json`：`github-json` 型（xixicc2027 秋招聚合，jsDelivr/raw 双通道）默认启用；`html` 型（公司招聘门户）逐源验证公开可抓后才启用（拼多多/同花顺已验证不可抓，标记待验证禁用）。合规边界见 2.9。手动触发，不做定时任务。

### 2.8b F9 简历 PDF 导出（skill：`resume-pdf`，2026-09-06 新增）

- **管线**：markdown 简历 → 零依赖 Node 脚本 `.pi/skills/resume-pdf/scripts/md2pdf.mjs` 解析并生成 LaTeX → 本机 TeX Live `xelatex` 编译 → `data/resumes/<公司>-<岗位>.pdf`（与 md 同名）。排版与用户参考的 LaTeX 简历完全同源：模板资产（`resume.cls` + 字体等）已复制到 `.pi/skills/resume-pdf/templates/`，不再依赖桌面原目录。
- **默认行为**：剥离 `## 定制说明`（投递版不含 changelog，`--with-notes` 可保留）；头部含证件照（默认 `data/profile/寸照.png`，frontmatter `照片:`/`--photo`/`--no-photo` 可控）；密度 `auto`——先按与参考版一致的 normal 密度编译，超 1 页自动降为 compact（真 10pt + 收紧间距）重排。
- **接线**：resume-tailor 工作流最后一步自动调用（用户只要 markdown 时可跳过）；命令 `/resume-pdf` 或 `npm run resume-pdf`。
- **红线**：PDF 与 md 逐字一致，转换不改写内容；md 中残留 LaTeX 片段按原义直通；md 源文件永不修改；编译失败如实报告。

### 2.8c 历史数据迁移（MyAgent → 本工作区，2026-09-06）

- **来源**：个人知识 Agent（D:\MyAgent，LangGraph + Obsidian vault D:\MYWORLD）的运行 trace、会话日志与求职笔记。迁移脚本 `scripts/migrate-myagent.mjs`（`npm run migrate:myagent`，支持 `--dry-run` / `--rollback` / 分轨道 `--skip-*`），只读源、确定性幂等。
- **三轨道**：① 原始归档 → `data/history/myagent/`（121 trace + 8 session_logs + 14 求职笔记 + memory.db 求职相关 165 条导出，带溯源 README）；② pi 可回放会话 → `~/.pi/agent/sessions/--D--agent-for-jobs--/`（13 个 v3 JSONL、78 轮，按天合成，手机号/邮箱已脱敏；仅 --resume 回放/--export 浏览，不自动进入新会话上下文）；③ 质量标注 → `data/telemetry/ratings.jsonl`（golden 24 用例记 5 分、badcase 5 条记 1 分，note 带【MyAgent 迁移】标记，按原时间插入文件头；两边架构不同，仅作 evolve 历史信号）。
- **明确不做**：知识蒸馏（题库/JD 卡/复盘未迁移，源材料留在归档中，将来可做）、评测回归 case。若将来蒸馏 JD 卡，状态按 analyzed 处理（用户已确认）。
- **验证**：13/13 会话通过 `pi --export` 加载；迁移会话 PII 零残留；`--rollback` 演练可精确回退到未迁移状态；selftest 全过。

### 2.9 合规边界（约束 F8b）

只抓取无需登录的公开 URL；每源单次运行间隔 ≥2s、超时 15s、失败重试 1 次后跳过并如实记录；不绕过任何登录/风控/验证码，不伪造 cookie；无法公开抓取的源保持禁用并注明原因，由用户决定是否人工跟进。

### 2.10 非目标（MVP 明确不做）

- 不自动投递；不做需登录/绕过风控的爬取（岗位获取仅限 F8b 合规边界内的公开源）；
- 不做牛客/实习僧/Boss 等强反爬平台对接（用户手动粘贴 JD 仍是有效补充）；
- 不做定时轮询任务（岗位获取为手动触发）；
- 不做简历排版导出 PDF/LaTeX 的**通用**转换器（MVP 产出 Markdown；后续版本已落地 F9：仅针对本简历模板的 markdown→PDF 导出）；
- 不做多人使用 / Web 服务形态（单机单用户）；
- 不做模拟面试官对话（复盘是事后分析，不是实时陪练）。

---

## 3. 约束与依赖

- 运行环境：Windows 10 + Git Bash + Node ≥ 18（实测 v24）；pi 全局安装。
- 模型：GLM glm-5.3-flash，经 `~/.pi/agent/models.json` 以 `openai-completions` API 接入 `https://open.bigmodel.cn/api/paas/v4`，密钥读环境变量 `ZHIPU_API_KEY`。
- 隐私：`data/` 含真实个人信息，整体不入库（.gitignore 覆盖），仅保留脱敏模板。
- 全部交互与文档使用简体中文。
