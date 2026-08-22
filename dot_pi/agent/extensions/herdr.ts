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

const HERDR_TOOL_NAMES = new Set([
	"herdr_state",
	"herdr_tab_create",
	"herdr_pane_split",
	"herdr_pane_read",
	"herdr_pane_run",
	"herdr_pane_wait_output",
	"herdr_pi_start",
	"herdr_agent_prompt",
	"herdr_agent_read",
	"herdr_agent_wait",
	"herdr_agent_send_keys",
]);

const PaneSource = StringEnum(["visible", "recent", "recent-unwrapped"] as const);
const AgentSource = StringEnum(["visible", "recent", "recent-unwrapped", "detection"] as const);
const TextFormat = StringEnum(["text", "ansi"] as const);
const Direction = StringEnum(["right", "down"] as const);
const AgentStatus = StringEnum(["idle", "done", "blocked", "unknown", "working"] as const);
const PiStartWhere = StringEnum(["pane", "tab"] as const);

function herdrEnv() {
	return process.env.HERDR_ENV === "1";
}

function requireHerdr() {
	if (!herdrEnv()) {
		throw new Error("Not running inside Herdr (HERDR_ENV != 1). Start Pi from a Herdr-managed pane first.");
	}
}

async function runHerdrRaw(
	pi: ExtensionAPI,
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
) {
	requireHerdr();
	return pi.exec("herdr", args, {
		cwd: options.cwd,
		signal: options.signal,
		timeout: 300_000,
	});
}

async function formatHerdrResult(
	command: string[],
	cwd: string,
	result: Awaited<ReturnType<ExtensionAPI["exec"]>>,
) {
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
		const dir = await mkdtemp(join(tmpdir(), "pi-herdr-"));
		fullOutputPath = join(dir, "output.txt");
		await writeFile(fullOutputPath, text, "utf8");
		content += `\n\n[Output truncated: showing ${truncation.outputLines}/${truncation.totalLines} lines (${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). Full output: ${fullOutputPath}]`;
	}

	let json: unknown;
	try {
		json = result.stdout?.trim() ? JSON.parse(result.stdout) : undefined;
	} catch {
		json = undefined;
	}

	return {
		content: [{ type: "text" as const, text: content }],
		details: {
			command: ["herdr", ...command],
			cwd,
			exitCode: result.code,
			killed: result.killed,
			json,
			truncation: truncation.truncated ? truncation : undefined,
			fullOutputPath,
		},
	};
}

async function runHerdr(
	pi: ExtensionAPI,
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
) {
	const result = await runHerdrRaw(pi, args, options);
	return formatHerdrResult(args, options.cwd, result);
}

function parseJson(stdout: string): any {
	return JSON.parse(stdout.trim());
}

function currentWorkspace() {
	return process.env.HERDR_WORKSPACE_ID;
}

function currentPane() {
	return process.env.HERDR_PANE_ID;
}

function addFocus(args: string[], focus?: boolean) {
	args.push(focus ? "--focus" : "--no-focus");
}

