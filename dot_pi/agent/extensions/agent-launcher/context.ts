import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Only these workflow guidance files cross the Worktrunk boundary; extend this list explicitly. */
export const WORKFLOW_CONTEXT_ALLOWLIST = ["**/CONTEXT.md", "**/AGENTS.md"] as const;

interface CommandResult { code: number; stdout: string; stderr: string; }
interface DirtyPath { status: string; relativePath: string; }

export interface WorkflowContextChange {
  relativePath: string;
  content?: Buffer;
  baseline?: Buffer;
}

export interface WorkflowContextSnapshot {
  files: WorkflowContextChange[];
  unrelatedDirtyPaths: string[];
}

type Progress = (message: string) => void;

function commandError(result: CommandResult, operation: string): Error {
  return new Error(`${operation} failed: ${(result.stderr || result.stdout).trim()}`);
}

function normalizeRelativePath(relativePath: string): string {
  return path.posix.normalize(relativePath.replaceAll(path.sep, "/"));
}

function isSafeRelativePath(relativePath: string): boolean {
  return relativePath !== "" && relativePath !== "." && !relativePath.startsWith("../") && relativePath !== ".." && !path.posix.isAbsolute(relativePath);
}

function isAllowedPattern(relativePath: string, pattern: string): boolean {
  return pattern === relativePath || (pattern.startsWith("**/") && (relativePath === pattern.slice(3) || relativePath.endsWith(`/${pattern.slice(3)}`)));
}

export function isWorkflowContextPath(relativePath: string, allowlist: readonly string[] = WORKFLOW_CONTEXT_ALLOWLIST): boolean {
  const normalized = normalizeRelativePath(relativePath);
  return isSafeRelativePath(normalized) && allowlist.some((pattern) => isAllowedPattern(normalized, pattern));
}

function parseStatus(output: string): DirtyPath[] {
  const records = output.split("\0").filter(Boolean);
  const changes: DirtyPath[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const status = record.slice(0, 2);
    const relativePath = normalizeRelativePath(record.slice(3));
    if (status[0] === "R" || status[0] === "C") {
      const renamedPath = records[index + 1];
      if (!renamedPath) throw new Error(`Git returned an incomplete workflow context rename for ${relativePath}`);
      changes.push({ status: "D ", relativePath });
      changes.push({ status: "A ", relativePath: normalizeRelativePath(renamedPath) });
      index += 1;
      continue;
    }
    changes.push({ status, relativePath });
  }
  return changes;
}

function sourcePath(root: string, relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath);
  if (!isSafeRelativePath(normalized)) throw new Error(`Unsafe workflow context path: ${relativePath}`);
  return path.resolve(root, normalized);
}

async function readBaseline(pi: ExtensionAPI, root: string, relativePath: string, signal?: AbortSignal): Promise<Buffer | undefined> {
  const result = await pi.exec("git", ["show", `HEAD:${relativePath}`], { cwd: root, signal, timeout: 10_000 });
  return result.code === 0 ? Buffer.from(result.stdout, "utf8") : undefined;
}

async function readChange(pi: ExtensionAPI, root: string, dirty: DirtyPath, signal?: AbortSignal): Promise<WorkflowContextChange> {
  const absolutePath = sourcePath(root, dirty.relativePath);
  const stat = await fs.lstat(absolutePath).catch(() => undefined);
  const baseline = await readBaseline(pi, root, dirty.relativePath, signal);
  if (!stat) {
    if (dirty.status.includes("D")) return { relativePath: dirty.relativePath, baseline };
    throw new Error(`Workflow context file disappeared during capture: ${dirty.relativePath}`);
  }
  if (!stat.isFile()) throw new Error(`Workflow context path is not a regular file: ${dirty.relativePath}`);
  return { relativePath: dirty.relativePath, content: await fs.readFile(absolutePath), baseline };
}

