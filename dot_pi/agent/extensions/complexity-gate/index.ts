import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  analyzeSource,
  analyzeUnusedExports,
  formatReport,
  isHelperModulePath,
  isSupportedPath,
  type ComplexityReport,
  type ExportUsageIssue,
} from "./core.ts";

const DEFAULT_THRESHOLD = 8;
const WARNING_THRESHOLD = 16;
const AUTO_CHECK_TOOL_NAMES = new Set(["edit", "write"]);
const COMPLEXITY_CHECK_PARAMS = Type.Object({
  paths: Type.Optional(
    Type.Array(Type.String({ description: "Relative path to a TS/JS file. Omit to analyze changed files." })),
  ),
});

type PathAnalysis = {
  report: ComplexityReport;
  exportIssues: ExportUsageIssue[];
};

export default function complexityGate(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nAn automatic complexity gate is active. After edit and write tool calls, changed TS/JS files are analyzed with a deterministic cyclomatic complexity checker. Functions above ${DEFAULT_THRESHOLD} and below ${WARNING_THRESHOLD} are blocking violations; functions at or above ${WARNING_THRESHOLD} are reported as non-blocking warnings. Prefer module-private helpers and export only helpers imported from another module. If the gate fails, reduce blocking complexity and remove useless exports before finalizing.`,
  }));

  pi.on("tool_result", (event, ctx) => handleToolResult(pi, event, ctx));

  pi.registerTool({
    name: "complexity_check",
    label: "Complexity Check",
    description: "Check deterministic cyclomatic complexity and helper-module exports for TS/JS files changed in git or explicit relative paths.",
    promptSnippet: "Analyze TS/JS file complexity with threshold 8, non-blocking warnings at 16, and flag useless helper exports",
    promptGuidelines: [
      "Use complexity_check after implementing or refactoring TS/JS code when you need an explicit complexity result.",
    ],
    parameters: COMPLEXITY_CHECK_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const analyses = await collectAnalyses(pi, ctx.cwd, params.paths ?? []);
      if (analyses.length === 0) {
        return {
          content: [{ type: "text", text: "Complexity gate: no supported readable TS/JS files" }],
          details: { threshold: DEFAULT_THRESHOLD, warningThreshold: WARNING_THRESHOLD, reports: [] },
        };
      }

      const failed = analyses.filter(hasFailures);
      const reported = analyses.filter((analysis) => hasFailures(analysis) || hasWarnings(analysis));
      const text = failed.length === 0
        ? formatPassSummary(analyses.length, analyses.filter(hasWarnings).length)
        : reported.map(formatAnalysis).join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { threshold: DEFAULT_THRESHOLD, warningThreshold: WARNING_THRESHOLD, reports: analyses.map(toSerializableAnalysis) },
      };
    },
  });

  pi.registerCommand("complexity", {
    description: "Check deterministic cyclomatic complexity for changed TS/JS files or explicit paths",
    handler: async (args, ctx) => {
      const analyses = await collectAnalyses(pi, ctx.cwd, args.trim() ? args.split(/\s+/) : []);
      if (analyses.length === 0) {
        ctx.ui.notify("no supported changed TS/JS files", "warning");
        return;
      }

      const failed = analyses.filter(hasFailures);
      const summary = failed.length === 0
        ? formatPassSummary(analyses.length, analyses.filter(hasWarnings).length)
        : `complexity fail ${failed.length}/${analyses.length} file(s)`;
      ctx.ui.notify(summary, failed.length === 0 ? "info" : "warning");
    },
  });
}

async function handleToolResult(pi: ExtensionAPI, event: ToolResultEvent, ctx: ExtensionContext) {
  const path = toolResultPath(event);
  if (!path) {
    return;
  }

  const analysis = await analyzePath(pi, ctx.cwd, path, DEFAULT_THRESHOLD, WARNING_THRESHOLD);
  if (!analysis || !hasReportContent(analysis)) {
    return;
  }

  return formatToolResult(event, analysis);
}

function toolResultPath(event: ToolResultEvent): string | undefined {
  if (event.isError || !AUTO_CHECK_TOOL_NAMES.has(event.toolName)) {
    return undefined;
  }
  const path = extractToolPath(event.input);
  return path && isSupportedPath(path) ? path : undefined;
}

function hasReportContent(analysis: PathAnalysis): boolean {
  return hasFailures(analysis) || hasWarnings(analysis);
}

function formatToolResult(event: ToolResultEvent, analysis: PathAnalysis) {
  const guidance = hasFailures(analysis)
    ? "Reduce blocking complexity before continuing."
    : "This warning is non-blocking.";
  return {
    content: [
      {
        type: "text" as const,
        text: appendReport(event.content, `${formatAnalysis(analysis)}\n\n${guidance}`),
      },
    ],
  };
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

async function analyzePath(pi: ExtensionAPI, cwd: string, path: string, threshold: number, warningThreshold: number): Promise<PathAnalysis | undefined> {
  try {
    const source = await readFile(resolve(cwd, path), "utf8");
    const report = analyzeSource(path, source, threshold, warningThreshold);
    const exportIssues = isHelperModulePath(path)
      ? analyzeUnusedExports(path, source, await loadConsumerSources(pi, cwd, path))
      : [];

    return { report, exportIssues };
  } catch {
    return undefined;
  }
}

async function collectAnalyses(pi: ExtensionAPI, cwd: string, explicitPaths: string[]): Promise<PathAnalysis[]> {
  const rawPaths = explicitPaths.length > 0 ? explicitPaths : await listChangedPaths(pi, cwd);
  const paths = [...new Set(rawPaths.map(normalizePathArg).filter(isSupportedPath))];
  if (paths.length === 0) {
    return [];
  }

  return (await Promise.all(paths.map((path) => analyzePath(pi, cwd, path, DEFAULT_THRESHOLD, WARNING_THRESHOLD)))).filter(
    (analysis): analysis is PathAnalysis => analysis !== undefined,
  );
}

function hasFailures(analysis: PathAnalysis): boolean {
  return analysis.report.violations.length > 0 || analysis.exportIssues.length > 0;
}

function hasWarnings(analysis: PathAnalysis): boolean {
  return analysis.report.warnings.length > 0;
}

function formatAnalysis(analysis: PathAnalysis): string {
  const lines: string[] = [];

  if (analysis.report.violations.length > 0 || analysis.report.warnings.length > 0) {
    lines.push(formatReport(analysis.report));
  } else if (analysis.exportIssues.length > 0) {
    lines.push(`Complexity gate: FAIL ${analysis.report.path}`);
  }

  for (const issue of analysis.exportIssues) {
    lines.push(`- ${issue.name} line ${issue.line} col ${issue.column} ${issue.message}`);
  }

  return lines.length === 0 ? `Complexity gate: PASS ${analysis.report.path}` : lines.join("\n");
}

function toSerializableAnalysis(analysis: PathAnalysis) {
  return {
    path: analysis.report.path,
    threshold: analysis.report.threshold,
    warningThreshold: analysis.report.warningThreshold,
    functions: analysis.report.functions,
    violations: analysis.report.violations,
    warnings: analysis.report.warnings,
    exportIssues: analysis.exportIssues,
  };
}

function formatPassSummary(count: number, warningCount: number): string {
  return warningCount === 0
    ? `Complexity gate: PASS ${count} file(s)`
    : `Complexity gate: PASS ${count} file(s), ${warningCount} warning(s)`;
}

function appendReport(content: Array<{ type: string; text?: string }>, report: string): string {
  const existing = content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim())
    .filter(Boolean)
    .join("\n\n");

  return existing ? `${existing}\n\n${report}` : report;
}

async function loadConsumerSources(
  pi: ExtensionAPI,
  cwd: string,
  targetPath: string,
): Promise<Array<{ path: string; source: string }>> {
  const workspacePaths = await listWorkspacePaths(pi, cwd);
  const consumers = workspacePaths.filter((path) => path !== targetPath && isSupportedPath(path));

  const loaded = await Promise.all(
    consumers.map(async (path) => {
      try {
        return {
          path,
          source: await readFile(resolve(cwd, path), "utf8"),
        };
      } catch {
        return undefined;
      }
    }),
  );

  return loaded.filter((entry): entry is { path: string; source: string } => entry !== undefined);
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

async function listWorkspacePaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
  const listed = await pi.exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd });
  if (listed.code !== 0) {
    return [];
  }

  return listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
