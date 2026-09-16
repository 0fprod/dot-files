import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unblockDependentIssues } from "./unblocking.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-unblocking-"));
  const issueDirectory = path.join(root, "local-tracker", "server", "issues");
  await mkdir(issueDirectory, { recursive: true });
  const completed = path.join(issueDirectory, "completed.md");
  await writeFile(completed, "# Completed\n");
  return { root, completed, issueDirectory };
}

test("unblocking removes only the merged dependency and preserves other blockers", async () => {
  const { root, completed, issueDirectory } = await fixture();
  try {
    const downstream = path.join(issueDirectory, "downstream.md");
    await writeFile(
      downstream,
      `# Downstream\n\n## Goal\nKeep this text.\n\n## Blocked by\n\n- ${completed}\n- local-tracker/server/issues/other.md\n\n## Acceptance criteria\n- [ ] Keep this criterion\n`,
    );

    const result = await unblockDependentIssues(root, completed);

    assert.deepEqual(result.changedFiles, [downstream]);
    assert.match(await readFile(downstream, "utf8"), /- local-tracker\/server\/issues\/other\.md/);
    assert.doesNotMatch(await readFile(downstream, "utf8"), /completed\.md/);
    assert.match(await readFile(downstream, "utf8"), /Keep this criterion/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unblocking clears cross-repository references from shared tracker paths", async () => {
  const { root, issueDirectory } = await fixture();
  try {
    const coreIssueDirectory = path.join(root, "local-tracker", "core", "issues");
    await mkdir(coreIssueDirectory, { recursive: true });
    const completed = path.join(coreIssueDirectory, "shared-contract.md");
    await writeFile(completed, "# Shared contract\n");
    const downstream = path.join(issueDirectory, "downstream.md");
    await writeFile(downstream, `# Downstream\n\n## Blocked by\n- local-tracker/core/issues/shared-contract.md\n`);

    const result = await unblockDependentIssues(root, completed);

    assert.deepEqual(result.changedFiles, [downstream]);
    assert.match(await readFile(downstream, "utf8"), /None - can start immediately\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unblocking writes the parser-compatible clear value and is idempotent", async () => {
  const { root, completed, issueDirectory } = await fixture();
  try {
    const downstream = path.join(issueDirectory, "downstream.md");
    await writeFile(downstream, `# Downstream\n\n## Blocked by\n- ${completed}\n`);

    const first = await unblockDependentIssues(root, completed);
    const second = await unblockDependentIssues(root, completed);

    assert.deepEqual(first.changedFiles, [downstream]);
    assert.deepEqual(second.changedFiles, []);
    assert.match(await readFile(downstream, "utf8"), /## Blocked by\n\nNone - can start immediately\.\n/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unblocking reports ambiguous and skipped references without modifying them", async () => {
  const { root, completed, issueDirectory } = await fixture();
  try {
    const otherIssueDirectory = path.join(root, "local-tracker", "web", "issues");
    await mkdir(otherIssueDirectory, { recursive: true });
    await writeFile(path.join(otherIssueDirectory, "completed.md"), "# Other\n");
    const downstream = path.join(issueDirectory, "downstream.md");
    await writeFile(downstream, `# Downstream\n\n## Blocked by\n- completed.md\n- /other/path/completed.md\n- ${completed}\n- an unresolved dependency\n`);

    const result = await unblockDependentIssues(root, completed);

    assert.deepEqual(result.changedFiles, [downstream]);
    assert.equal(result.ambiguous.length, 1);
    assert.equal(result.skipped.length, 2);
    assert.match(await readFile(downstream, "utf8"), /- completed\.md/);
    assert.match(await readFile(downstream, "utf8"), /- an unresolved dependency/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
