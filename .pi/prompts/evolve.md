---
description: 自进化：分析低分评分与评测失败，产出 harness 补丁建议（--apply 才会真正改文件）
---
请执行自进化流程：

1. 用 bash 运行 `node evals/evolve.mjs`（如需真正应用补丁，先向用户展示建议内容，经确认后运行 `node evals/evolve.mjs --apply`）。
2. 读取生成的 evolve 报告（evals/reports/ 下最新的 evolve-*.md），向用户解释：本轮归纳出的失败模式、建议修改哪些文件哪些段落、预期效果。
3. 如果应用了补丁：报告回归验证结果；如果发生回滚，说明回滚原因。
4. 把本轮有价值的经验追加 1 条到 data/memory/self-notes.md。
