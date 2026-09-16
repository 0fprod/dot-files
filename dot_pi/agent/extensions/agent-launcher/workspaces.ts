import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IssueContext } from "./core.ts";
import { captureWorkflowContext, propagateWorkflowContext, type WorkflowContextSnapshot } from "./context.ts";

interface CommandResult { code: number; stdout: string; stderr: string; }

export interface WorkspaceResult {
  cwd: string;
  repositoryId: string;
  branch?: string;
}

function commandError(result: CommandResult, operation: string): Error {
  return new Error(`${operation} failed: ${(result.stderr || result.stdout).trim()}`);
}

function parseWorktreePath(result: CommandResult): string {
  if (result.code !== 0) throw commandError(result, "Worktrunk workspace creation");
  try {
    const payload = JSON.parse(result.stdout) as { path?: string; worktree_path?: string; result?: { path?: string; worktree_path?: string } };
    const worktree = payload.path ?? payload.worktree_path ?? payload.result?.path ?? payload.result?.worktree_path;
    if (worktree) return path.resolve(worktree);
  } catch {
    // Worktrunk's JSON output is expected; fall through to a useful error.
  }
  throw new Error(`Worktrunk returned no worktree path: ${result.stdout.trim()}`);
}

export function branchName(issue: IssueContext): string {
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "local-issue";
  return issue.jiraId ? `feature/${issue.jiraId}_${slug}` : `feature/${slug}`;
}

function gitRootFor(issue: IssueContext): string {
  return issue.repository === "core" ? path.resolve(issue.repositoryRoot, "../..") : issue.repositoryRoot;
}

function packagePath(worktreeRoot: string, issue: IssueContext): string {
  return issue.repository === "core" ? path.join(worktreeRoot, "packages", "core") : worktreeRoot;
}

async function repositoryId(pi: ExtensionAPI, cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await pi.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, signal, timeout: 10_000 });
  if (result.code !== 0) throw commandError(result, "Reading Git repository identity");
  return await fs.realpath(result.stdout.trim());
}

async function copyIncludedFiles(pi: ExtensionAPI, root: string, branch: string, signal?: AbortSignal): Promise<void> {
  const result = await pi.exec("wt", ["-C", root, "step", "copy-ignored", "--to", branch, "--require-include", "--format=json"], { cwd: root, signal, timeout: 120_000 });
  if (result.code !== 0) throw commandError(result, "Copying included Worktrunk files");
}

async function reuseWorktree(pi: ExtensionAPI, root: string, branch: string, signal?: AbortSignal): Promise<string> {
  const reused = await pi.exec("wt", ["-C", root, "switch", branch, "--no-cd", "--format=json"], { cwd: root, signal, timeout: 120_000 });
  return parseWorktreePath(reused);
}

async function createWorktree(pi: ExtensionAPI, issue: IssueContext, signal?: AbortSignal, onUpdate?: (message: string) => void): Promise<string> {
  const root = gitRootFor(issue);
  const branch = branchName(issue);
  const contextSnapshot: WorkflowContextSnapshot = await captureWorkflowContext(pi, root, signal, onUpdate);
  const created = await pi.exec("wt", ["-C", root, "switch", "--create", branch, "--no-cd", "--format=json"], { cwd: root, signal, timeout: 120_000 });
  const worktree = created.code === 0
    ? parseWorktreePath(created)
    : /already exists|branch .* exists/i.test(created.stderr || created.stdout)
      ? await reuseWorktree(pi, root, branch, signal)
      : (() => { throw commandError(created, "Worktrunk workspace creation"); })();
  await copyIncludedFiles(pi, root, branch, signal);
  onUpdate?.("Propagating captured workflow context into the worktree...");
  await propagateWorkflowContext(contextSnapshot, worktree, onUpdate);
  return worktree;
}

async function verifiedWorkspace(pi: ExtensionAPI, issue: IssueContext, worktreeRoot: string, signal?: AbortSignal): Promise<WorkspaceResult> {
  const cwd = packagePath(worktreeRoot, issue);
  const stat = await fs.stat(cwd).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Workspace target is not a directory: ${cwd}`);
  const expectedId = await repositoryId(pi, gitRootFor(issue), signal);
  const actualId = await repositoryId(pi, cwd, signal);
  if (actualId !== expectedId) throw new Error(`Workspace belongs to a different Git repository: ${cwd}`);
  return { cwd, repositoryId: actualId };
}

export async function prepareWorkspace(pi: ExtensionAPI, issue: IssueContext, strategy: "worktrunk" | "existing", signal?: AbortSignal, onUpdate?: (message: string) => void): Promise<WorkspaceResult> {
  const worktreeRoot = strategy === "existing" ? gitRootFor(issue) : await createWorktree(pi, issue, signal, onUpdate);
  const workspace = await verifiedWorkspace(pi, issue, worktreeRoot, signal);
  return strategy === "existing" ? workspace : { ...workspace, branch: branchName(issue) };
}

export function worktreePreview(workspace: WorkspaceResult): string {
  return workspace.branch ? `${workspace.cwd} (${workspace.branch})` : workspace.cwd;
}
