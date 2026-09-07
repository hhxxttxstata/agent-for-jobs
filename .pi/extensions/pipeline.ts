/**
 * /pipeline —— 求职漏斗看板
 *
 * 扫描 data/jds/*.md 的 frontmatter（公司/岗位/状态/匹配度/城市），
 * 渲染漏斗：collected → analyzed → applied → interviewing → offer/rejected。
 * 纯只读，不修改任何文件。体现 harness 原则："文件即数据库"，扩展只做薄薄的视图层。
 */
import * as fs from "fs";
import * as path from "path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STAGE_ORDER = ["collected", "analyzed", "applied", "interviewing", "offer", "rejected"] as const;
const STAGE_LABEL: Record<string, string> = {
	collected: "收集",
	analyzed: "已解析",
	applied: "已投递",
	interviewing: "面试中",
	offer: "offer",
	rejected: "已挂",
};

interface JdCard {
	file: string;
	fields: Record<string, string>;
}

function readField(content: string, field: string): string {
	const m = content.match(new RegExp(`^${field}:\\s*(.*)$`, "m"));
	return m ? m[1].trim() : "";
}

function loadCards(jdsDir: string): JdCard[] {
	if (!fs.existsSync(jdsDir)) return [];
	return fs
		.readdirSync(jdsDir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const content = fs.readFileSync(path.join(jdsDir, f), "utf8");
			return { file: f, fields: {
				公司: readField(content, "公司"),
				岗位: readField(content, "岗位"),
				城市: readField(content, "城市"),
				状态: readField(content, "状态") || "collected",
				匹配度: readField(content, "匹配度"),
				薪资范围: readField(content, "薪资范围"),
			} };
		});
}

export default function pipelineExtension(pi: ExtensionAPI) {
	pi.registerCommand("pipeline", {
		description: "求职漏斗看板：各阶段岗位数量与明细",
		handler: async (_args, ctx) => {
			const jdsDir = path.join(process.cwd(), "data", "jds");
			const cards = loadCards(jdsDir);

			if (cards.length === 0) {
				ctx.ui.notify("data/jds/ 下还没有 JD 卡片。用 /jd <JD 原文> 解析第一份 JD。", "warning");
				return;
			}

			const byStage: Record<string, JdCard[]> = {};
			for (const card of cards) {
				const stage = STAGE_ORDER.includes(card.fields["状态"] as (typeof STAGE_ORDER)[number])
					? card.fields["状态"]
					: "collected";
				(byStage[stage] ??= []).push(card);
			}

			const today = new Date().toISOString().slice(0, 10);
			const lines: string[] = [];
			lines.push(`求职漏斗看板（${today}）  共 ${cards.length} 个岗位`);
			lines.push("");
			lines.push(
				STAGE_ORDER.map((s) => `${STAGE_LABEL[s]} ${byStage[s]?.length ?? 0}`).join(" │ "),
			);
			lines.push("");

			for (const stage of STAGE_ORDER) {
				const group = byStage[stage];
				if (!group || group.length === 0) continue;
				lines.push(`── ${STAGE_LABEL[stage]}（${group.length}）──`);
				group
					.sort((a, b) => Number(b.fields["匹配度"] || 0) - Number(a.fields["匹配度"] || 0))
					.forEach((c) => {
						const parts = [
							`${c.fields["公司"] || "?"}-${c.fields["岗位"] || "?"}`,
							c.fields["匹配度"] ? `匹配度 ${c.fields["匹配度"]}` : "未评分",
						];
						if (c.fields["城市"]) parts.push(c.fields["城市"]);
						if (c.fields["薪资范围"] && c.fields["薪资范围"] !== "未提及") parts.push(c.fields["薪资范围"]);
						lines.push(`  · ${parts.join(" ｜ ")}`);
					});
				lines.push("");
			}

			const applied = (byStage["applied"]?.length ?? 0) + (byStage["interviewing"]?.length ?? 0)
				+ (byStage["offer"]?.length ?? 0) + (byStage["rejected"]?.length ?? 0);
			const offers = byStage["offer"]?.length ?? 0;
			lines.push(`转化：解析 ${cards.length} → 已投递 ${applied} → offer ${offers}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
