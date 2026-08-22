import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

const GIT_BRANCH_TOOL_NAMES = new Set([
	"git_branch_list",
	"git_branch_create",
	"git_branch_switch",
	"git_branch_rename",
	"git_branch_delete",
]);

async function runGit(
	pi: ExtensionAPI,
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
) {
	const result = await pi.exec("git", args, {
		cwd: options.cwd,
		signal: options.signal,
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
		const dir = await mkdtemp(join(tmpdir(), "pi-git-"));
		fullOutputPath = join(dir, "output.txt");
		await writeFile(fullOutputPath, text, "utf8");
		content += `\n\n[Output truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
	}

	return {
		content: [{ type: "text" as const, text: content }],
		details: {
			command: ["git", ...args],
			cwd: options.cwd,
			exitCode: result.code,
			killed: result.killed,
			truncation: truncation.truncated ? truncation : undefined,
			fullOutputPath,
		},
	};
}

async function confirm(ctx: { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } }, title: string, args: string[]) {
	if (!ctx.hasUI) return true;
	return ctx.ui.confirm(title, ["git", ...args].join(" "));
}

export default function gitBranchesExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "git_branch_list",
		label: "Git Branch List",
		description: "List git branches using `git branch`. Use before branch changes when branch names/status are unclear.",
		parameters: Type.Object({
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			all: Type.Optional(Type.Boolean({ description: "Include local and remote branches (`--all`)." })),
			remotes: Type.Optional(Type.Boolean({ description: "Only remote branches (`--remotes`)." })),
			verbose: Type.Optional(Type.Boolean({ description: "Verbose output with commit/status (`--verbose`). Default true." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["branch", "--no-color"];
			if (params.all) args.push("--all");
			if (params.remotes) args.push("--remotes");
			if (params.verbose !== false) args.push("--verbose");
			return runGit(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "git_branch_create",
		label: "Git Branch Create",
		description: "Create a git branch with `git branch` or `git switch -c`. Mutating; confirms in UI when available.",
		parameters: Type.Object({
			name: Type.String({ description: "New branch name." }),
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			startPoint: Type.Optional(Type.String({ description: "Optional start point: branch, tag, commit, or remote branch." })),
			switchTo: Type.Optional(Type.Boolean({ description: "Create and switch to the branch using `git switch -c`. Default false." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = params.switchTo ? ["switch", "-c", params.name] : ["branch", params.name];
			if (params.startPoint) args.push(params.startPoint);
			if (!(await confirm(ctx, "Create git branch?", args))) {
				return { content: [{ type: "text" as const, text: "Cancelled by user." }], details: { cancelled: true } };
			}
			return runGit(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "git_branch_switch",
		label: "Git Branch Switch",
		description: "Switch branches in the current worktree using `git switch`. Mutating working tree; confirms in UI when available.",
		parameters: Type.Object({
			name: Type.String({ description: "Branch name, remote-tracking branch, tag/commit with detach=true, or '-' for previous branch." }),
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			detach: Type.Optional(Type.Boolean({ description: "Detach HEAD at name (`--detach`)." })),
			force: Type.Optional(Type.Boolean({ description: "Force switch (`--force`). Use only when user explicitly asks to discard local changes." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["switch"];
			if (params.detach) args.push("--detach");
			if (params.force) args.push("--force");
			args.push(params.name);
			if (!(await confirm(ctx, "Switch git branch?", args))) {
				return { content: [{ type: "text" as const, text: "Cancelled by user." }], details: { cancelled: true } };
			}
			return runGit(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "git_branch_rename",
		label: "Git Branch Rename",
		description: "Rename a git branch using `git branch -m` or `-M`. Mutating; confirms in UI when available.",
		parameters: Type.Object({
			newName: Type.String({ description: "New branch name." }),
			oldName: Type.Optional(Type.String({ description: "Existing branch name. Omit to rename current branch." })),
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			force: Type.Optional(Type.Boolean({ description: "Force rename with `-M`." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["branch", params.force ? "-M" : "-m"];
			if (params.oldName) args.push(params.oldName);
			args.push(params.newName);
			if (!(await confirm(ctx, "Rename git branch?", args))) {
				return { content: [{ type: "text" as const, text: "Cancelled by user." }], details: { cancelled: true } };
			}
			return runGit(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "git_branch_delete",
		label: "Git Branch Delete",
		description: "Delete local git branches using `git branch -d` or `-D`. Mutating; confirms in UI when available.",
		parameters: Type.Object({
			names: Type.Array(Type.String(), { minItems: 1, description: "Local branch names to delete." }),
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			force: Type.Optional(Type.Boolean({ description: "Force delete with `-D`. Use only when user explicitly asks to delete unmerged branches." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["branch", params.force ? "-D" : "-d", ...params.names];
			if (!(await confirm(ctx, "Delete git branch?", args))) {
				return { content: [{ type: "text" as const, text: "Cancelled by user." }], details: { cancelled: true } };
			}
			return runGit(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "git_branch_tools",
		label: "Git Branch Tools",
		description: "Search and enable git branch management tools.",
		promptSnippet: "Search and enable git branch tools for creating, switching, renaming, deleting, and listing branches",
		promptGuidelines: [
			"Use git_branch_tools when the user asks to create branches, switch branches, rename branches, delete branches, or list branches with git.",
			"Use git_branch_list before mutating branches when the target branch/status is unclear.",
			"Use git_branch_switch to change branch in the current worktree; Pi's cwd path stays the same but the checkout content changes.",
			"Use Worktrunk tools instead of git_branch_switch when the user says Worktrunk, wt, workspaces, or worktrees.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Capability to search for, e.g. create branch, switch branch, rename branch, delete branch." }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		}),
		async execute(_id, params) {
			const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
			const matches = pi.getAllTools()
				.filter((tool) => GIT_BRANCH_TOOL_NAMES.has(tool.name))
				.map((tool) => {
					const haystack = `${tool.name} ${tool.description}`.toLowerCase();
					return { name: tool.name, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) };
				})
				.filter((match) => match.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, params.limit ?? 5)
				.map((match) => match.name);

			const names = matches.length > 0 ? matches : [...GIT_BRANCH_TOOL_NAMES];
			const active = pi.getActiveTools();
			const added = names.filter((name) => !active.includes(name));
			pi.setActiveTools([...new Set([...active, ...added])]);

			return {
				content: [{ type: "text", text: added.length ? `Loaded git branch tools: ${added.join(", ")}` : `Git branch tools already active: ${names.join(", ")}` }],
				details: { matches: names, added },
			};
		},
	});

	pi.on("session_start", () => {
		const active = pi.getActiveTools().filter((name) => !GIT_BRANCH_TOOL_NAMES.has(name));
		pi.setActiveTools([...new Set([...active, "git_branch_tools"])]);
	});
}
