import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { analyzeSource, formatReport, isSupportedPath, type ComplexityReport } from "./core.ts";

const DEFAULT_THRESHOLD = 12;
const AUTO_CHECK_TOOL_NAMES = new Set(["edit", "write"]);
const previousViolations = new Map<string, Set<string>>();
const COMPLEXITY_CHECK_PARAMS = Type.Object({
  paths: Type.Optional(
    Type.Array(Type.String({ description: "Relative path to a TS/JS file. Omit to analyze changed files." })),
  ),
});

export default function complexityGate(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nAn automatic complexity gate is active. After edit and write tool calls, changed TS/JS files are analyzed with a deterministic complexity checker (flat branches cost 1, nested branches cost more). Keep every function at complexity ${DEFAULT_THRESHOLD} or below. If the gate fails, reduce complexity before finalizing. If a file legitimately needs higher complexity (dispatch tables, parsers, state machines), mark it with a // complexity-gate:allow comment instead of fragmenting it artificially.`,
  }));

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || !AUTO_CHECK_TOOL_NAMES.has(event.toolName)) {
      return;
    }

    const path = extractToolPath(event.input);
    if (!path || !isSupportedPath(path)) {
      return;
    }

    const report = await analyzePath(ctx.cwd, path, DEFAULT_THRESHOLD);
    if (!report) {
      return;
    }

    const key = resolve(ctx.cwd, path);
    if (report.violations.length === 0) {
      previousViolations.delete(key);
      return;
    }

    // Only interrupt when a violation is new for this file; pre-existing
    // violations the agent did not worsen should not nag every edit.
    const current = new Set(report.violations.map((entry) => `${entry.name}:${entry.line}`));
    const previous = previousViolations.get(key);
    previousViolations.set(key, current);
    if (previous !== undefined && ![...current].some((signature) => !previous.has(signature))) {
      return;
    }

    return {
      content: [
        {
          type: "text",
          text: appendReport(event.content, `${formatReport(report)}\n\nReduce complexity before continuing.`),
        },
      ],
    };
  });

  pi.registerTool({
    name: "complexity_check",
    label: "Complexity Check",
    description: "Check deterministic complexity for TS/JS files changed in git or explicit relative paths.",
    promptSnippet: "Analyze TS/JS file complexity with a deterministic threshold of 12",
    promptGuidelines: [
      "Use complexity_check after implementing or refactoring TS/JS code when you need an explicit complexity result.",
    ],
    parameters: COMPLEXITY_CHECK_PARAMS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const reports = await collectReports(pi, ctx.cwd, params.paths ?? []);
      if (reports.length === 0) {
        return {
          content: [{ type: "text", text: "Complexity gate: no supported readable TS/JS files" }],
          details: { threshold: DEFAULT_THRESHOLD, reports: [] },
        };
      }

      const failed = reports.filter((report) => report.violations.length > 0);
      const text = failed.length === 0 ? formatPassSummary(reports.length) : failed.map(formatReport).join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { threshold: DEFAULT_THRESHOLD, reports: reports.map(toSerializableReport) },
      };
    },
  });

  pi.registerCommand("complexity", {
    description: "Check deterministic cyclomatic complexity for changed TS/JS files or explicit paths",
    handler: async (args, ctx) => {
      const reports = await collectReports(pi, ctx.cwd, args.trim() ? args.split(/\s+/) : []);
      if (reports.length === 0) {
        ctx.ui.notify("no supported changed TS/JS files", "warning");
        return;
      }

      const failed = reports.filter((report) => report.violations.length > 0);
      const summary = failed.length === 0 ? formatPassSummary(reports.length) : `complexity fail ${failed.length}/${reports.length} file(s)`;
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

async function analyzePath(cwd: string, path: string, threshold: number): Promise<ComplexityReport | undefined> {
  try {
    const source = await readFile(resolve(cwd, path), "utf8");
    return analyzeSource(path, source, threshold);
  } catch {
    return undefined;
  }
}

async function collectReports(pi: ExtensionAPI, cwd: string, explicitPaths: string[]): Promise<ComplexityReport[]> {
  const rawPaths = explicitPaths.length > 0 ? explicitPaths : await listChangedPaths(pi, cwd);
  const paths = [...new Set(rawPaths.map(normalizePathArg).filter(isSupportedPath))];
  if (paths.length === 0) {
    return [];
  }

  return (await Promise.all(paths.map((path) => analyzePath(cwd, path, DEFAULT_THRESHOLD)))).filter(
    (report): report is ComplexityReport => report !== undefined,
  );
}

function toSerializableReport(report: ComplexityReport) {
  return {
    path: report.path,
    threshold: report.threshold,
    functions: report.functions,
    violations: report.violations,
    allowed: report.allowed,
  };
}

function formatPassSummary(count: number): string {
  return `Complexity gate: PASS ${count} file(s)`;
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
