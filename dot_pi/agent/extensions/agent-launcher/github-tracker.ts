import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findWorkspaceRoot } from "./issues.ts";
import { formatUnblockResult, unblockDependentIssues, type UnblockResult } from "./unblocking.ts";

export interface PullRequestStatus {
  state: string;
  isDraft: boolean;
  url?: string;
}

export interface TrackerCleanupParams {
  selector?: string | number;
  repo?: string;
  cwd?: string;
  issuePath: string;
}

function pushRepo(args: string[], repo?: string): void {
  if (repo) args.push("--repo", repo);
}

function pushSelector(args: string[], selector?: string | number): void {
  if (selector !== undefined && selector !== null && `${selector}`.trim()) args.push(`${selector}`);
}

export function parsePullRequestStatus(output: string): PullRequestStatus {
  try {
    const status = JSON.parse(output) as Partial<PullRequestStatus>;
    if (typeof status.state !== "string" || typeof status.isDraft !== "boolean") throw new Error("missing state or draft status");
    return { state: status.state, isDraft: status.isDraft, ...(typeof status.url === "string" ? { url: status.url } : {}) };
  } catch (error) {
    throw new Error(`Reading GitHub PR status returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readPullRequestStatus(
  pi: ExtensionAPI,
  params: TrackerCleanupParams,
  signal?: AbortSignal,
  ctxCwd = process.cwd(),
): Promise<PullRequestStatus> {
  const args = ["pr", "view"];
  pushSelector(args, params.selector);
  args.push("--json", "state,isDraft,url");
  pushRepo(args, params.repo);
  const result = await pi.exec("gh", args, { cwd: params.cwd || ctxCwd, signal, timeout: 120_000 });
  if (result.code !== 0) throw new Error(`Reading GitHub PR status failed: ${(result.stderr || result.stdout).trim()}`);
  return parsePullRequestStatus(result.stdout);
}

async function cleanupTracker(
  params: TrackerCleanupParams,
  onUpdate: ((message: string) => void) | undefined,
  ctxCwd: string,
): Promise<UnblockResult> {
  const issuePath = path.resolve(params.cwd || ctxCwd, params.issuePath);
  const workspaceRoot = await findWorkspaceRoot(path.dirname(issuePath));
  return unblockDependentIssues(workspaceRoot, issuePath, onUpdate);
}

export async function cleanupMergedTracker(
  pi: ExtensionAPI,
  params: TrackerCleanupParams,
  signal: AbortSignal | undefined,
  onUpdate: ((message: string) => void) | undefined,
  ctxCwd: string,
): Promise<{ status: PullRequestStatus; cleanup?: UnblockResult }> {
  const status = await readPullRequestStatus(pi, params, signal, ctxCwd);
  if (status.state !== "MERGED") return { status };
  return { status, cleanup: await cleanupTracker(params, onUpdate, ctxCwd) };
}

export function cleanupMessage(result: { status: PullRequestStatus; cleanup?: UnblockResult }): string {
  if (result.status.state !== "MERGED") return `No tracker changes: pull request is ${result.status.state.toLowerCase()}${result.status.isDraft ? " and is a draft" : ""}. Merge it before clearing dependencies.`;
  return formatUnblockResult(result.cleanup!);
}
