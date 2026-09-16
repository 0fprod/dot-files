import * as path from "node:path";

export type AgentRole = "writer" | "reader" | "researcher";
export type AgentMode = "read-only" | "writer";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type LaunchLocation = "tab" | "pane" | "background";
export type WorkspaceStrategy = "worktrunk" | "existing";
export type RepositoryScope = "core" | "server" | "web";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface RolePolicy {
  role: AgentRole;
  description: string;
  mode: AgentMode;
  defaultThinking: ThinkingLevel;
  tools: string[];
  systemInstructions: string;
}

const worktrunkTools = ["worktrunk_tools", "wt_list", "wt_switch", "wt_remove", "wt_merge"];
const writerInstructions = `You are the Writer role. Implement exactly one approved local-tracker issue. Start behavior-changing implementation through /skill:temper. Read the complete issue, its linked repository spec, Workspace/AGENTS.md, repository AGENTS.md, CONTEXT.md files, and relevant domain context before editing. Work only in the selected repository and issue scope. Use the available Worktrunk extension tools for worktree operations; call worktrunk_tools to activate a specific wt tool when needed. Never approve Worktrunk hooks yourself or use --yes: stop and ask the user to review them with wt config approvals add. Do not launch agents. Do not modify gobl.fatturapa. Leave changes uncommitted; do not push, merge, or remove the workspace unless explicitly requested.`;
const readerInstructions = `You are the Reader role. Review exactly one approved local-tracker issue within the scope stated by the launch instructions. Follow the review brief for which tracker documents to read; do not infer additional review scope. Inspect source, tests, diffs, and Git history as needed. Do not modify files, Git state, Jira, databases, or external systems. Do not launch agents. Report actionable findings ordered by severity with concrete paths and symbols.`;
const researcherInstructions = `You are the Researcher role. Investigate exactly one approved local-tracker issue and its linked repository spec. Prefer local source, documentation, Git history, and read-only upstream repositories. If web navigation, rendered pages, screenshots, browser interaction, or web extraction is required, load and follow /skill:agent-browser. Do not load it unnecessarily. Do not modify files, Git state, Jira, databases, or external systems. Do not launch agents. Separate confirmed facts from inferences and cite concrete paths, symbols, commits, documentation pages, and URLs.`;

export const ROLE_POLICIES: Record<AgentRole, RolePolicy> = {
  writer: { role: "writer", description: "Implement one approved issue", mode: "writer", defaultThinking: "high", tools: ["read", "bash", "edit", "write", "todo", ...worktrunkTools], systemInstructions: writerInstructions },
  reader: { role: "reader", description: "Review one approved issue", mode: "read-only", defaultThinking: "high", tools: ["read", "bash", "todo"], systemInstructions: readerInstructions },
  researcher: { role: "researcher", description: "Research one approved issue", mode: "read-only", defaultThinking: "high", tools: ["read", "bash", "todo"], systemInstructions: researcherInstructions },
};

export interface IssueContext {
  path: string;
  repository: RepositoryScope;
  title: string;
  jiraId?: string;
  specPath: string;
  blockedBy?: string;
  repositoryRoot: string;
}

export interface LaunchRequest {
  role: AgentRole;
  issue: IssueContext;
  workspace: WorkspaceStrategy;
  location: LaunchLocation;
  model: string;
  thinking: ThinkingLevel;
  additionalInstructions?: string;
}

export interface PaneRect { paneId: string; width: number; height: number; }
export interface PanePlacement { targetPaneId: string; direction: "right" | "down"; }

export function availableThinkingLevels(model: { reasoning: boolean; thinkingLevelMap?: Record<string, string | null> }): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

export function assertRoleTools(role: AgentRole, tools: string[]): void {
  const policy = ROLE_POLICIES[role];
  if (!policy) throw new Error(`Unknown agent role: ${role}`);
  const allowed = new Set(policy.tools);
  if (tools.some((tool) => !allowed.has(tool))) throw new Error(`${role} cannot enable additional tools`);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `\'"'"'`)}'`;
}

export function modelListContains(output: string, qualifiedModel: string): boolean {
  const separator = qualifiedModel.indexOf("/");
  if (separator < 1) return false;
  const provider = qualifiedModel.slice(0, separator);
  const model = qualifiedModel.slice(separator + 1);
  return output.split(/\r?\n/).some((line) => {
    const columns = line.trim().split(/\s+/);
    return columns[0] === provider && columns[1] === model;
  });
}

export function buildInitialPrompt(request: LaunchRequest, cwd: string): string {
  const temper = request.role === "writer" ? "/skill:temper " : "";
  const task = request.role === "writer" ? "Implement" : request.role === "reader" ? "Review" : "Research";
  const optional = request.additionalInstructions?.trim()
    ? `\n\nAdditional instructions for this run (from the orchestrator):\n---\n${request.additionalInstructions}\n---`
    : "";
  const readingInstructions = request.role === "reader"
    ? "Read the complete issue and any tracker documents explicitly named by the launch brief before acting; do not infer additional review scope."
    : "Read the complete issue, linked spec, and applicable AGENTS.md and CONTEXT.md files before acting.";
  return `${temper}${task} exactly the one approved issue at:\n${request.issue.path}\n\nIts approved repository spec is:\n${request.issue.specPath}\n\nYou are running in:\n${cwd}\n\n${ROLE_POLICIES[request.role].systemInstructions}\n\n${readingInstructions}${optional}`;
}

export function buildPiCommand(request: LaunchRequest, sessionName: string, profilePromptPath: string): string {
  const policy = ROLE_POLICIES[request.role];
  return [
    "pi",
    "--model", shellQuote(request.model),
    "--thinking", shellQuote(request.thinking),
    "--tools", shellQuote(policy.tools.join(",")),
    "--append-system-prompt", shellQuote(profilePromptPath),
    "--name", shellQuote(sessionName),
  ].join(" ");
}

export function choosePanePlacement(orchestratorPaneId: string, panes: PaneRect[]): PanePlacement {
  const collaborators = panes.filter((pane) => pane.paneId !== orchestratorPaneId);
  if (collaborators.length === 0) return { targetPaneId: orchestratorPaneId, direction: "right" };
  const largest = collaborators.reduce((current, pane) => pane.width * pane.height > current.width * current.height ? pane : current);
  return { targetPaneId: largest.paneId, direction: "down" };
}

export function repositoryPath(workspaceRoot: string, repository: RepositoryScope): string {
  if (repository === "core") return path.join(workspaceRoot, "nomo-server-app", "packages", "core");
  return path.join(workspaceRoot, repository === "web" ? "nomo-web-app" : "nomo-server-app");
}

export function sessionLabel(request: LaunchRequest): string {
  const key = request.issue.jiraId ?? request.issue.title;
  return `${request.role}: ${key} ${request.issue.title}`.slice(0, 80);
}
