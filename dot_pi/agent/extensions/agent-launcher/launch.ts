import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IssueContext, LaunchRequest } from "./core.ts";
import { buildInitialPrompt, buildPiCommand, choosePanePlacement, modelListContains, ROLE_POLICIES, sessionLabel, shellQuote, workspaceIdForLabel, workspaceLabelForRepository } from "./core.ts";
import type { WorkspaceResult } from "./workspaces.ts";
import { acquireWriterLease, type WriterLease } from "./writer-lock.ts";

interface CommandResult { code: number; stdout: string; stderr: string; }
interface Origin { paneId: string; tabId: string; workspaceId: string; }
export interface LaunchResult { sessionName: string; role: string; issuePath: string; cwd: string; tabId?: string; paneId?: string; pid?: number; logPath?: string; }

type Pane = { pane_id?: string; paneId?: string; tab_id?: string; tabId?: string; rect?: { width: number; height: number } };

function parseJson<T>(result: CommandResult, operation: string): T {
  if (result.code !== 0) throw new Error(`${operation} failed: ${(result.stderr || result.stdout).trim()}`);
  try { return JSON.parse(result.stdout) as T; } catch { throw new Error(`${operation} returned invalid JSON: ${result.stdout.trim()}`); }
}

function launchOrigin(): Origin {
  const paneId = process.env.HERDR_PANE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (process.env.HERDR_ENV !== "1" || !paneId || !tabId || !workspaceId) throw new Error("/agent requires an orchestrator running inside Herdr");
  return { paneId, tabId, workspaceId };
}

