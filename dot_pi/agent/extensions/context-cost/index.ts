import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyzeContextCost, formatReport, isOverBudget, isSupportedPath, type ContextCostReport } from "./core.ts";

const DEFAULT_BUDGET = 2500;
const AUTO_CHECK_TOOL_NAMES = new Set(["edit", "write"]);
const previousTotals = new Map<string, number>();
const CONTEXT_COST_CHECK_PARAMS = Type.Object({
  paths: Type.Optional(
    Type.Array(Type.String({ description: "Relative path to a TS/JS file. Omit to analyze changed files." })),
  ),
});

export default function contextCost(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nA context-cost gate is active. After edit and write tool calls, changed TS/JS files are analyzed: touching a file must not require loading more than ${DEFAULT_BUDGET} lines (the file plus its direct relative imports). If the gate fails, narrow the module's interface or extract a cohesive subsystem instead of scattering logic. If the coupling is legitimate, mark the file with a // context-cost:allow comment.`,
  }));

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !AUTO_CHECK_TOOL_NAMES.has(event.toolName)) {
      return;
    }

    const path = extractToolPath(event.input);
    if (!path || !isSupportedPath(path)) {
      return;
    }

    const report = await analyzeCwdPath(ctx.cwd, path, DEFAULT_BUDGET);
    if (!report) {
      return;
    }

    // Only interrupt when the total changed for this file; a stable over-budget
    // file the agent did not worsen should not nag every edit.
    const key = resolve(ctx.cwd, path);
    if (!isOverBudget(report)) {
      previousTotals.delete(key);
      return;
    }

    const previous = previousTotals.get(key);
    previousTotals.set(key, report.totalLines);
    if (previous === report.totalLines) {
      return;
    }

    return {
      content: [
        {
          type: "text",
          text: appendReport(event.content, `${formatReport(report)}\n\nReduce the context needed to touch this file before continuing.`),
        },
      ],
    };
  });

  pi.registerTool({
    name: "context_cost",
    label: "Context Cost",
    description: "Measure the lines an agent must load to touch a TS/JS file (file plus direct relative imports).",
    promptSnippet: "Measure context cost (self + direct import lines) for TS/JS files, budget 2500 lines",
    promptGuidelines: [
      "Use context_cost after restructuring modules when you need an explicit context-cost result.",
    ],
    parameters: CONTEXT_COST_CHECK_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reports = await collectReports(pi, ctx.cwd, params.paths ?? []);
      if (reports.length === 0) {
        return {
          content: [{ type: "text", text: "Context cost: no supported readable TS/JS files" }],
          details: { budget: DEFAULT_BUDGET, reports: [] },
        };
      }

      const failed = reports.filter(isOverBudget);
      const text = failed.length === 0 ? formatPassSummary(reports.length) : failed.map(formatReport).join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { budget: DEFAULT_BUDGET, reports: reports.map(toSerializableReport) },
      };
    },
  });

  pi.registerCommand("contextcost", {
    description: "Measure context cost for changed TS/JS files or explicit paths",
    handler: async (args, ctx) => {
      const reports = await collectReports(pi, ctx.cwd, args.trim() ? args.split(/\s+/) : []);
      if (reports.length === 0) {
        ctx.ui.notify("no supported changed TS/JS files", "warning");
        return;
      }

      const failed = reports.filter(isOverBudget);
      const summary = failed.length === 0 ? formatPassSummary(reports.length) : `context cost fail ${failed.length}/${reports.length} file(s)`;
      ctx.ui.notify(summary, failed.length === 0 ? "info" : "warning");
    },
  });
}

function extractToolPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }

  const path = (input as { path?: unknown }).path;
  return typeof path === "string" ? normalizePathArg(path) : undefined;
}

function normalizePathArg(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

async function analyzeCwdPath(cwd: string, path: string, budget: number): Promise<ContextCostReport | undefined> {
  try {
    const absolute = resolve(cwd, path);
    const source = await readFile(absolute, "utf8");
    return analyzeContextCost(absolute, source, budget);
  } catch {
    return undefined;
  }
}

async function collectReports(pi: ExtensionAPI, cwd: string, explicitPaths: string[]): Promise<ContextCostReport[]> {
  const rawPaths = explicitPaths.length > 0 ? explicitPaths : await listChangedPaths(pi, cwd);
  const paths = [...new Set(rawPaths.map(normalizePathArg).filter(isSupportedPath))];
  if (paths.length === 0) {
    return [];
  }

  return (await Promise.all(paths.map((path) => analyzeCwdPath(cwd, path, DEFAULT_BUDGET)))).filter(
    (report): report is ContextCostReport => report !== undefined,
  );
}

function toSerializableReport(report: ContextCostReport) {
  return {
    path: report.path,
    budget: report.budget,
    selfLines: report.selfLines,
    imports: report.imports,
    totalLines: report.totalLines,
    allowed: report.allowed,
  };
}

function formatPassSummary(count: number): string {
  return `Context cost: PASS ${count} file(s)`;
}

function appendReport(content: Array<{ type: string; text?: string }>, report: string): string {
  const existing = content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim())
    .filter(Boolean)
    .join("\n\n");

  return existing ? `${existing}\n\n${report}` : report;
}

async function listChangedPaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const inside = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return [];
  }

  const [tracked, untracked] = await Promise.all([
    pi.exec("git", ["diff", "--name-only", "--diff-filter=ACMRTUXB"], { cwd }),
    pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd }),
  ]);

  return [...tracked.stdout.split(/\r?\n/), ...untracked.stdout.split(/\r?\n/)].map((line) => line.trim()).filter(Boolean);
}
