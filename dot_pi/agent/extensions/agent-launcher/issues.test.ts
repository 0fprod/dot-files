import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverIssues, validateIssue } from "./issues.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-issues-"));
  const tracker = path.join(root, "local-tracker", "server");
  await mkdir(path.join(tracker, "issues"), { recursive: true });
  await mkdir(path.join(tracker, "specs"), { recursive: true });
  await mkdir(path.join(root, "nomo-server-app"), { recursive: true });
  await writeFile(path.join(tracker, "specs", "ITA-123.md"), "# ITA-123\n");
  await writeFile(path.join(tracker, "issues", "ITA-123-01-build.md"), `# ITA-123-01 — Build it\n\n## Parent\n- Jira: ITA-123\n- Spec: local-tracker/server/specs/ITA-123.md\n\n## Blocked by\nNone - can start immediately.\n`);
  return { root };
}

test("discovery accepts the documented issue shape without a Repository heading", async () => {
  const { root } = await fixture();
  try {
    const issues = await discoverIssues(root, "server");
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.jiraId, "ITA-123");
    assert.equal(issues[0]?.specPath, path.join(root, "local-tracker/server/specs/ITA-123.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validation requires the selected issue and spec to stay in tracker directories", async () => {
  const { root } = await fixture();
  try {
    const issue = (await discoverIssues(root, "server"))[0];
    assert.ok(issue);
    await validateIssue(issue, true);
    const { jiraId: _jiraId, ...localIssue } = issue;
    await validateIssue(localIssue, true);
    await assert.rejects(validateIssue({ ...issue, path: path.join(root, "outside.md") }), /outside its approved tracker directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
