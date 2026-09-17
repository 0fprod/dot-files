import type { IssueContext } from "./core.ts";

export interface ReviewArguments { cwd: string; issue: string; fixedPoint?: string; }
export interface ReviewBriefs { standards: string; spec: string; }

const REVIEW_OPTIONS = ["--cwd", "--issue", "--fixed-point"] as const;
type ReviewOption = typeof REVIEW_OPTIONS[number];

function optionValue(tokens: string[], index: number, option: ReviewOption): { value: string; next: number } {
  const token = tokens[index] ?? "";
  const prefix = `${option}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), next: index };
  const value = tokens[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return { value, next: index + 1 };
}

export function parseReviewArguments(raw: string): ReviewArguments {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  const values: Partial<Record<ReviewOption, string>> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const option = REVIEW_OPTIONS.find((candidate) => tokens[index] === candidate || tokens[index]?.startsWith(`${candidate}=`));
    if (!option) throw new Error(`Unknown /review option: ${tokens[index]}`);
    const parsed = optionValue(tokens, index, option);
    values[option] = parsed.value;
    index = parsed.next;
  }
  const cwd = values["--cwd"];
  const issue = values["--issue"];
  if (!cwd || !issue) throw new Error("Usage: /review --cwd <writer-worktree> --issue <issue-path> [--fixed-point <commit>]");
  if (!cwd.startsWith("/") || !issue.startsWith("/")) throw new Error("/review requires absolute --cwd and --issue paths");
  return { cwd, issue, ...(values["--fixed-point"] ? { fixedPoint: values["--fixed-point"] } : {}) };
}

function changeInstructions(target: string, dirty: boolean, fixedPoint?: string): string {
  if (dirty) return `For a dirty target, review git -C ${target} diff HEAD -- and all files listed by git -C ${target} ls-files --others --exclude-standard.`;
  return `For a clean target, review git -C ${target} diff ${fixedPoint}...HEAD and git -C ${target} log ${fixedPoint}..HEAD --oneline.`;
}

export function buildReviewBriefs(
  target: string,
  issue: IssueContext,
  dirty: boolean,
  fixedPoint: string | undefined,
  standardsRubric: string,
  specRubric: string,
  standards: string[],
): ReviewBriefs {
  const change = changeInstructions(target, dirty, fixedPoint);
  return {
    standards: `Review only the change target at ${target} for repository standards.\nRemain strictly read-only: do not edit files, Git state, Jira, databases, or external systems. Read ${standardsRubric} completely.\n\n${change}\nApplicable standards: ${standards.length ? standards.join(", ") : "none"}.\n\nThis is the Standards review: do not read or assess the originating product issue/spec. Skip formatting and checks already enforced by tooling. Report actionable findings in the rubric's exact output format, with severity, file, line, evidence, and rule. Do not modify anything.`,
    spec: `Review only the change target at ${target} against the complete issue at ${issue.path} and complete approved spec at ${issue.specPath}. Remain strictly read-only: do not edit files, Git state, Jira, databases, or external systems. Read both documents completely, then read ${specRubric} completely.\n\n${change}\nTrace every acceptance criterion in the issue and spec to changed code and tests. Report only missing, incorrect, unsupported, or unverified requirements, citing the requirement text and changed file/line. Use the rubric's exact output format. Do not report style concerns and do not modify anything.`,
  };
}