export default function herdrExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "herdr_state",
		label: "Herdr State",
		description: "Inspect current Herdr workspaces, tabs, panes, current pane, and live agents. Requires HERDR_ENV=1.",
		parameters: Type.Object({
			workspaceId: Type.Optional(Type.String({ description: "Workspace to inspect. Defaults to current HERDR_WORKSPACE_ID." })),
			cwd: Type.Optional(Type.String({ description: "Command cwd. Defaults to Pi cwd." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			requireHerdr();
			const cwd = params.cwd || ctx.cwd;
			const workspaceId = params.workspaceId || currentWorkspace();
			const commands = [
				["workspace", "list"],
				...(workspaceId ? [["tab", "list", "--workspace", workspaceId]] : []),
				["pane", "current", "--current"],
				...(workspaceId ? [["pane", "list", "--workspace", workspaceId]] : []),
				["agent", "list"],
			];

			const parts: string[] = [];
			const json: Record<string, unknown> = {
				herdr: {
					workspaceId: currentWorkspace(),
					tabId: process.env.HERDR_TAB_ID,
					paneId: currentPane(),
				},
			};

			for (const args of commands) {
				const result = await runHerdrRaw(pi, args, { cwd, signal });
				const key = args.slice(0, 2).join("_");
				parts.push(`$ herdr ${args.join(" ")}\n${result.stdout.trimEnd()}${result.stderr.trim() ? `\n[stderr]\n${result.stderr.trimEnd()}` : ""}`);
				try {
					json[key] = parseJson(result.stdout);
				} catch {
					json[key] = result.stdout;
				}
			}

			return {
				content: [{ type: "text" as const, text: parts.join("\n\n") }],
				details: { cwd, json },
			};
		},
	});

	pi.registerTool({
		name: "herdr_tab_create",
		label: "Herdr Tab Create",
		description: "Create a Herdr tab in the current or specified workspace. Defaults to --no-focus.",
		parameters: Type.Object({
			workspaceId: Type.Optional(Type.String({ description: "Workspace ID. Defaults to current HERDR_WORKSPACE_ID." })),
			label: Type.Optional(Type.String({ description: "Tab label." })),
			cwd: Type.Optional(Type.String({ description: "Initial cwd for tab root pane. Defaults to Pi cwd." })),
			focus: Type.Optional(Type.Boolean({ description: "Focus created tab. Default false." })),
			env: Type.Optional(Type.Array(Type.String(), { description: "Environment entries KEY=VALUE." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["tab", "create"];
			if (params.workspaceId || currentWorkspace()) args.push("--workspace", params.workspaceId || currentWorkspace()!);
			if (params.cwd || ctx.cwd) args.push("--cwd", params.cwd || ctx.cwd);
			if (params.label) args.push("--label", params.label);
			for (const entry of params.env ?? []) args.push("--env", entry);
			addFocus(args, params.focus === true);
			return runHerdr(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "herdr_pane_split",
		label: "Herdr Pane Split",
		description: "Split a Herdr pane. Defaults to current pane, same cwd, and --no-focus.",
		parameters: Type.Object({
			direction: Direction,
			paneId: Type.Optional(Type.String({ description: "Pane to split. Defaults to --current." })),
			cwd: Type.Optional(Type.String({ description: "Initial cwd for new pane. Defaults to Pi cwd." })),
			ratio: Type.Optional(Type.Number({ description: "Split ratio." })),
			focus: Type.Optional(Type.Boolean({ description: "Focus new pane. Default false." })),
			env: Type.Optional(Type.Array(Type.String(), { description: "Environment entries KEY=VALUE." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["pane", "split"];
			if (params.paneId) args.push("--pane", params.paneId);
			else args.push("--current");
			args.push("--direction", params.direction);
			args.push("--cwd", params.cwd || ctx.cwd);
			if (params.ratio !== undefined) args.push("--ratio", `${params.ratio}`);
			for (const entry of params.env ?? []) args.push("--env", entry);
			addFocus(args, params.focus === true);
			return runHerdr(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "herdr_pane_read",
		label: "Herdr Pane Read",
		description: "Read Herdr pane output. Prefer source=recent-unwrapped for logs/transcripts.",
		parameters: Type.Object({
			paneId: Type.String({ description: "Pane ID to read." }),
			source: Type.Optional(PaneSource),
			lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "Rows to read. Default 120." })),
			format: Type.Optional(TextFormat),
			cwd: Type.Optional(Type.String({ description: "Command cwd. Defaults to Pi cwd." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["pane", "read", params.paneId, "--source", params.source || "recent-unwrapped", "--lines", `${params.lines ?? 120}`];
			if (params.format) args.push("--format", params.format);
			return runHerdr(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "herdr_pane_run",
		label: "Herdr Pane Run",
		description: "Run an ordinary shell command in a Herdr pane using `herdr pane run`. The pane should be at an interactive shell prompt.",
		parameters: Type.Object({
			paneId: Type.String({ description: "Pane ID." }),
			command: Type.String({ description: "Shell command text to send and execute." }),
			cwd: Type.Optional(Type.String({ description: "Command cwd for herdr CLI. Defaults to Pi cwd." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runHerdr(pi, ["pane", "run", params.paneId, params.command], { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "herdr_pane_wait_output",
		label: "Herdr Pane Wait Output",
		description: "Wait for literal or regex output in a Herdr pane, then return the command result.",
		parameters: Type.Object({
			paneId: Type.String({ description: "Pane ID." }),
			match: Type.Optional(Type.String({ description: "Literal substring to wait for." })),
			regex: Type.Optional(Type.String({ description: "Rust regex to wait for." })),
			source: Type.Optional(PaneSource),
			lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "Rows to search. Default 120." })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout in ms." })),
			cwd: Type.Optional(Type.String({ description: "Command cwd. Defaults to Pi cwd." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			if (!params.match && !params.regex) throw new Error("herdr_pane_wait_output requires match or regex.");
			const args = ["pane", "wait-output", params.paneId];
			if (params.match) args.push("--match", params.match);
			if (params.regex) args.push("--regex", params.regex);
			args.push("--source", params.source || "recent-unwrapped", "--lines", `${params.lines ?? 120}`);
			if (params.timeoutMs !== undefined) args.push("--timeout", `${params.timeoutMs}`);
			return runHerdr(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "herdr_pi_start",
		label: "Herdr Pi Start",
		description: "Create a Herdr pane or tab and start a Pi agent there with a default model/thinking. Optionally send an initial prompt.",
		parameters: Type.Object({
			name: Type.String({ description: "Unique live Herdr agent name, e.g. reviewer or worker-1. Pattern: [a-z][a-z0-9_-]{0,31}." }),
			where: Type.Optional(PiStartWhere),
			direction: Type.Optional(Direction),
			label: Type.Optional(Type.String({ description: "Tab label when where=tab." })),
			cwd: Type.Optional(Type.String({ description: "Working directory for new pane/tab and Pi. Defaults to Pi cwd." })),
			model: Type.Optional(Type.String({ description: "Pi model pattern. Default openai-codex/gpt-5.5." })),
			thinking: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Pi thinking level. Default high." })),
			tools: Type.Optional(Type.String({ description: "Comma-separated Pi --tools allowlist." })),
			excludeTools: Type.Optional(Type.String({ description: "Comma-separated Pi --exclude-tools denylist." })),
			prompt: Type.Optional(Type.String({ description: "Initial prompt to send after Pi starts." })),
			wait: Type.Optional(Type.Boolean({ description: "Wait for prompt completion. Default true when prompt is set." })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 300000, description: "Agent startup/prompt timeout. Default 120000." })),
			focus: Type.Optional(Type.Boolean({ description: "Focus created pane/tab. Default false." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			requireHerdr();
			const cwd = params.cwd || ctx.cwd;
			const where = params.where || "pane";
			const timeout = params.timeoutMs ?? 120_000;
			let paneId: string;
			let createCommand: string[];
			let createResult: Awaited<ReturnType<ExtensionAPI["exec"]>>;

			if (where === "tab") {
				const args = ["tab", "create", "--cwd", cwd];
				if (currentWorkspace()) args.push("--workspace", currentWorkspace()!);
				if (params.label) args.push("--label", params.label);
				addFocus(args, params.focus === true);
				createCommand = args;
				createResult = await runHerdrRaw(pi, args, { cwd, signal });
				const json = parseJson(createResult.stdout);
				paneId = json?.result?.root_pane?.pane_id;
			} else {
				const args = ["pane", "split", "--current", "--direction", params.direction || "right", "--cwd", cwd];
				addFocus(args, params.focus === true);
				createCommand = args;
				createResult = await runHerdrRaw(pi, args, { cwd, signal });
				const json = parseJson(createResult.stdout);
				paneId = json?.result?.pane?.pane_id;
			}

			if (!paneId) throw new Error(`Could not read created pane id from herdr ${createCommand.join(" ")}`);

			const agentArgs = [
				"agent",
				"start",
				params.name,
				"--kind",
				"pi",
				"--pane",
				paneId,
				"--timeout",
				`${Math.min(timeout, 300_000)}`,
				"--",
				"--model",
				params.model || "openai-codex/gpt-5.5",
				"--thinking",
				params.thinking || "high",
			];
			if (params.tools) agentArgs.push("--tools", params.tools);
			if (params.excludeTools) agentArgs.push("--exclude-tools", params.excludeTools);

			const startResult = await runHerdrRaw(pi, agentArgs, { cwd, signal });

			let promptResult: Awaited<ReturnType<ExtensionAPI["exec"]>> | undefined;
			let promptArgs: string[] | undefined;
			if (params.prompt) {
				promptArgs = ["agent", "prompt", params.name, params.prompt];
				if (params.wait !== false) promptArgs.push("--wait", "--timeout", `${timeout}`);
				promptResult = await runHerdrRaw(pi, promptArgs, { cwd, signal });
			}

			const combinedStdout = [
				`$ herdr ${createCommand.join(" ")}\n${createResult.stdout.trimEnd()}`,
				`$ herdr ${agentArgs.join(" ")}\n${startResult.stdout.trimEnd()}`,
				promptResult && promptArgs ? `$ herdr ${promptArgs.join(" ")}\n${promptResult.stdout.trimEnd()}` : undefined,
			].filter(Boolean).join("\n\n");
			const combinedStderr = [createResult.stderr, startResult.stderr, promptResult?.stderr].filter((s) => s?.trim()).join("\n");

			return formatHerdrResult(
				["pi-start", params.name],
				cwd,
				{
					stdout: combinedStdout,
					stderr: combinedStderr,
					code: promptResult?.code ?? startResult.code ?? createResult.code,
					killed: Boolean(createResult.killed || startResult.killed || promptResult?.killed),
				} as Awaited<ReturnType<ExtensionAPI["exec"]>>,
			);
		},
	});

	pi.registerTool({
		name: "herdr_agent_prompt",
		label: "Herdr Agent Prompt",
		description: "Send a prompt to a named Herdr agent or pane-hosted agent. Use --wait by default.",
		parameters: Type.Object({
			target: Type.String({ description: "Unique agent name or pane ID hosting an agent." }),
			text: Type.String({ description: "Prompt text." }),
			wait: Type.Optional(Type.Boolean({ description: "Wait until settled. Default true." })),
			until: Type.Optional(Type.Array(AgentStatus, { description: "Specific statuses to wait for instead of default settled states." })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout in ms. Default 120000 when waiting." })),
			cwd: Type.Optional(Type.String({ description: "Command cwd. Defaults to Pi cwd." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["agent", "prompt", params.target, params.text];
			if (params.wait !== false) args.push("--wait", "--timeout", `${params.timeoutMs ?? 120_000}`);
			for (const status of params.until ?? []) args.push("--until", status);
			return runHerdr(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "herdr_agent_read",
		label: "Herdr Agent Read",
		description: "Read output from a named Herdr agent or pane-hosted agent.",
		parameters: Type.Object({
			target: Type.String({ description: "Unique agent name or pane ID hosting an agent." }),
			source: Type.Optional(AgentSource),
			lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 5000, description: "Rows to read. Default 120." })),
			format: Type.Optional(TextFormat),
			cwd: Type.Optional(Type.String({ description: "Command cwd. Defaults to Pi cwd." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["agent", "read", params.target, "--source", params.source || "recent-unwrapped", "--lines", `${params.lines ?? 120}`];
			if (params.format) args.push("--format", params.format);
			return runHerdr(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "herdr_agent_wait",
		label: "Herdr Agent Wait",
		description: "Wait for a Herdr agent to settle or reach specific statuses.",
		parameters: Type.Object({
			target: Type.String({ description: "Unique agent name or pane ID hosting an agent." }),
			until: Type.Optional(Type.Array(AgentStatus, { description: "Statuses to wait for. Omit for settled default." })),
			timeoutMs: Type.Optional(Type.Integer({ minimum: 1, description: "Timeout in ms." })),
			cwd: Type.Optional(Type.String({ description: "Command cwd. Defaults to Pi cwd." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const args = ["agent", "wait", params.target];
			for (const status of params.until ?? []) args.push("--until", status);
			if (params.timeoutMs !== undefined) args.push("--timeout", `${params.timeoutMs}`);
			return runHerdr(pi, args, { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "herdr_agent_send_keys",
		label: "Herdr Agent Send Keys",
		description: "Send logical keys to a Herdr agent UI, e.g. esc or ctrl+c. Use only when intentional.",
		parameters: Type.Object({
			target: Type.String({ description: "Unique agent name or pane ID hosting an agent." }),
			keys: Type.Array(Type.String(), { minItems: 1, description: "Logical keys: esc, ctrl+c, return, etc." }),
			cwd: Type.Optional(Type.String({ description: "Command cwd. Defaults to Pi cwd." })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			return runHerdr(pi, ["agent", "send-keys", params.target, ...params.keys], { cwd: params.cwd || ctx.cwd, signal });
		},
	});

	pi.registerTool({
		name: "herdr_tools",
		label: "Herdr Tools",
		description: "Search and enable Herdr terminal workspace/pane/agent tools.",
		promptSnippet: "Search and enable Herdr tools for tabs, panes, pane output, and agent coordination",
		promptGuidelines: [
			"Use herdr_tools only when the user explicitly mentions Herdr or asks to inspect/control tabs, panes, pane output, workspaces, or agents through Herdr.",
			"Use herdr_state first when current Herdr workspace, tab, pane, or agent IDs are unclear.",
			"Use herdr_pi_start when the user wants a new Pi session/agent in another Herdr pane or tab; default model is openai-codex/gpt-5.5 and thinking high unless the user specifies otherwise.",
			"Use herdr_pane_run for ordinary commands in panes; use herdr_agent_prompt/read/wait for recognized coding agents.",
			"Do not use Herdr tools merely because background work could be useful; the user must ask for Herdr or pane/tab/agent control.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Capability to search for, e.g. open tab, split pane, read pane, start pi agent, prompt agent." }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
		}),
		async execute(_id, params) {
			const terms = params.query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
			const matches = pi.getAllTools()
				.filter((tool) => HERDR_TOOL_NAMES.has(tool.name))
				.map((tool) => {
					const haystack = `${tool.name} ${tool.description}`.toLowerCase();
					return { name: tool.name, score: terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0) };
				})
				.filter((match) => match.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, params.limit ?? 6)
				.map((match) => match.name);

			const names = matches.length > 0 ? matches : [...HERDR_TOOL_NAMES];
			const active = pi.getActiveTools();
			const added = names.filter((name) => !active.includes(name));
			pi.setActiveTools([...new Set([...active, ...added])]);

			return {
				content: [{ type: "text", text: added.length ? `Loaded Herdr tools: ${added.join(", ")}` : `Herdr tools already active: ${names.join(", ")}` }],
				details: { matches: names, added, herdrEnv: herdrEnv() },
			};
		},
	});

	pi.on("session_start", () => {
		const active = pi.getActiveTools().filter((name) => !HERDR_TOOL_NAMES.has(name));
		pi.setActiveTools([...new Set([...active, "herdr_tools"])]);
	});
}
