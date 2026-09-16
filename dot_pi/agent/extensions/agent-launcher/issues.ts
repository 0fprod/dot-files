import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { IssueContext, RepositoryScope } from "./core.ts";
import { repositoryPath } from "./core.ts";

const REPOSITORIES: RepositoryScope[] = ["core", "server", "web"];

async function isDirectory(candidate: string): Promise<boolean> {
  try { return (await fs.stat(candidate)).isDirectory(); } catch { return false; }
}

export async function findWorkspaceRoot(start: string): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    if (await isDirectory(path.join(current, "local-tracker"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot find Workspace root from ${start}`);
    current = parent;
  }
}

function firstHeading(content: string, fallback: string): string {
  return (content.match(/^#\s+(.+)$/m)?.[1] ?? fallback).replace(/[`#]/g, "").trim().slice(0, 80);
}

function field(content: string, name: string): string | undefined {
  const match = content.match(new RegExp(`(?:^|\\n)##\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i"));
  return match?.[1]?.trim();
}

function extractJira(content: string): string | undefined {
  return content.match(/\bITA-\d+\b/i)?.[0]?.toUpperCase();
}

function declaredRepository(content: string): string | undefined {
  const section = field(content, "Repository");
  const legacy = content.match(/^\*\*Repository:\*\*\s*([^\s`]+)/im)?.[1];
  return (section?.split(/\s|\n/)[0] ?? legacy)?.toLowerCase();
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function extractSpecPath(parent: string, workspaceRoot: string, repository: RepositoryScope, jiraId?: string): string {
  const explicit = parent.match(/(?:spec(?:ification)?|spec path)\s*:?\s*[`<]?([^`>\s]+)[`>]?/i)?.[1];
  const candidate = explicit ? path.resolve(workspaceRoot, explicit) : jiraId ? path.join(workspaceRoot, "local-tracker", repository, "specs", `${jiraId}.md`) : "";
  return candidate;
}

function blockerValue(content: string): string | undefined {
  const value = field(content, "Blocked by");
  if (!value || /^none(?:\s|$)/i.test(value)) return undefined;
  return value.replace(/\s+/g, " ").slice(0, 160);
}

async function parseIssue(filePath: string, workspaceRoot: string, repository: RepositoryScope): Promise<IssueContext> {
  const content = await fs.readFile(filePath, "utf8");
  if (!content.trim()) throw new Error(`Issue is empty: ${filePath}`);
  const declared = declaredRepository(content);
  if (declared && declared !== repository) throw new Error(`Issue repository does not match its tracker directory: ${filePath}`);
  const jiraId = extractJira(content);
  const specPath = extractSpecPath(field(content, "Parent") ?? "", workspaceRoot, repository, jiraId);
  if (!specPath) throw new Error(`Issue has no linked repository spec or Jira ID: ${filePath}`);
  const blockedBy = blockerValue(content);
  return {
    path: filePath,
    repository,
    title: firstHeading(content, path.basename(filePath, ".md")),
    ...(jiraId ? { jiraId } : {}),
    specPath,
    ...(blockedBy ? { blockedBy } : {}),
    repositoryRoot: repositoryPath(workspaceRoot, repository),
  };
}

async function discoverRepositoryIssues(workspaceRoot: string, repository: RepositoryScope, failures: string[]): Promise<IssueContext[]> {
  const directory = path.join(workspaceRoot, "local-tracker", repository, "issues");
  let files: string[];
  try { files = (await fs.readdir(directory)).filter((file) => file.endsWith(".md")).sort(); } catch { return []; }
  const issues: IssueContext[] = [];
  for (const file of files) {
    try { issues.push(await parseIssue(path.join(directory, file), workspaceRoot, repository)); }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  return issues;
}

export async function discoverIssues(workspaceRoot: string, filter: RepositoryScope | "all"): Promise<IssueContext[]> {
  const repositories = filter === "all" ? REPOSITORIES : [filter];
  const failures: string[] = [];
  const groups = await Promise.all(repositories.map((repository) => discoverRepositoryIssues(workspaceRoot, repository, failures)));
  const issues = groups.flat();
  if (issues.length === 0 && failures.length > 0) throw new Error(failures.join("\n"));
  return issues.sort((left, right) => `${left.repository}/${left.title}`.localeCompare(`${right.repository}/${right.title}`));
}

async function validateTrackerPaths(issue: IssueContext): Promise<void> {
  const workspaceRoot = path.dirname(path.dirname(path.dirname(path.dirname(path.resolve(issue.path)))));
  const issueDirectory = await fs.realpath(path.join(workspaceRoot, "local-tracker", issue.repository, "issues")).catch(() => undefined);
  const specDirectory = await fs.realpath(path.join(workspaceRoot, "local-tracker", issue.repository, "specs")).catch(() => undefined);
  const issuePath = await fs.realpath(issue.path).catch(() => undefined);
  const specPath = await fs.realpath(issue.specPath).catch(() => undefined);
  if (!issuePath || !issueDirectory || !isWithin(issueDirectory, issuePath)) throw new Error(`Issue is outside its approved tracker directory: ${issue.path}`);
  if (!specPath || !specDirectory || !isWithin(specDirectory, specPath)) throw new Error(`Linked repository spec is outside its tracker directory: ${issue.specPath}`);
  const spec = await fs.stat(specPath).catch(() => undefined);
  if (!spec?.isFile()) throw new Error(`Linked repository spec is missing: ${issue.specPath}`);
}

async function validateRepositoryTarget(issue: IssueContext): Promise<void> {
  const workspaceRoot = path.dirname(path.dirname(path.dirname(path.dirname(path.resolve(issue.path)))));
  const expected = path.resolve(repositoryPath(workspaceRoot, issue.repository));
  if (path.resolve(issue.repositoryRoot) !== expected || !(await isDirectory(expected))) throw new Error(`Repository target is missing or invalid: ${issue.repositoryRoot}`);
}

export async function validateIssue(issue: IssueContext, _requireWritable = false): Promise<void> {
  if (issue.blockedBy) throw new Error(`Issue is blocked: ${issue.blockedBy}`);
  await validateTrackerPaths(issue);
  await validateRepositoryTarget(issue);
}
