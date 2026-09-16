import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupMergedTracker, cleanupMessage } from "./github-tracker.ts";

function fakePi(state: "OPEN" | "MERGED") {
  return {
    async exec() { return { code: 0, stdout: JSON.stringify({ state, isDraft: false, url: "https://github.com/example/repo/pull/1" }), stderr: "" }; },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "github-tracker-unblocking-"));
  const issues = path.join(root, "local-tracker", "server", "issues");
  await mkdir(issues, { recursive: true });
  const completed = path.join(issues, "completed.md");
  const downstream = path.join(issues, "downstream.md");
  await writeFile(completed, "# Completed\n");
  await writeFile(downstream, `# Downstream\n\n## Blocked by\n- ${completed}\n`);
  return { root, completed, downstream };
}

test("merged PR cleanup clears downstream tracker dependencies", async () => {
  const { root, completed, downstream } = await fixture();
  try {
    const response = await cleanupMergedTracker(fakePi("MERGED") as never, { selector: 1, cwd: root, issuePath: completed }, undefined, undefined, root);

    assert.equal(response.cleanup?.changedFiles.length, 1);
    assert.match(cleanupMessage(response), /Changed files: 1/);
    assert.match(await readFile(downstream, "utf8"), /None - can start immediately\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("open PR cleanup leaves downstream tracker dependencies untouched", async () => {
  const { root, completed, downstream } = await fixture();
  try {
    const response = await cleanupMergedTracker(fakePi("OPEN") as never, { selector: 1, cwd: root, issuePath: completed }, undefined, undefined, root);

    assert.equal(response.cleanup, undefined);
    assert.match(cleanupMessage(response), /No tracker changes/);
    assert.match(await readFile(downstream, "utf8"), /completed\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