export async function captureWorkflowContext(pi: ExtensionAPI, root: string, signal?: AbortSignal, onUpdate?: Progress): Promise<WorkflowContextSnapshot> {
  const result = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, signal, timeout: 10_000 });
  if (result.code !== 0) throw commandError(result, "Reading orchestrator Git status");
  const dirtyPaths = parseStatus(result.stdout).filter((dirty) => isSafeRelativePath(dirty.relativePath));
  const contextPaths = dirtyPaths.filter((dirty) => isWorkflowContextPath(dirty.relativePath));
  const unrelatedDirtyPaths = dirtyPaths.filter((dirty) => !isWorkflowContextPath(dirty.relativePath)).map((dirty) => dirty.relativePath);
  onUpdate?.(contextPaths.length ? `Capturing ${contextPaths.length} workflow context file(s) at launch time...` : "No dirty workflow context files found at launch time.");
  if (unrelatedDirtyPaths.length > 0) onUpdate?.(`Ignoring ${unrelatedDirtyPaths.length} unrelated dirty file(s); only the workflow context allowlist is propagated.`);
  const files = await Promise.all(contextPaths.map((dirty) => readChange(pi, root, dirty, signal)));
  return { files, unrelatedDirtyPaths };
}

/**
 * Propagation is additive for new files, replaces only a destination at its HEAD
 * baseline, treats an exact match as a no-op, and refuses every other conflict.
 */
interface PropagationAction { kind: "write" | "delete"; relativePath: string; content?: Buffer; }

async function destinationFile(destinationRoot: string, relativePath: string): Promise<{ content?: Buffer }> {
  const targetPath = sourcePath(destinationRoot, relativePath);
  const stat = await fs.lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return {};
  if (!stat.isFile()) throw new Error(`Workflow context conflict at ${relativePath}: destination is not a regular file`);
  return { content: await fs.readFile(targetPath) };
}

function sameContent(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left !== undefined && right !== undefined && left.equals(right);
}

function conflict(relativePath: string): Error {
  return new Error(`Workflow context conflict at ${relativePath}: destination has changes outside the launch snapshot`);
}

function planDeletion(change: WorkflowContextChange, destination: { content?: Buffer }): PropagationAction | undefined {
  if (destination.content === undefined) return undefined;
  if (sameContent(destination.content, change.baseline)) return { kind: "delete", relativePath: change.relativePath };
  throw conflict(change.relativePath);
}

function planWrite(change: WorkflowContextChange, destination: { content?: Buffer }): PropagationAction | undefined {
  if (destination.content === undefined) return { kind: "write", relativePath: change.relativePath, content: change.content };
  if (sameContent(destination.content, change.content)) return undefined;
  // A fresh Worktrunk target contains HEAD; overwrite only that baseline or an exact match.
  if (sameContent(destination.content, change.baseline)) return { kind: "write", relativePath: change.relativePath, content: change.content };
  throw conflict(change.relativePath);
}

async function planChange(destinationRoot: string, change: WorkflowContextChange): Promise<PropagationAction | undefined> {
  try {
    const destination = await destinationFile(destinationRoot, change.relativePath);
    return change.content === undefined ? planDeletion(change, destination) : planWrite(change, destination);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Workflow context conflict")) throw error;
    throw new Error(`Failed to propagate workflow context ${change.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function applyAction(destinationRoot: string, action: PropagationAction, onUpdate?: Progress): Promise<void> {
  const targetPath = sourcePath(destinationRoot, action.relativePath);
  try {
    onUpdate?.(`${action.kind === "write" ? "Propagating" : "Removing"} workflow context: ${action.relativePath}`);
    if (action.kind === "write") {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, action.content);
    } else {
      await fs.unlink(targetPath);
    }
  } catch (error) {
    throw new Error(`Failed to propagate workflow context ${action.relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function propagateWorkflowContext(snapshot: WorkflowContextSnapshot, destinationRoot: string, onUpdate?: Progress): Promise<void> {
  const stat = await fs.stat(destinationRoot).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Workflow context propagation target is missing or not a directory: ${destinationRoot}`);
  const actions = (await Promise.all(snapshot.files.map((change) => planChange(destinationRoot, change)))).filter((action): action is PropagationAction => action !== undefined);
  onUpdate?.(actions.length ? `Applying ${actions.length} captured workflow context file(s)...` : "Workflow context already matches the launch snapshot.");
  for (const action of actions) await applyAction(destinationRoot, action, onUpdate);
}
