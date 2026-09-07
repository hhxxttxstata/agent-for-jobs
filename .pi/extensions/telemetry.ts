/**
 * /rate —— 任务评分遥测
 *
 * /rate <1-5> [备注]：对刚完成的任务打分，追加写入 data/telemetry/ratings.jsonl。
 * 评分 ≤3 的记录会被 evals/evolve.mjs 拾取，作为自进化的输入信号。
 */
import * as fs from "fs";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function telemetryExtension(pi: ExtensionAPI) {
	pi.registerCommand("rate", {
		description: "给刚完成的任务评分（1-5，可附备注），驱动自进化",
		getArgumentCompletions: (prefix) => {
			const items = ["1", "2", "3", "4", "5"].map((n) => ({ value: n, label: `${n} 分` }));
			const filtered = items.filter((i) => i.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const m = trimmed.match(/^([1-5])(?:\s+(.*))?$/);
			if (!m) {
				ctx.ui.notify("用法：/rate <1-5> [备注]，例如 /rate 3 匹配度打分偏高", "warning");
				return;
			}
			const score = Number(m[1]);
			const note = (m[2] ?? "").trim();

			const dir = path.join(process.cwd(), "data", "telemetry");
			fs.mkdirSync(dir, { recursive: true });
			const record = {
				time: new Date().toISOString(),
				score,
				note,
			};
			fs.appendFileSync(
				path.join(dir, "ratings.jsonl"),
				JSON.stringify(record, null, 0) + "\n",
				"utf8",
			);

			const hint = score <= 3
				? "已记录。这条低分反馈会被 /evolve 流程分析，用于改进技能提示词与模板。"
				: "已记录，谢谢反馈！";
			ctx.ui.notify(`评分 ${score} 分已写入 data/telemetry/ratings.jsonl。${hint}`, "info");
		},
	});
}
