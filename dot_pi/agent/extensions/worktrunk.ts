import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const WORKTRUNK_TOOL_NAMES = new Set(["wt_list", "wt_switch", "wt_remove", "wt_merge"]);

function appendOption(args: string[], enabled: unknown, ...values: Array<string | undefined>): void {
	if (enabled) args.push(...values.filter((value): value is string => value !== undefined));
}

async function confirmMutation(ctx: { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } }, title: string, message: string): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return ctx.ui.confirm(title, message);
}

async function runWt(
	pi: ExtensionAPI,
	args: string[],
	ctx: { cwd: string; signal?: AbortSignal },
	cwd?: string,
) {
	const result = await pi.exec("wt", args, {
		cwd: cwd || ctx.cwd,
		signal: ctx.signal,
		timeout: 120_000,
	});

	const output = [
		result.stdout?.trim() ? result.stdout.trimEnd() : undefined,
		result.stderr?.trim() ? `[stderr]\n${result.stderr.trimEnd()}` : undefined,
	]
		.filter(Boolean)
		.join("\n\n");

	const text = output || `(no output; exit ${result.code})`;
	const truncation = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});

	let content = truncation.content;
	let fullOutputPath: string | undefined;
	if (truncation.truncated) {
		const dir = await mkdtemp(join(tmpdir(), "pi-wt-"));
		fullOutputPath = join(dir, "output.txt");
		await writeFile(fullOutputPath, text, "utf8");
		content += `\n\n[Output truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
	}

	return {
		content: [{ type: "text" as const, text: content }],
		details: {
			command: ["wt", ...args],
			cwd: cwd || ctx.cwd,
			exitCode: result.code,
			killed: result.killed,
			truncation: truncation.truncated ? truncation : undefined,
			fullOutputPath,
		},
	};
}

export default function worktrunkExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "wt_list",
		label: "Worktrunk List",
		description: "List Worktrunk git worktrees/status using `wt list --format json`. Output is truncated if very large.",
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "Repository/worktree directory. Defaults to Pi cwd." })),
			branches: Type.Optional(Type.Boolean({ description: "Include local branches without worktrees." })),
			remotes: Type.Optional(Type.Boolean({ description: "Include remote branches." })),
			full: Type.Optional(Type.Boolean({ description: "Include CI and LLM summary columns; may use network/model depending on Worktrunk config." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const args = ["list", "--format", "json"];
			if (params.branches) args.push("--branches");
			if (params.remotes) args.push("--remotes");
			if (params.full) args.push("--full");
			return runWt(pi, args, ctx, params.cwd);
		},
	});

	pi.registerTool({
		name: "wt_switch",
		label: "Worktrunk Switch",
		description: "Create or select a Worktrunk worktree with `wt switch --format json --no-cd`. Pi's cwd is not changed; use the returned worktree path for later tool calls.",
		parameters: Type.Object({
			branch: Type.String({ description: "Branch, shortcut (^, @, -), pr:N, mr:N, PR/MR URL, or worktree path. Required; no interactive picker." }),
			cwd: Type.Optional(Type.String({ description: "Repository/worktree directory. Defaults to Pi cwd." })),
			create: Type.Optional(Type.Boolean({ description: "Create a new branch/worktree (`--create`)." })),
			base: Type.Optional(Type.String({ description: "Base branch/shortcut when creating (`--base`)." })),
			noHooks: Type.Optional(Type.Boolean({ description: "Skip Worktrunk hooks. Default false." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const args = ["switch", "--format", "json", "--no-cd"];
			appendOption(args, params.create, "--create");
			appendOption(args, params.base, "--base", params.base);
			appendOption(args, params.noHooks, "--no-hooks");
			args.push(params.branch);
			const switched = await runWt(pi, args, ctx, params.cwd);
			if (switched.details.exitCode !== 0) return switched;
			const copied = await runWt(pi, ["step", "copy-ignored", "--to", params.branch, "--require-include", "--format", "json"], ctx, params.cwd);
			return { content: [...switched.content, ...copied.content], details: { switch: switched.details, copyIgnored: copied.details } };
		},
	});

	pi.registerTool({
		name: "wt_remove",
		label: "Worktrunk Remove",
		description: "Remove a Worktrunk worktree/branch with `wt remove`. Mutating; use only when the user explicitly asks. Confirms in UI when available.",
		parameters: Type.Object({
			target: Type.String({ description: "Branch or worktree path to remove. Required; never defaults to current." }),
			cwd: Type.Optional(Type.String({ description: "Repository/worktree directory. Defaults to Pi cwd." })),
			force: Type.Optional(Type.Boolean({ description: "Remove dirty worktree (`--force`)." })),
			forceDelete: Type.Optional(Type.Boolean({ description: "Delete unmerged branch (`--force-delete`)." })),
			noDeleteBranch: Type.Optional(Type.Boolean({ description: "Keep branch (`--no-delete-branch`)." })),
			noHooks: Type.Optional(Type.Boolean({ description: "Skip Worktrunk hooks." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!(await confirmMutation(ctx, "Remove Worktrunk worktree?", `wt remove ${params.target}`))) return { content: [{ type: "text", text: "Cancelled by user." }], details: { cancelled: true } };
			const args = ["remove", "--format", "json", "--foreground"];
			appendOption(args, params.force, "--force");
			appendOption(args, params.forceDelete, "--force-delete");
			appendOption(args, params.noDeleteBranch, "--no-delete-branch");
			appendOption(args, params.noHooks, "--no-hooks");
			args.push(params.target);
			return runWt(pi, args, ctx, params.cwd);
		},
	});

	pi.registerTool({
		name: "wt_merge",
		label: "Worktrunk Merge",
		description: "Merge current Worktrunk branch into target using `wt merge`. Mutating; use only when explicitly requested. Confirms in UI when available.",
		parameters: Type.Object({
			target: Type.Optional(Type.String({ description: "Target branch. Defaults to Worktrunk default branch." })),
			cwd: Type.Optional(Type.String({ description: "Current branch/worktree directory to merge from. Defaults to Pi cwd." })),
			noSquash: Type.Optional(Type.Boolean({ description: "Skip squashing (`--no-squash`)." })),
			noCommit: Type.Optional(Type.Boolean({ description: "Skip commit/squash (`--no-commit`)." })),
			noRebase: Type.Optional(Type.Boolean({ description: "Skip rebase (`--no-rebase`)." })),
			noRemove: Type.Optional(Type.Boolean({ description: "Keep worktree after merge (`--no-remove`)." })),
			noFf: Type.Optional(Type.Boolean({ description: "Create merge commit (`--no-ff`)." })),
			stage: Type.Optional(StringEnum(["all", "tracked", "none"] as const, { description: "What to stage before committing." })),
			noHooks: Type.Optional(Type.Boolean({ description: "Skip Worktrunk hooks." })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!(await confirmMutation(ctx, "Merge Worktrunk branch?", `wt merge ${params.target ?? "<default>"}`))) return { content: [{ type: "text", text: "Cancelled by user." }], details: { cancelled: true } };
			const args = ["merge", "--format", "json"];
			appendOption(args, params.noSquash, "--no-squash");
			appendOption(args, params.noCommit, "--no-commit");
			appendOption(args, params.noRebase, "--no-rebase");
			appendOption(args, params.noRemove, "--no-remove");
			appendOption(args, params.noFf, "--no-ff");
			appendOption(args, params.stage, "--stage", params.stage);
			appendOption(args, params.noHooks, "--no-hooks");
			appendOption(args, params.target, params.target);
			return runWt(pi, args, ctx, params.cwd);
		},
	});

	pi.registerTool({
		name: "worktrunk_tools",
		label: "Worktrunk Tools",
		description: "Search and enable Worktrunk tools for git worktree/workspace operations.",
		promptSnippet: "Search and enable Worktrunk tools for git worktree/workspace operations",
		promptGuidelines: [
			"Use worktrunk_tools when the user mentions Worktrunk, wt, worktrees, workspaces, branch workspaces, switching worktrees, creating worktrees, removing worktrees, or merging worktrunk branches.",
			"After wt_switch, remember Pi's cwd does not change automatically; use the returned worktree path as cwd for later file and command tools.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Capability to search for, e.g. list worktrees, create worktree, remove workspace." }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		}),
		async execute(_id, params) {
			const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
			const matches = pi.getAllTools()
				.filter((tool) => WORKTRUNK_TOOL_NAMES.has(tool.name))
				.map((tool) => {
					const haystack = `${tool.name} ${tool.description}`.toLowerCase();
					return { name: tool.name, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) };
				})
				.filter((match) => match.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, params.limit ?? 4)
				.map((match) => match.name);

			const names = matches.length > 0 ? matches : [...WORKTRUNK_TOOL_NAMES];
			const active = pi.getActiveTools();
			const added = names.filter((name) => !active.includes(name));
			pi.setActiveTools([...new Set([...active, ...added])]);

			return {
				content: [{ type: "text", text: added.length ? `Loaded Worktrunk tools: ${added.join(", ")}` : `Worktrunk tools already active: ${names.join(", ")}` }],
				details: { matches: names, added },
			};
		},
	});

	pi.on("session_start", () => {
		const active = pi.getActiveTools().filter((name) => !WORKTRUNK_TOOL_NAMES.has(name));
		pi.setActiveTools([...new Set([...active, "worktrunk_tools"])]);
	});
}
