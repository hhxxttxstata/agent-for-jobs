/**
 * evals 公共库：pi 子进程调用与工具函数
 * 被 run.mjs（评测）与 evolve.mjs（自进化）共享。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MODEL = process.env.PI_EVAL_MODEL || "zhipu/glm-5.3-flash";

/** 找到全局安装的 pi 入口 JS（跨平台、避免 Windows .cmd shim 问题） */
export function findPiJs() {
	const res = spawnSync(process.platform === "win32" ? "npm root -g" : "npm", process.platform === "win32" ? undefined : ["root", "-g"], {
		encoding: "utf8",
		shell: process.platform === "win32",
	});
	if (res.status !== 0) throw new Error("npm root -g 执行失败");
	const globalRoot = res.stdout.trim().split(/\r?\n/).pop();
	const candidates = [
		path.join(globalRoot, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
		path.join(globalRoot, "@earendil-works", "pi-coding-agent", "dist", "index.js"),
	];
	for (const p of candidates) if (fs.existsSync(p)) return p;
	throw new Error(
		"找不到 pi 安装位置。请先执行: npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
	);
}

/**
 * 以 print 模式运行 pi（cwd=项目根，加载项目 AGENTS.md/skills/extensions，-a 信任项目文件）
 * @returns {{ ok: boolean, stdout: string, stderr: string, status: number|null }}
 */
export function runPi(prompt, { timeoutMs = 300000, model = DEFAULT_MODEL } = {}) {
	const piJs = findPiJs();
	const res = spawnSync(
		process.execPath,
		[piJs, "-p", prompt, "--model", model, "--no-session", "-a"],
		{ cwd: ROOT, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env },
	);
	const ok = res.status === 0 && !(res.stdout || "").includes("No models available");
	return {
		ok,
		stdout: (res.stdout || "").trim(),
		stderr: ((res.stderr || "").trim() + (res.error ? `\n${res.error.message}` : "")).trim(),
		status: res.status,
	};
}

export function timestamp() {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function readIfExists(file) {
	const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
	return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

/** 递归复制目录（覆盖目标） */
export function copyDir(src, dest) {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name);
		const d = path.join(dest, entry.name);
		if (entry.isDirectory()) copyDir(s, d);
		else fs.copyFileSync(s, d);
	}
}
