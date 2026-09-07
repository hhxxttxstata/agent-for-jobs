---
description: 获取最新发布岗位：运行 job-scout 拉取脚本，汇报新岗位与优先级建议
---
请使用 job-scout 技能获取最新岗位信息：

1. 运行 `node .pi/skills/job-scout/scripts/fetch-jobs.mjs`，读取生成的拉取报告。
2. 向我汇报新岗位清单（公司｜岗位｜批次/届别｜城市｜截止），按与我的背景（AI 应用/Agent/医疗影像方向）的相关性排序，标出建议优先做 jd-analysis 的条目。
3. 如果没有新岗位，直接告诉我各源状态即可，不用展开旧岗位。

$ARGUMENTS
