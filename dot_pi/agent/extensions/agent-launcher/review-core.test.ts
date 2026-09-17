import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewBriefs, parseReviewArguments } from "./review-core.ts";

const issue = {
  path: "/workspace/local-tracker/server/issues/ITA-123-01.md",
  specPath: "/workspace/local-tracker/server/specs/ITA-123.md",
  repository: "server" as const,
  title: "Implement mapping",
  jiraId: "ITA-123",
  repositoryRoot: "/workspace/nomo-server-app",
};

test("review arguments require absolute target and issue paths", () => {
  assert.deepEqual(parseReviewArguments("--cwd=/worktree --issue /workspace/issue.md"), { cwd: "/worktree", issue: "/workspace/issue.md" });
  assert.deepEqual(parseReviewArguments("--cwd /worktree --issue /workspace/issue.md --fixed-point abc123"), { cwd: "/worktree", issue: "/workspace/issue.md", fixedPoint: "abc123" });
  assert.throws(() => parseReviewArguments("--cwd worktree --issue /workspace/issue.md"), /absolute/);
});

test("review briefs keep standards and spec scopes independent", () => {
  const briefs = buildReviewBriefs("/worktree", issue, true, undefined, "/skills/STANDARDS-REVIEW.md", "/skills/SPEC-REVIEW.md", ["/worktree/AGENTS.md"]);
  assert.match(briefs.standards, /STANDARDS-REVIEW/);
  assert.match(briefs.standards, /AGENTS\.md/);
  assert.doesNotMatch(briefs.standards, /ITA-123|SPEC-REVIEW|local-tracker\/server\/specs/);
  assert.match(briefs.spec, /ITA-123-01\.md/);
  assert.match(briefs.spec, /SPEC-REVIEW/);
});
