import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { availableThinkingLevels, type IssueContext, type LaunchRequest, type ThinkingLevel } from "./core.ts";
import { discoverIssues, findWorkspaceRoot, validateIssue } from "./issues.ts";
import { buildReviewBriefs, parseReviewArguments, type ReviewArguments } from "./review-core.ts";
import { launchAgent, validateModel } from "./launch.ts";
import { prepareWorkspace } from "./workspaces.ts";

interface ReviewTarget { root: string; scope: string; dirty: boolean; fixedPoint?: string; }

async function git(pi: ExtensionAPI, cwd: string, args: string[], operation: string, signal?: AbortSignal): Promise<string> {
  const result = await pi.exec("git", args, { cwd, signal, timeout: 15_000 });
  if (result.code !== 0) throw new Error(`${operation} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

async function resolveTarget(pi: ExtensionAPI, arguments_: ReviewArguments, signal?: AbortSignal): Promise<ReviewTarget> {
  const scope = await fs.realpath(arguments_.cwd).catch(() => undefined);
  if (!scope) throw new Error(`Review target does not exist: ${arguments_.cwd}`);
  const root = await git(pi, scope, ["rev-parse", "--show-toplevel"], "Resolving review target", signal);
  const status = await git(pi, scope, ["status", "--porcelain=v1", "--untracked-files=all"], "Reading review target status", signal);
  const dirty = status.length > 0;
  if (!dirty && !arguments_.fixedPoint) throw new Error("Review target is clean; provide --fixed-point <commit> to define the review range");
  const fixedPoint = arguments_.fixedPoint
    ? await git(pi, scope, ["rev-parse", "--verify", `${arguments_.fixedPoint}^{commit}`], "Validating review fixed point", signal)
    : undefined;
  return { root, scope, dirty, ...(fixedPoint ? { fixedPoint } : {}) };
}

async function resolveIssue(issuePath: string): Promise<IssueContext> {
  const absolute = await fs.realpath(issuePath).catch(() => undefined);
  if (!absolute) throw new Error(`Review issue does not exist: ${issuePath}`);
  const root = await findWorkspaceRoot(path.dirname(absolute));
  const issues = await discoverIssues(root, "all");
  for (const issue of issues) {
    if (await fs.realpath(issue.path).catch(() => "") === absolute) return issue;
  }
  throw new Error(`Review issue is not an approved local-tracker issue: ${issuePath}`);
}

async function standardsPaths(scope: string, root: string): Promise<string[]> {
  const names = ["AGENTS.md", "CONTRIBUTING.md"];
  const paths: string[] = [];
  let current = scope;
  while (true) {
    for (const name of names) {
      const candidate = path.join(current, name);
      if ((await fs.stat(candidate).catch(() => undefined))?.isFile()) paths.push(candidate);
    }
    if (current === root) return paths;
    const parent = path.dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}

function reviewModel(ctx: ExtensionContext): { model: string; thinking: ThinkingLevel } {
  if (!ctx.model) throw new Error("No current Pi model is available for review agents");
  const levels = availableThinkingLevels(ctx.model);
  return { model: `${ctx.model.provider}/${ctx.model.id}`, thinking: levels.includes("high") ? "high" : levels.at(-1) ?? "off" };
}

function readerRequest(issue: IssueContext, model: { model: string; thinking: ThinkingLevel }, angle: "standards" | "spec", brief: string): LaunchRequest {
  const key = issue.jiraId ?? issue.title;
  return {
    role: "reader", issue, workspace: "existing", location: "tab", model: model.model, thinking: model.thinking,
    readerAngle: angle, sessionName: `reader: ${angle} ${key}`, additionalInstructions: brief,
  };
}

async function launchReviewers(pi: ExtensionAPI, ctx: ExtensionContext, issue: IssueContext, model: { model: string; thinking: ThinkingLevel }, briefs: ReturnType<typeof buildReviewBriefs>): Promise<string[]> {
  const workspace = await prepareWorkspace(pi, issue, "existing", ctx.signal);
  const launched: string[] = [];
  const failures: string[] = [];
  for (const [angle, brief] of [["standards", briefs.standards], ["spec", briefs.spec]] as const) {
    try {
      const result = await launchAgent(pi, readerRequest(issue, model, angle, brief), workspace, ctx.signal, (message) => ctx.ui.notify(message, "info"));
      launched.push(result.tabId ?? result.paneId ?? result.sessionName);
    } catch (error) {
      failures.push(`${angle}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) throw new Error(`Review launch incomplete. Started: ${launched.join(", ") || "none"}. Failed: ${failures.join("; ")}`);
  return launched;
}

async function confirm(ctx: ExtensionContext, target: ReviewTarget, issue: IssueContext, model: string): Promise<boolean> {
  return ctx.ui.confirm("Launch two independent Reader reviews", `Target: ${target.root}\nIssue: ${issue.path}\nReviews: Standards + Spec\nLocation: two Herdr tabs\nModel: ${model}`);
}

export async function runReviewCommand(pi: ExtensionAPI, ctx: ExtensionContext, rawArguments: string): Promise<void> {
  const arguments_ = parseReviewArguments(rawArguments);
  const target = await resolveTarget(pi, arguments_, ctx.signal);
  const issue = await resolveIssue(arguments_.issue);
  await validateIssue(issue);
  const model = reviewModel(ctx);
  const briefs = buildReviewBriefs(
    target.root,
    issue,
    target.dirty,
    target.fixedPoint,
    path.join(getAgentDir(), "skills", "code-review", "STANDARDS-REVIEW.md"),
    path.join(getAgentDir(), "skills", "code-review", "SPEC-REVIEW.md"),
    await standardsPaths(target.scope, target.root),
  );
  await validateModel(pi, model.model, ctx.signal);
  if (!(await confirm(ctx, target, issue, model.model))) {
    ctx.ui.notify("Review launch cancelled", "info");
    return;
  }
  const launched = await launchReviewers(pi, ctx, issue, model, briefs);
  ctx.ui.notify(`Launched Standards and Spec Readers: ${launched.join(", ")}`, "info");
}
