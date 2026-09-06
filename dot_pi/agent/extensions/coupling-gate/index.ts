import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  analyzeProject,
  evaluateGate,
  formatReport,
  getGateState,
  type CouplingReport,
  type GateState,
} from "./core.ts";
import { isSourcePath } from "./resolver.ts";

const AUTO_CHECK_TOOL_NAMES = new Set(["edit", "write"]);
const previousStates = new Map<string, GateState>();
const previousFailures = new Map<string, Set<string>>();
const COUPLING_CHECK_PARAMS = Type.Object({
  paths: Type.Optional(
    Type.Array(Type.String({ description: "Relative path to a TS/JS file. Omit to analyze changed files." })),
  ),
});

export default function couplingGate(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nA coupling gate is active after edit and write calls. It measures Ce (local efferent imports), Ca (incoming dependants), named folder crossings, cycles, layer rules, and context cost. Ce must stay at ${20}; context cost must stay at ${2500} lines. The gate follows “do not make legacy coupling worse”: existing debt is measured but only new worsening is reported. If coupling is legitimate, use // coupling-gate:allow for budgets and crossings; cycles and layer rules are never exempt. If a module is superficial, deepen it rather than scattering logic; see the codebase-design skill: deepening, narrow the interface at the seam. Use coupling_check or /coupling for a complete report with named edges.`,
  }));

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !AUTO_CHECK_TOOL_NAMES.has(event.toolName)) return;
    const rawPath = extractToolPath(event.input);
    if (!rawPath || !isSourcePath(rawPath)) return;

    const path = relativePath(ctx.cwd, rawPath);
    const report = analyzeProject(ctx.cwd, [path]);
    const file = report.files.find((entry) => entry.path === path);
    if (!file) return;

    const key = `${report.root}\0${path}`;
    const state = getGateState(report, path);
    const failures = evaluateGate(previousStates.get(key), file, report, file.allowed);
    previousStates.set(key, state);
    const oldFailures = previousFailures.get(key) ?? new Set<string>();
    const newFailures = failures.filter((failure) => !oldFailures.has(failure));
    previousFailures.set(key, new Set(failures));
    if (newFailures.length === 0) return;

    return {
      content: [
        {
          type: "text",
          text: appendReport(event.content, `${formatReport(report)}\n\nCoupling gate suggestions:\n${newFailures.map((failure) => `- ${failure}`).join("\n")}`),
        },
      ],
    };
  });

  pi.registerTool({
    name: "coupling_check",
    label: "Coupling Check",
    description: "Report Ce, Ca, cycles, folder crossings, layer rules, and context cost for changed or explicit TS/JS files.",
    promptSnippet: "Check coupling metrics with Ce 20 and context-cost 2500-line budgets",
    promptGuidelines: [
      "Use coupling_check after implementing or restructuring modules when you need named dependency edges and coupling deltas.",
    ],
    parameters: COUPLING_CHECK_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const paths = params.paths?.map((path) => relativePath(ctx.cwd, path)) ?? (await listChangedPaths(pi, ctx.cwd));
      const supported = [...new Set(paths.filter(isSourcePath))];
      if (supported.length === 0) {
        return {
          content: [{ type: "text", text: "Coupling gate: no supported readable TS/JS files" }],
          details: { reports: [] },
        };
      }

      const report = analyzeProject(ctx.cwd, supported);
      return {
        content: [{ type: "text", text: formatReport(report) }],
        details: toSerializableReport(report),
      };
    },
  });

  pi.registerCommand("coupling", {
    description: "Report coupling for changed TS/JS files or explicit paths",
    handler: async (args, ctx) => {
      const paths = args.trim() ? args.trim().split(/\s+/) : await listChangedPaths(pi, ctx.cwd);
      const supported = [...new Set(paths.map((path) => relativePath(ctx.cwd, path)).filter(isSourcePath))];
      if (supported.length === 0) {
        ctx.ui.notify("no supported changed TS/JS files", "warning");
        return;
      }

      const report = analyzeProject(ctx.cwd, supported);
      ctx.ui.notify(`coupling report ${report.files.length} file(s)`, "info");
    },
  });
}

function extractToolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === "string" ? path.startsWith("@") ? path.slice(1) : path : undefined;
}

function relativePath(cwd: string, path: string): string {
  if (path.startsWith("/")) {
    const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
    return path.startsWith(root) ? path.slice(root.length) : path;
  }
  return path;
}

function appendReport(content: Array<{ type: string; text?: string }>, report: string): string {
  const existing = content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim())
    .filter(Boolean)
    .join("\n\n");
  return existing ? `${existing}\n\n${report}` : report;
}

function toSerializableReport(report: CouplingReport) {
  return {
    root: report.root,
    ceBudget: report.ceBudget,
    contextBudget: report.contextBudget,
    files: report.files,
    edges: report.edges,
    crossEdges: report.crossEdges,
    cycles: report.cycles,
    layerViolations: report.layerViolations,
  };
}

async function listChangedPaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const inside = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") return [];
  const [tracked, untracked] = await Promise.all([
    pi.exec("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB"], { cwd }),
    pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd }),
  ]);
  return [...tracked.stdout.split(/\r?\n/), ...untracked.stdout.split(/\r?\n/)].map((line) => line.trim()).filter(Boolean);
}
