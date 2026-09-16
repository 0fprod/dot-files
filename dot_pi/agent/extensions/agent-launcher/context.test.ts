import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { captureWorkflowContext, propagateWorkflowContext, type WorkflowContextSnapshot } from "./context.ts";

const execFile = promisify(execFileCallback);

function fakePi() {
  return {
    async exec(command: string, args: string[], options: { cwd?: string }) {
      try {
        const result = await execFile(command, args, { cwd: options.cwd, encoding: "utf8" });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
        return { code: typeof failure.code === "number" ? failure.code : 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? String(error) };
      }
    },
  };
}

async function gitFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-context-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "CONTEXT.md"), "committed context\n");
  await writeFile(path.join(root, "src", "app.ts"), "committed application\n");
  await writeFile(path.join(root, "package-lock.json"), "committed lock\n");
  await execFile("git", ["init", "-q", root]);
  await execFile("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await execFile("git", ["-C", root, "config", "user.name", "test"]);
  await execFile("git", ["-C", root, "add", "."]);
  await execFile("git", ["-C", root, "commit", "-qm", "init"]);
  return root;
}

async function clean(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

test("tracked workflow context changes reach the dedicated worktree exactly", async () => {
  const root = await gitFixture();
  const destination = path.join(root, "destination");
  try {
    await writeFile(path.join(root, "CONTEXT.md"), "launch-time context\n");
    await writeFile(path.join(root, "src", "app.ts"), "unrelated application change\n");
    await writeFile(path.join(root, "package-lock.json"), "unrelated lock change\n");
    await writeFile(path.join(root, "src", "generated.ts"), "unrelated generated file\n");
    const snapshot = await captureWorkflowContext(fakePi() as never, root);
    await writeFile(path.join(root, "CONTEXT.md"), "changed after capture\n");
    await mkdir(destination, { recursive: true });
    await propagateWorkflowContext(snapshot, destination);
    assert.equal(await readFile(path.join(destination, "CONTEXT.md"), "utf8"), "launch-time context\n");
    assert.deepEqual(snapshot.unrelatedDirtyPaths.sort(), ["package-lock.json", "src/app.ts", "src/generated.ts"]);
    assert.equal(await readFile(path.join(destination, "src", "app.ts"), "utf8").catch(() => undefined), undefined);
  } finally {
    await clean(root);
  }
});

test("untracked workflow context files are captured by the allowlist", async () => {
  const root = await gitFixture();
  const destination = path.join(root, "destination");
  try {
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "CONTEXT.md"), "new context\n");
    const snapshot = await captureWorkflowContext(fakePi() as never, root);
    await mkdir(destination, { recursive: true });
    await propagateWorkflowContext(snapshot, destination);
    assert.equal(await readFile(path.join(destination, "docs", "CONTEXT.md"), "utf8"), "new context\n");
  } finally {
    await clean(root);
  }
});

test("context propagation rejects a missing worktree target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-context-target-"));
  try {
    const snapshot: WorkflowContextSnapshot = { files: [{ relativePath: "CONTEXT.md", content: Buffer.from("context\n") }], unrelatedDirtyPaths: [] };
    await assert.rejects(propagateWorkflowContext(snapshot, path.join(root, "missing")), /target is missing or not a directory/);
  } finally {
    await clean(root);
  }
});

test("context propagation reports failed file operations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-context-failure-"));
  try {
    const destination = path.join(root, "destination");
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "docs"), "not a directory");
    const snapshot: WorkflowContextSnapshot = { files: [{ relativePath: "docs/CONTEXT.md", content: Buffer.from("context\n") }], unrelatedDirtyPaths: [] };
    await assert.rejects(propagateWorkflowContext(snapshot, destination), /Failed to propagate workflow context docs\/CONTEXT\.md/);
  } finally {
    await clean(root);
  }
});

test("context propagation refuses to overwrite a destination changed by another agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-context-conflict-"));
  try {
    const destination = path.join(root, "destination");
    await mkdir(destination, { recursive: true });
    const snapshot: WorkflowContextSnapshot = { files: [{ relativePath: "CONTEXT.md", content: Buffer.from("launch\n"), baseline: Buffer.from("base\n") }], unrelatedDirtyPaths: [] };
    await writeFile(path.join(destination, "CONTEXT.md"), "other agent\n");
    await assert.rejects(propagateWorkflowContext(snapshot, destination), /Workflow context conflict at CONTEXT\.md/);
  } finally {
    await clean(root);
  }
});
