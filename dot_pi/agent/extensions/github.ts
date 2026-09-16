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
import { cleanupMergedTracker, cleanupMessage, readPullRequestStatus } from "./agent-launcher/github-tracker.ts";

const GH_TOOL_NAMES = new Set(["gh_pr_view", "gh_pr_create", "gh_pr_edit", "gh_pr_ready", "gh_pr_merge", "gh_pr_unblock"]);

type PullRequestEditParams = {
	selector?: string | number;
	repo?: string;
	title?: string;
	body?: string;
	base?: string;
	addLabels?: string[];
	removeLabels?: string[];
	addAssignees?: string[];
	removeAssignees?: string[];
	addReviewers?: string[];
	removeReviewers?: string[];
	milestone?: string;
	removeMilestone?: boolean;
};

const DEFAULT_PR_FIELDS = [
	"number",
	"title",
	"body",
	"state",
	"isDraft",
	"author",
	"assignees",
	"labels",
	"reviewRequests",
	"reviewDecision",
	"mergeable",
	"mergeStateStatus",
	"statusCheckRollup",
	"baseRefName",
	"headRefName",
	"changedFiles",
	"additions",
	"deletions",
	"createdAt",
	"updatedAt",
	"url",
];

async function runGh(
	pi: ExtensionAPI,
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
) {
	const result = await pi.exec("gh", args, {
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
		const dir = await mkdtemp(join(tmpdir(), "pi-gh-"));
		fullOutputPath = join(dir, "output.txt");
		await writeFile(fullOutputPath, text, "utf8");
		content += `\n\n[Output truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
	}

	return {
		content: [{ type: "text" as const, text: content }],
		details: {
			command: ["gh", ...args],
			cwd: options.cwd,
			exitCode: result.code,
			killed: result.killed,
			truncation: truncation.truncated ? truncation : undefined,
			fullOutputPath,
		},
	};
}

function pushRepo(args: string[], repo?: string) {
	if (repo) args.push("--repo", repo);
}

function pushSelector(args: string[], selector?: string | number) {
	if (selector !== undefined && selector !== null && `${selector}`.trim()) args.push(`${selector}`);
}

function pushFlag(args: string[], enabled: boolean | undefined, flag: string): void {
	if (enabled) args.push(flag);
}

async function confirmTrackerCleanup(ctx: { hasUI: boolean; ui: { confirm(title: string, message: string): Promise<boolean> } }, issuePath: string): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return ctx.ui.confirm("Clear merged tracker dependency references?", issuePath);
}

function pushCsvFlag(args: string[], flag: string, values?: string[]) {
	if (!values || values.length === 0) return;
	args.push(flag, values.join(","));
}

function pushValue(args: string[], flag: string, value?: string): void {
	if (value) args.push(flag, value);
}

function hasPullRequestEdit(params: PullRequestEditParams): boolean {
	return [
		params.title,
		params.body !== undefined,
		params.base,
		params.addLabels?.length,
		params.removeLabels?.length,
		params.addAssignees?.length,
		params.removeAssignees?.length,
		params.addReviewers?.length,
		params.removeReviewers?.length,
		params.milestone,
		params.removeMilestone,
	].some(Boolean);
}

async function buildPullRequestEditArgs(params: PullRequestEditParams): Promise<string[]> {
	const args = ["pr", "edit"];
	pushSelector(args, params.selector);
	pushValue(args, "--title", params.title);
	pushValue(args, "--base", params.base);
	if (params.body !== undefined) {
		const dir = await mkdtemp(join(tmpdir(), "pi-gh-pr-body-"));
		const bodyPath = join(dir, "body.md");
		await writeFile(bodyPath, params.body, "utf8");
		args.push("--body-file", bodyPath);
	}
	pushCsvFlag(args, "--add-label", params.addLabels);
	pushCsvFlag(args, "--remove-label", params.removeLabels);
	pushCsvFlag(args, "--add-assignee", params.addAssignees);
	pushCsvFlag(args, "--remove-assignee", params.removeAssignees);
	pushCsvFlag(args, "--add-reviewer", params.addReviewers);
	pushCsvFlag(args, "--remove-reviewer", params.removeReviewers);
	pushValue(args, "--milestone", params.milestone);
	if (params.removeMilestone) args.push("--remove-milestone");
	pushRepo(args, params.repo);
	return args;
}

export default function githubCliExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "gh_pr_view",
		label: "GitHub PR View",
		description: "Read a GitHub pull request via `gh pr view --json`. Can include comments/reviews/files/commits. Output is truncated if very large.",
		parameters: Type.Object({
			selector: Type.Optional(Type.Union([
				Type.String({ description: "PR number, URL, branch, or omitted for current branch PR." }),
				Type.Number(),
			])),
			repo: Type.Optional(Type.String({ description: "Repository in [HOST/]OWNER/REPO format." })),
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			includeComments: Type.Optional(Type.Boolean({ description: "Include PR comments, reviews, latest reviews." })),
			includeFiles: Type.Optional(Type.Boolean({ description: "Include changed files and commits." })),
			fields: Type.Optional(Type.Array(Type.String(), { description: "Override gh JSON fields. Use only valid `gh pr view --json` fields." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const fields = params.fields?.length
				? params.fields
				: [
					...DEFAULT_PR_FIELDS,
					...(params.includeComments ? ["comments", "reviews", "latestReviews"] : []),
					...(params.includeFiles ? ["files", "commits"] : []),
				];
			const args = ["pr", "view"];
			pushSelector(args, params.selector);
			args.push("--json", [...new Set(fields)].join(","));
			pushRepo(args, params.repo);
			return runGh(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "gh_pr_create",
		label: "GitHub PR Create",
		description: "Create a GitHub pull request via `gh pr create`. Can set title/body/base/head/draft/labels/assignees/reviewers. Mutating and may push current branch unless `head` is set; confirms in UI when available.",
		parameters: Type.Object({
			repo: Type.Optional(Type.String({ description: "Repository in [HOST/]OWNER/REPO format." })),
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			title: Type.Optional(Type.String({ description: "PR title. Required unless fill/template is used." })),
			body: Type.Optional(Type.String({ description: "PR body. Written to a temp file and passed with --body-file." })),
			base: Type.Optional(Type.String({ description: "Base branch." })),
			head: Type.Optional(Type.String({ description: "Head branch or owner:branch. Also avoids gh's fork/push prompt behavior." })),
			draft: Type.Optional(Type.Boolean({ description: "Create as draft." })),
			fill: Type.Optional(StringEnum(["normal", "first", "verbose"] as const, { description: "Autofill title/body from commits: normal=--fill, first=--fill-first, verbose=--fill-verbose." })),
			template: Type.Optional(Type.String({ description: "PR template file path." })),
			labels: Type.Optional(Type.Array(Type.String(), { description: "Labels to add." })),
			assignees: Type.Optional(Type.Array(Type.String(), { description: "Assignees. Use @me for yourself." })),
			reviewers: Type.Optional(Type.Array(Type.String(), { description: "Reviewers/teams." })),
			milestone: Type.Optional(Type.String({ description: "Milestone." })),
			projects: Type.Optional(Type.Array(Type.String(), { description: "Projects to add by title. May require `gh auth refresh -s project`." })),
			noMaintainerEdit: Type.Optional(Type.Boolean({ description: "Disable maintainer edits." })),
			dryRun: Type.Optional(Type.Boolean({ description: "Print details instead of creating. May still push git changes according to gh." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!params.title && !params.fill && !params.template) {
				throw new Error("gh_pr_create requires title, fill, or template to avoid interactive gh prompts.");
			}

			const args = ["pr", "create"];
			if (params.title) args.push("--title", params.title);
			if (params.body !== undefined) {
				const dir = await mkdtemp(join(tmpdir(), "pi-gh-pr-create-body-"));
				const path = join(dir, "body.md");
				await writeFile(path, params.body, "utf8");
				args.push("--body-file", path);
			}
			if (params.base) args.push("--base", params.base);
			if (params.head) args.push("--head", params.head);
			if (params.draft) args.push("--draft");
			if (params.fill === "normal") args.push("--fill");
			if (params.fill === "first") args.push("--fill-first");
			if (params.fill === "verbose") args.push("--fill-verbose");
			if (params.template) args.push("--template", params.template);
			pushCsvFlag(args, "--label", params.labels);
			pushCsvFlag(args, "--assignee", params.assignees);
			pushCsvFlag(args, "--reviewer", params.reviewers);
			if (params.milestone) args.push("--milestone", params.milestone);
			if (params.projects) for (const project of params.projects) args.push("--project", project);
			if (params.noMaintainerEdit) args.push("--no-maintainer-edit");
			if (params.dryRun) args.push("--dry-run");
			pushRepo(args, params.repo);

			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Create GitHub PR?", ["gh", ...args].join(" "));
				if (!ok) return { content: [{ type: "text" as const, text: "Cancelled by user." }], details: { cancelled: true } };
			}

			return runGh(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "gh_pr_edit",
		label: "GitHub PR Edit",
		description: "Edit GitHub pull request metadata via `gh pr edit`: title, body, base, labels, assignees, reviewers, milestone. Mutating; confirms in UI when available.",
		parameters: Type.Object({
			selector: Type.Optional(Type.Union([
				Type.String({ description: "PR number, URL, branch, or omitted for current branch PR." }),
				Type.Number(),
			])),
			repo: Type.Optional(Type.String({ description: "Repository in [HOST/]OWNER/REPO format." })),
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			title: Type.Optional(Type.String({ description: "New PR title." })),
			body: Type.Optional(Type.String({ description: "New PR body. Written to a temp file and passed with --body-file." })),
			base: Type.Optional(Type.String({ description: "New base branch." })),
			addLabels: Type.Optional(Type.Array(Type.String(), { description: "Labels to add." })),
			removeLabels: Type.Optional(Type.Array(Type.String(), { description: "Labels to remove." })),
			addAssignees: Type.Optional(Type.Array(Type.String(), { description: "Assignees to add. Use @me for yourself." })),
			removeAssignees: Type.Optional(Type.Array(Type.String(), { description: "Assignees to remove. Use @me for yourself." })),
			addReviewers: Type.Optional(Type.Array(Type.String(), { description: "Reviewers/teams to add." })),
			removeReviewers: Type.Optional(Type.Array(Type.String(), { description: "Reviewers/teams to remove." })),
			milestone: Type.Optional(Type.String({ description: "Milestone to set." })),
			removeMilestone: Type.Optional(Type.Boolean({ description: "Remove milestone." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!hasPullRequestEdit(params)) throw new Error("No PR edits requested.");
			const args = await buildPullRequestEditArgs(params);
			if (ctx.hasUI && !(await ctx.ui.confirm("Edit GitHub PR?", ["gh", ...args].join(" ")))) {
				return { content: [{ type: "text" as const, text: "Cancelled by user." }], details: { cancelled: true } };
			}
			return runGh(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "gh_pr_ready",
		label: "GitHub PR Ready/Draft",
		description: "Mark a GitHub pull request ready for review or convert it to draft via `gh pr ready` / `gh pr ready --undo`. Mutating; confirms in UI when available.",
		parameters: Type.Object({
			selector: Type.Optional(Type.Union([
				Type.String({ description: "PR number, URL, branch, or omitted for current branch PR." }),
				Type.Number(),
			])),
			repo: Type.Optional(Type.String({ description: "Repository in [HOST/]OWNER/REPO format." })),
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			mode: StringEnum(["ready", "draft"] as const, { description: "Set PR ready for review, or convert back to draft." }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["pr", "ready"];
			pushSelector(args, params.selector);
			if (params.mode === "draft") args.push("--undo");
			pushRepo(args, params.repo);

			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Change PR draft/ready state?", ["gh", ...args].join(" "));
				if (!ok) return { content: [{ type: "text" as const, text: "Cancelled by user." }], details: { cancelled: true } };
			}

			return runGh(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "gh_pr_merge",
		label: "GitHub PR Merge",
		description: "Merge a GitHub pull request and, only after GitHub confirms MERGED, clear its local-tracker dependency references. Mutating; confirms in UI when available.",
		parameters: Type.Object({
			selector: Type.Optional(Type.Union([
				Type.String({ description: "PR number, URL, branch, or omitted for current branch PR." }),
				Type.Number(),
			])),
			repo: Type.Optional(Type.String({ description: "Repository in [HOST/]OWNER/REPO format." })),
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			issuePath: Type.String({ description: "Absolute or cwd-relative completed local-tracker issue path." }),
			method: Type.Optional(StringEnum(["squash", "merge", "rebase"] as const, { description: "Merge method. Defaults to squash." })),
			deleteBranch: Type.Optional(Type.Boolean({ description: "Delete the head branch after merging." })),
			auto: Type.Optional(Type.Boolean({ description: "Enable GitHub auto-merge instead of merging immediately." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const args = ["pr", "merge"];
			pushSelector(args, params.selector);
			args.push(`--${params.method ?? "squash"}`);
			pushFlag(args, params.deleteBranch, "--delete-branch");
			pushFlag(args, params.auto, "--auto");
			pushRepo(args, params.repo);
			if (ctx.hasUI && !(await ctx.ui.confirm("Merge GitHub PR and clear merged tracker dependencies?", ["gh", ...args].join(" ")))) {
				return { content: [{ type: "text" as const, text: "Cancelled by user." }], details: { cancelled: true } };
			}
			const merged = await runGh(pi, args, { cwd: params.cwd || ctx.cwd, signal });
			if (merged.details.exitCode !== 0) return merged;
			const cleanup = await cleanupMergedTracker(pi, { selector: params.selector, repo: params.repo, cwd: params.cwd, issuePath: params.issuePath }, signal, onUpdate, ctx.cwd);
			return { content: [...merged.content, { type: "text" as const, text: cleanupMessage(cleanup) }], details: { merge: merged.details, pullRequest: cleanup.status, tracker: cleanup.cleanup } };
		},
	});

	pi.registerTool({
		name: "gh_pr_unblock",
		label: "Clear Merged Tracker Dependencies",
		description: "Verify a GitHub pull request is MERGED, then clear only its references from downstream local-tracker issues. Open, draft, and unmerged PRs are never modified.",
		parameters: Type.Object({
			selector: Type.Optional(Type.Union([
				Type.String({ description: "PR number, URL, branch, or omitted for current branch PR." }),
				Type.Number(),
			])),
			repo: Type.Optional(Type.String({ description: "Repository in [HOST/]OWNER/REPO format." })),
			cwd: Type.Optional(Type.String({ description: "Git repository cwd. Defaults to Pi cwd." })),
			issuePath: Type.String({ description: "Absolute or cwd-relative completed local-tracker issue path." }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const trackerParams = { selector: params.selector, repo: params.repo, cwd: params.cwd, issuePath: params.issuePath };
			const status = await readPullRequestStatus(pi, trackerParams, signal, ctx.cwd);
			if (status.state !== "MERGED") {
				return { content: [{ type: "text" as const, text: cleanupMessage({ status }) }], details: { pullRequest: status, tracker: undefined } };
			}
			if (!(await confirmTrackerCleanup(ctx, params.issuePath))) {
				return { content: [{ type: "text" as const, text: "Tracker cleanup cancelled by user." }], details: { cancelled: true, pullRequest: status } };
			}
			const verified = await cleanupMergedTracker(pi, trackerParams, signal, onUpdate, ctx.cwd);
			return { content: [{ type: "text" as const, text: cleanupMessage(verified) }], details: { pullRequest: verified.status, tracker: verified.cleanup } };
		},
	});

	pi.registerTool({
		name: "github_tools",
		label: "GitHub Tools",
		description: "Search and enable GitHub CLI PR and merged local-tracker dependency tools.",
		promptSnippet: "Search and enable GitHub CLI PR and merged local-tracker dependency tools",
		promptGuidelines: [
			"Use github_tools when the user asks to read PRs, create PRs, read PR comments/reviews, edit PR metadata, change PR labels/assignees/reviewers, or mark a PR ready/draft with GitHub CLI.",
			"Use gh_pr_view for PR/comment/review reads before falling back to raw bash gh commands.",
			"Use gh_pr_create to create PRs with title/body/base/head/draft/labels/assignees/reviewers; it confirms before execution when UI is available.",
			"Use gh_pr_edit for PR title/body/base/labels/assignees/reviewers/milestone changes; mutating GitHub tools should only run when the user requested the change.",
			"Use gh_pr_ready to mark PRs ready or draft; mutating GitHub tools confirm before execution when UI is available.",
			"Use gh_pr_merge to merge a PR and clear tracker dependencies only after GitHub confirms MERGED.",
			"Use gh_pr_unblock after a PR merged outside Pi; it verifies MERGED before changing local-tracker files and reports changed, skipped, and ambiguous references.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Capability to search for, e.g. create PR, merge PR, clear merged tracker dependencies, read PR comments, add labels, mark draft." }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
		}),
		async execute(_id, params) {
			const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
			const matches = pi.getAllTools()
				.filter((tool) => GH_TOOL_NAMES.has(tool.name))
				.map((tool) => {
					const haystack = `${tool.name} ${tool.description}`.toLowerCase();
					return { name: tool.name, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) };
				})
				.filter((match) => match.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, params.limit ?? 3)
				.map((match) => match.name);

			const names = matches.length > 0 ? matches : [...GH_TOOL_NAMES];
			const active = pi.getActiveTools();
			const added = names.filter((name) => !active.includes(name));
			pi.setActiveTools([...new Set([...active, ...added])]);

			return {
				content: [{ type: "text", text: added.length ? `Loaded GitHub tools: ${added.join(", ")}` : `GitHub tools already active: ${names.join(", ")}` }],
				details: { matches: names, added },
			};
		},
	});

	pi.on("session_start", () => {
		const active = pi.getActiveTools().filter((name) => !GH_TOOL_NAMES.has(name));
		pi.setActiveTools([...new Set([...active, "github_tools"])]);
	});
}
