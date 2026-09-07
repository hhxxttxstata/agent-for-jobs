# 秋招求职 Agent

基于 [pi](https://pi.dev)（`@earendil-works/pi-coding-agent`）harness 构建的秋招求职 agent，模型为 **GLM（glm-5.3-flash）**。针对秋招三个真实痛点提供一站式工作流：

| 痛点 | 能力 | 入口 |
|---|---|---|
| **P1 JD 信息过载** | JD 一键结构化：硬性要求/加分项/红线/薪资/流程 + 匹配度打分 + 差距应对 | `/jd <JD 原文>` |
| 岗位发现（新增） | 从配置源（GitHub 秋招聚合仓库/公司招聘门户）拉取最新岗位，关键词过滤 + 去重后进漏斗"收集"阶段 | `/jobs` |
| **P2 多版本简历来回改** | 主简历派生定制版（风格效仿本人简历模板），每处修改带理由，版本集中索引 | `/resume <公司/岗位>` |
| **P3 面试复盘流失** | 口述回忆 → 复盘报告 + 高频题库沉淀（频率/最佳答案） | `/review <回忆文本>` |
| 求职节奏管理 | 漏斗看板：收集→解析→投递→面试→offer | `/pipeline` |
| **自进化** | 评分 + 评测失败 → 自动分析 → harness 补丁 → 回归守护 | `/rate <1-5>`、`/evolve` |

## 快速开始

### 1. 安装与模型配置

```bash
# 安装 pi（Node ≥ 18）
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# 配置 GLM：复制 models.example.json 到 ~/.pi/agent/models.json，然后二选一：
# 方式 A（最简单）：把 API Key 明文直接填进 models.json 的 "apiKey" 字段
#   文件位置：C:\Users\<你>\.pi\agent\models.json（用户级目录，不在本仓库内，不会入库）
# 方式 B：用环境变量，models.json 里保持 "apiKey": "$ANTHROPIC_AUTH_TOKEN"
#   Windows: setx ANTHROPIC_AUTH_TOKEN "<你的智谱 API Key>"（设置后需新开终端生效）
# （备选：OpenAI 兼容端点，见 models.example.json 内注释）

# 验证模型接入
pi --list-models glm      # 应看到 zhipu / glm-5.3-flash
```

> 注：pi 内置模型目录中也有同名 glm 模型（zai 等来源）。脚本与命令行中统一使用带 provider 前缀的 `zhipu/glm-5.3-flash`，避免歧义。

### 2. 初始化数据

`data/profile/master-resume.md` 是主简历（唯一事实来源），所有定制简历都从它派生。把自己的简历内容填进去即可，结构参考现有文件（个人信息/教育背景/项目经历/技能清单/荣誉奖项）。

### 3. 开始使用

```bash
cd agent-for-jobs
pi                      # 首次进入会提示信任本项目本地文件（extensions/skills），选择信任
```

然后：

```
/jd <粘贴一段 JD 原文>            → 生成卡片 + 匹配度，落盘 data/jds/
/jobs                              → 拉取最新发布岗位（配置源见 data/sources/sources.json）
/resume 星辰AI 图像算法工程师      → 定制简历 + 修改说明，落盘 data/resumes/
<面试结束后> /review <口述回忆>    → 复盘报告 + 题库沉淀
/pipeline                          → 求职漏斗看板
/rate 4 匹配度打得挺准             → 给任务打分，喂给自进化
```

> 简历定制风格：从 `D:\个人简历网站\实习简历.tex` 提炼的风格规范在 `data/profile/resume-style-guide.md`（项目条目解剖、量化加粗、拒绝空话），生成简历时自动遵循；想调整风格改这个文件即可。

日常对话也可以：直接说"投了星辰AI""明天面云筑科技，帮我准备一下"，agent 会按 `AGENTS.md` 的约定更新状态、输出面试速览。

## 架构：Harness Engineering 的落地

pi 的哲学是**极简内核 + 可进化的外壳**。本项目不写业务代码，全部能力由四层 harness 表达，模型只做推理：

```
┌─────────────────────────────────────────────────────────┐
│  上下文层  AGENTS.md（角色/工作流/约定） + SYSTEM.md（格式）  │
│  能力层    .pi/skills/*/SKILL.md      ← 渐进式加载          │
│            jd-analysis / resume-tailor / interview-review │
│  命令层    .pi/prompts/*.md（/jd /resume /review /evolve） │
│            .pi/extensions/*.ts（/pipeline /rate）          │
│  数据层    data/  ── 文件即数据库，无任何外部服务             │
├─────────────────────────────────────────────────────────┤
│  评测守护  evals/cases（golden set）+ run.mjs（断言引擎）    │
│  自进化    evolve.mjs：信号 → 补丁 → 回归 → 回滚             │
└─────────────────────────────────────────────────────────┘
```

三条核心设计：

1. **输出契约**：每个 skill 定义固定小节模板（frontmatter + 小节标题一字不差）。这让 LLM 的自由文本退化为**可断言结构**——评测体系因此不需要"靠运气"的语义判断，而是规则化的字段/小节断言。
2. **文件即数据库**：JD 卡片、简历版本、复盘、题库全是 `data/` 下的 Markdown；扩展（`/pipeline`）只是薄薄的只读视图层。零外部依赖、零迁移成本、diff 友好。
3. **进化的是 harness，不是模型**：`evolve.mjs` 只修改 AGENTS.md / SKILL.md 的具体小节（白名单 + 标题定位 + 整节替换），每次应用前备份、应用后强制回归相关 golden case，失败自动回滚。模型升级换代不影响这套进化机制。

## 评测体系

```bash
npm run eval        # 全量评测：真实调用 pi + GLM 跑 6 个 golden case
npm run eval:dry    # 结构校验：不调 API，验证 harness 完整性
npm run selftest    # 单元自测（不调 API）：evolve 补丁机制 + 扩展行为（/pipeline /rate）
```

- **golden cases**（`evals/cases/`）：高匹配 JD、低匹配 JD、极简边界 JD、简历定制、面试复盘、一次多 JD。每个 case 定义 prompt + 对落盘产物的规则断言（文件存在、frontmatter 字段、固定小节、关键内容、数量下限）。
- 评测对 `data/` 自动快照/恢复，可反复跑不污染真实数据；报告落盘 `evals/reports/eval-<ts>.md|json`。
- `--judge` 可选追加 LLM-as-Judge 打分（额外 API 调用），作为规则断言之上的质量参考。

## 自进化机制

```
用户 /rate ≤3 分 ─┐
                  ├→ evolve.mjs 收集信号 → pi 归纳失败模式 → evolve-patch（JSON，按小节定位）
评测失败断言 ─────┘                                    │
                                    只分析：npm run evolve（产出建议报告）
                                                       │
                            应用：npm run evolve:apply ─┤ 备份 → 应用 → 回归受影响 case
                                                       ├─ 全过 → 保留 + 记录 evolve-log.md
                                                       └─ 有失败 → 自动回滚 + 记录
```

- 进化对象仅限 `AGENTS.md` 与三个 `SKILL.md`（白名单）；补丁必须定位到**已存在的标题**，小而准。
- 记忆层的进化同步发生：`question-bank.md`（题库随每次复盘增量合并）、`self-notes.md`（agent 经验笔记）。

## 目录说明

```
AGENTS.md / REQUIREMENTS.md    # agent 定义 / 需求文档
models.example.json            # GLM 接入配置样例
.pi/                           # skills、prompts、extensions、SYSTEM.md
data/                          # 运行数据（含真实简历，已 gitignore，不入库）
evals/                         # cases、run.mjs、evolve.mjs、reports、evolve-log.md
```

## 隐私

`data/` 存有真实简历与求职记录，`.gitignore` 已整体排除（仅留目录骨架与模板）；`data/history/`（迁移来的个人会话归档）、`.zcode/`、本地凭据同样不入库。个人信息只写入 `data/`，agent 被明确禁止（AGENTS.md 质量红线）将其写入其他位置。

两点配套设计：

- **评测用例零隐私**：`evals/cases/` 中的姓名/学校写作 `{{name}}` / `{{school}}` 占位符，`run.mjs` 加载时从本机 `data/profile/master-resume.md` 提取替换——仓库里断言的是占位符，本机跑的是真实值。
- **简历 PDF 中文字体不入库**：`.pi/skills/resume-pdf/templates/fonts/zh_CN-Adobe/` 下约 44MB 的 Adobe 中文字体（AdobeSong/Kaiti/Heiti Std）已被 gitignore，克隆后需自行下载放入该目录；西文小字体（TeX Gyre/Fontin/FontAwesome）已随仓库分发。

## 已知边界（MVP）

- 不自动投递、不爬取招聘网站（手动粘贴 JD）；
- 简历产出为 Markdown（导出 PDF/LaTeX 排版是后续版本）；
- 单机单用户，无 Web 服务形态。

更多细节见 `REQUIREMENTS.md`（业务/功能需求）与各 SKILL.md（能力契约）。