async function promptPath(request: LaunchRequest): Promise<string> {
  const directory = `${getAgentDir()}/state/agent-launcher/prompts`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = `${directory}/${request.role}.md`;
  await fs.writeFile(filePath, `${ROLE_POLICIES[request.role].systemInstructions}\n`, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

async function logPath(role: string): Promise<string> {
  const directory = `${getAgentDir()}/state/agent-launcher/logs`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${directory}/${role}-${stamp}.log`;
}

function paneId(pane: Pane): string | undefined { return pane.pane_id ?? pane.paneId; }
function tabId(pane: Pane): string | undefined { return pane.tab_id ?? pane.tabId; }

async function destinationWorkspace(pi: ExtensionAPI, repository: IssueContext["repository"], signal?: AbortSignal): Promise<string> {
  const label = workspaceLabelForRepository(repository);
  const result = await pi.exec("herdr", ["workspace", "list"], { signal, timeout: 10_000 });
  if (result.code !== 0) throw new Error(`Reading Herdr workspaces failed: ${(result.stderr || result.stdout).trim()}`);
  return workspaceIdForLabel(result.stdout, label);
}

function panesFrom(result: CommandResult): Pane[] {
  const payload = parseJson<{ result?: { panes?: Pane[] }; panes?: Pane[] }>(result, "Reading Herdr panes");
  return payload.result?.panes ?? payload.panes ?? [];
}

async function tabPane(pi: ExtensionAPI, tab: string, workspace: string, signal?: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await pi.exec("herdr", ["pane", "list", "--workspace", workspace], { signal, timeout: 10_000 });
    const pane = panesFrom(result).find((candidate) => tabId(candidate) === tab);
    if (paneId(pane ?? {})) return paneId(pane!)!;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Herdr did not expose an initial pane for tab ${tab}`);
}

async function createTab(pi: ExtensionAPI, cwd: string, label: string, origin: Origin, signal?: AbortSignal): Promise<{ tabId: string; paneId: string }> {
  const result = await pi.exec("herdr", ["tab", "create", "--workspace", origin.workspaceId, "--cwd", cwd, "--label", label, "--no-focus"], { signal, timeout: 15_000 });
  const payload = parseJson<{ result?: { tab?: { tab_id?: string; tabId?: string } }; tab?: { tab_id?: string; tabId?: string } }>(result, "Creating Herdr tab");
  const tab = payload.result?.tab ?? payload.tab;
  const createdTab = tab?.tab_id ?? tab?.tabId;
  if (!createdTab) throw new Error(`Herdr returned no tab ID: ${result.stdout.trim()}`);
  return { tabId: createdTab, paneId: await tabPane(pi, createdTab, origin.workspaceId, signal) };
}

async function visiblePane(pi: ExtensionAPI, request: LaunchRequest, workspace: WorkspaceResult, origin: Origin, signal?: AbortSignal): Promise<{ tabId?: string; paneId: string }> {
  if (request.location === "tab") {
    const destination = await destinationWorkspace(pi, request.issue.repository, signal);
    return createTab(pi, workspace.cwd, sessionLabel(request), { ...origin, workspaceId: destination }, signal);
  }
  const layoutResult = await pi.exec("herdr", ["pane", "layout", "--pane", origin.paneId], { signal, timeout: 10_000 });
  const payload = parseJson<{ result: { layout: { tab_id: string; panes: Array<{ pane_id: string; rect: { width: number; height: number } }> } } }>(layoutResult, "Reading Herdr pane layout");
  if (payload.result.layout.tab_id !== origin.tabId) throw new Error("The orchestrator pane moved tabs during launch");
  const placement = choosePanePlacement(origin.paneId, payload.result.layout.panes.map((pane) => ({ paneId: pane.pane_id, width: pane.rect.width, height: pane.rect.height })));
  const splitResult = await pi.exec("herdr", ["pane", "split", placement.targetPaneId, "--direction", placement.direction, "--cwd", workspace.cwd, "--no-focus"], { signal, timeout: 15_000 });
  const split = parseJson<{ result: { pane: { pane_id: string } } }>(splitResult, "Creating agent pane");
  return { paneId: split.result.pane.pane_id };
}

async function startVisible(pi: ExtensionAPI, pane: string, request: LaunchRequest, workspace: WorkspaceResult, signal?: AbortSignal, onUpdate?: (message: string) => void): Promise<void> {
  const label = sessionLabel(request);
  const profilePath = await promptPath(request);
  const command = buildPiCommand(request, label, profilePath);
  const rename = await pi.exec("herdr", ["pane", "rename", pane, label], { signal, timeout: 10_000 });
  if (rename.code !== 0) throw new Error(rename.stderr || rename.stdout);
  onUpdate?.("Starting Pi in the destination...");
  const start = await pi.exec("herdr", ["pane", "run", pane, command], { signal, timeout: 10_000 });
  if (start.code !== 0) throw new Error(start.stderr || start.stdout);
  onUpdate?.("Waiting for Pi to become ready...");
  await waitForAgentIdle(pi, pane, signal);
  onUpdate?.("Sending the initial task...");
  const deliver = await pi.exec("herdr", ["pane", "run", pane, buildInitialPrompt(request, workspace.cwd)], { signal, timeout: 10_000 });
  if (deliver.code !== 0) throw new Error(deliver.stderr || deliver.stdout);
}

async function waitForAgentIdle(pi: ExtensionAPI, pane: string, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "agent did not become idle";
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const waitMs = Math.min(1_000, remaining);
    const result = await pi.exec("herdr", ["agent", "wait", pane, "--until", "idle", "--timeout", `${waitMs}`], { signal, timeout: waitMs + 5_000 });
    if (result.code === 0) return;
    lastError = (result.stderr || result.stdout).trim() || lastError;
    if (!/agent target .* not found|timed out|timeout/i.test(lastError)) {
      throw new Error(`Pi startup failed: ${lastError}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Pi startup failed: ${lastError}`);
}

async function backgroundLaunch(request: LaunchRequest, workspace: WorkspaceResult): Promise<{ pid: number; logPath: string }> {
  const profilePath = await promptPath(request);
  const outputPath = await logPath(request.role);
  const command = `exec ${buildPiCommand(request, sessionLabel(request), profilePath)} -p ${shellQuote(buildInitialPrompt(request, workspace.cwd))}`;
  const child = spawn("sh", ["-lc", `${command} >> ${shellQuote(outputPath)} 2>&1`], { cwd: workspace.cwd, detached: true, stdio: "ignore" });
  child.unref();
  return { pid: child.pid ?? -1, logPath: outputPath };
}

async function acquireWriterLeaseIfNeeded(pi: ExtensionAPI, request: LaunchRequest, workspace: WorkspaceResult, signal?: AbortSignal): Promise<WriterLease | undefined> {
  if (request.role !== "writer") return undefined;
  return acquireWriterLease({
    stateDir: `${getAgentDir()}/state/agent-launcher/writers`,
    repositoryId: workspace.repositoryId,
    ownershipKey: request.workspace === "worktrunk" ? workspace.cwd : workspace.repositoryId,
    workingTree: workspace.cwd,
    profile: request.role,
    paneExists: async (paneIdValue) => (await pi.exec("herdr", ["pane", "get", paneIdValue], { signal, timeout: 10_000 })).code === 0,
  });
}

async function launchDestination(pi: ExtensionAPI, request: LaunchRequest, workspace: WorkspaceResult, origin: Origin, lease: WriterLease | undefined, signal?: AbortSignal, onUpdate?: (message: string) => void): Promise<{ result: LaunchResult; pane?: string }> {
  if (request.location === "background") {
    onUpdate?.("Starting background Pi process...");
    const result = await backgroundLaunch(request, workspace);
    await lease?.attachProcess(result.pid);
    return { result: { sessionName: sessionLabel(request), role: request.role, issuePath: request.issue.path, cwd: workspace.cwd, pid: result.pid, logPath: result.logPath } };
  }
  onUpdate?.(request.location === "tab" ? "Creating Herdr tab..." : "Creating Herdr pane...");
  const target = await visiblePane(pi, request, workspace, origin, signal);
  const pane = target.paneId;
  await lease?.attachPane(pane);
  await startVisible(pi, pane, request, workspace, signal, onUpdate);
  return { result: { sessionName: sessionLabel(request), role: request.role, issuePath: request.issue.path, cwd: workspace.cwd, ...(target.tabId ? { tabId: target.tabId } : {}), paneId: pane }, pane };
}

async function releaseReservationIfNeeded(lease: WriterLease | undefined, pane: string | undefined): Promise<void> {
  if (!pane) await lease?.releaseReservation();
}

function launchErrorMessage(pane: string | undefined, error: unknown): string {
  const location = pane ? ` in pane ${pane}` : " before destination creation";
  const detail = error instanceof Error ? error.message : String(error);
  return `Agent launch failed${location}: ${detail}`;
}

export async function validateModel(pi: ExtensionAPI, model: string, signal?: AbortSignal): Promise<void> {
  const result = await pi.exec("pi", ["--list-models", model], { signal, timeout: 30_000 });
  if (result.code !== 0 || !modelListContains(result.stdout, model)) throw new Error(`Selected model is unavailable: ${model}`);
}

export async function launchAgent(pi: ExtensionAPI, request: LaunchRequest, workspace: WorkspaceResult, signal?: AbortSignal, onUpdate?: (message: string) => void): Promise<LaunchResult> {
  const origin = launchOrigin();
  let lease: WriterLease | undefined;
  let pane: string | undefined;
  try {
    lease = await acquireWriterLeaseIfNeeded(pi, request, workspace, signal);
    onUpdate?.(`Preparing ${request.role} destination...`);
    const launched = await launchDestination(pi, request, workspace, origin, lease, signal, onUpdate);
    pane = launched.pane;
    return launched.result;
  } catch (error) {
    await releaseReservationIfNeeded(lease, pane);
    throw new Error(launchErrorMessage(pane, error));
  }
}
