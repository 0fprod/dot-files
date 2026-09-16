import * as fs from "node:fs/promises";
import * as path from "node:path";

const NONE_BLOCKER = "None - can start immediately.";
const REPOSITORY_DIRECTORY = "local-tracker";

interface IssueFile {
  absolutePath: string;
  relativePath: string;
}

interface BlockerLine {
  start: number;
  end: number;
  reference: string;
}

export interface TrackerReferenceNotice {
  filePath: string;
  reference: string;
  reason: string;
}

export interface UnblockResult {
  changedFiles: string[];
  skipped: TrackerReferenceNotice[];
  ambiguous: TrackerReferenceNotice[];
}

type Progress = (message: string) => void;

function normalized(value: string): string {
  return value.replaceAll(path.sep, "/").replaceAll("\\", "/");
}

async function collectIssueFiles(directory: string, root: string, files: IssueFile[]): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectIssueFiles(absolutePath, root, files);
    } else if (entry.isFile() && path.basename(directory) === "issues" && entry.name.endsWith(".md")) {
      files.push({ absolutePath, relativePath: normalized(path.relative(root, absolutePath)) });
    }
  }
}

async function findIssueFiles(root: string): Promise<IssueFile[]> {
  const trackerRoot = path.join(root, REPOSITORY_DIRECTORY);
  const stat = await fs.stat(trackerRoot).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`Local tracker directory is missing: ${trackerRoot}`);
  const files: IssueFile[] = [];
  await collectIssueFiles(trackerRoot, root, files);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function cleanReference(value: string): string {
  return value.trim().replace(/^`(.*)`$/, "$1").replace(/^<(.*)>$/, "$1").trim();
}

function pathAliasMatches(reference: string, target: IssueFile, root: string): boolean {
  const value = normalized(cleanReference(reference));
  const targetRelative = normalized(target.relativePath);
  const targetAbsolute = normalized(path.resolve(root, target.relativePath));
  if (value === targetRelative || value === targetAbsolute) return true;
  const marker = `${REPOSITORY_DIRECTORY}/`;
  const markerIndex = value.indexOf(marker);
  return markerIndex >= 0 && value.slice(markerIndex) === targetRelative;
}

function filenameCandidates(reference: string, files: IssueFile[]): IssueFile[] {
  const value = path.basename(cleanReference(reference));
  const stem = value.endsWith(".md") ? value.slice(0, -3) : value;
  return files.filter((file) => {
    const filename = path.basename(file.absolutePath);
    return filename === value || filename === `${stem}.md` || filename.slice(0, -3) === stem;
  });
}

async function referenceTarget(
  reference: string,
  target: IssueFile,
  files: IssueFile[],
  root: string,
): Promise<"match" | "no-match" | "ambiguous"> {
  if (pathAliasMatches(reference, target, root)) return "match";
  const cleaned = cleanReference(reference);
  if (cleaned.includes("/") || cleaned.includes("\\")) return "no-match";
  const candidates = filenameCandidates(cleaned, files);
  if (candidates.length > 1) return "ambiguous";
  return candidates[0]?.absolutePath === target.absolutePath ? "match" : "no-match";
}

function blockedSection(content: string): { start: number; end: number } | undefined {
  const heading = /^##\s+Blocked by\s*$/im.exec(content);
  if (!heading || heading.index === undefined) return undefined;
  const start = heading.index + heading[0].length;
  const followingHeading = /\n##\s+/m.exec(content.slice(start));
  return { start, end: followingHeading ? start + followingHeading.index : content.length };
}

function blockerLines(section: string): BlockerLine[] {
  const lines: BlockerLine[] = [];
  const linePattern = /[^\n]*(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(section)) !== null) {
    const raw = match[0];
    if (raw.length === 0) break;
    const text = raw.replace(/\r?\n$/, "").trim();
    if (text.length === 0 || /^none(?:\s|$)/i.test(text)) continue;
    const reference = cleanReference(text.replace(/^[-*+]\s+/, ""));
    lines.push({ start: match.index, end: match.index + raw.length, reference });
  }
  return lines;
}

function removeLines(section: string, lines: BlockerLine[]): string {
  return lines.reduceRight((result, line) => result.slice(0, line.start) + result.slice(line.end), section);
}

function canonicalSection(): string {
  return `\n\n${NONE_BLOCKER}\n`;
}

async function candidateAction(
  issue: IssueFile,
  candidate: BlockerLine,
  target: IssueFile,
  files: IssueFile[],
  root: string,
  result: UnblockResult,
): Promise<"remove" | "keep"> {
  const match = await referenceTarget(candidate.reference, target, files, root);
  if (match === "match") return "remove";
  if (match === "ambiguous") {
    result.ambiguous.push({ filePath: issue.absolutePath, reference: candidate.reference, reason: "reference matches multiple issue files" });
  } else {
    result.skipped.push({ filePath: issue.absolutePath, reference: candidate.reference, reason: "reference does not identify the merged issue" });
  }
  return "keep";
}

async function updateIssue(
  issue: IssueFile,
  target: IssueFile,
  files: IssueFile[],
  root: string,
  result: UnblockResult,
  onUpdate?: Progress,
): Promise<void> {
  if (path.resolve(issue.absolutePath) === path.resolve(target.absolutePath)) return;
  const content = await fs.readFile(issue.absolutePath, "utf8");
  const section = blockedSection(content);
  if (!section) return;
  const originalSection = content.slice(section.start, section.end);
  const candidates = blockerLines(originalSection);
  if (candidates.length === 0) return;

  const removals: BlockerLine[] = [];
  for (const candidate of candidates) {
    if (await candidateAction(issue, candidate, target, files, root, result) === "remove") removals.push(candidate);
  }
  if (removals.length === 0) return;

  const remaining = candidates.filter((candidate) => !removals.includes(candidate));
  const replacement = remaining.length === 0 ? canonicalSection() : removeLines(originalSection, removals);
  await fs.writeFile(issue.absolutePath, content.slice(0, section.start) + replacement + content.slice(section.end), "utf8");
  result.changedFiles.push(issue.absolutePath);
  onUpdate?.(`Cleared merged dependency from ${issue.absolutePath}`);
}

export async function unblockDependentIssues(
  workspaceRoot: string,
  completedIssuePath: string,
  onUpdate?: Progress,
): Promise<UnblockResult> {
  const root = path.resolve(workspaceRoot);
  const files = await findIssueFiles(root);
  const completedPath = path.resolve(root, completedIssuePath);
  const completedRealPath = await fs.realpath(completedPath).catch(() => undefined);
  const target = completedRealPath ? await findCompletedIssue(files, completedRealPath) : undefined;
  if (!completedRealPath || !target) throw new Error(`Completed issue is not a local-tracker issue: ${completedIssuePath}`);
  onUpdate?.(`Scanning ${files.length} local-tracker issue(s) for references to ${target.absolutePath}...`);
  const result: UnblockResult = { changedFiles: [], skipped: [], ambiguous: [] };
  for (const issue of files) await updateIssue(issue, target, files, root, result, onUpdate);
  onUpdate?.(`Dependency cleanup complete: ${result.changedFiles.length} file(s) changed, ${result.skipped.length} skipped, ${result.ambiguous.length} ambiguous.`);
  return result;
}

async function findCompletedIssue(files: IssueFile[], completedPath: string): Promise<IssueFile | undefined> {
  for (const file of files) {
    if (await fs.realpath(file.absolutePath).catch(() => undefined) === completedPath) return file;
  }
  return undefined;
}

export function formatUnblockResult(result: UnblockResult): string {
  const lines = [`Changed files: ${result.changedFiles.length}`];
  lines.push(...result.changedFiles.map((file) => `- ${file}`));
  lines.push(`Skipped references: ${result.skipped.length}`);
  lines.push(...result.skipped.map((notice) => `- ${notice.filePath}: ${notice.reference} (${notice.reason})`));
  lines.push(`Ambiguous references: ${result.ambiguous.length}`);
  lines.push(...result.ambiguous.map((notice) => `- ${notice.filePath}: ${notice.reference} (${notice.reason})`));
  return lines.join("\n");
}
