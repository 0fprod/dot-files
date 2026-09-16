import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repositoryPath } from "./core.ts";
import { branchName, prepareWorkspace } from "./workspaces.ts";

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

test("local issues get descriptive Worktrunk branches without invented Jira IDs", () => {
  assert.equal(branchName({ path: "/workspace/local-tracker/server/issues/unsupported-inbound-import.md", specPath: "/workspace/local-tracker/server/specs/unsupported-inbound-import.md", repository: "server", title: "Unsupported inbound import", repositoryRoot: "/workspace/nomo-server-app" }), "feature/unsupported-inbound-import");
});

test("Worktrunk creation copies included ignored files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-worktree-"));
  const repository = path.join(root, "nomo-server-app");
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, ".gitignore"), ".env\n");
  await writeFile(path.join(repository, ".worktreeinclude"), ".env\n");
  await writeFile(path.join(repository, ".env"), "WORKTREE_SECRET=present\n");
  await execFile("git", ["init", "-q", "-b", "develop", repository]);
  await execFile("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await execFile("git", ["-C", repository, "config", "user.name", "test"]);
  await execFile("git", ["-C", repository, "add", ".gitignore", ".worktreeinclude"]);
  await execFile("git", ["-C", repository, "commit", "-qm", "init"]);
  let workspace: { cwd: string; branch?: string } | undefined;
  try {
    const issue = { path: path.join(root, "local-tracker/server/issues/ITA-1.md"), specPath: path.join(root, "local-tracker/server/specs/ITA-1.md"), repository: "server" as const, title: "Local issue", jiraId: "ITA-1", repositoryRoot: repository };
    workspace = await prepareWorkspace(fakePi() as never, issue, "worktrunk");
    assert.equal(await readFile(path.join(workspace.cwd, ".env"), "utf8"), "WORKTREE_SECRET=present\n");
  } finally {
    if (workspace) await execFile("git", ["-C", repository, "worktree", "remove", "--force", workspace.cwd]);
    if (workspace?.branch) await execFile("git", ["-C", repository, "branch", "-D", workspace.branch]);
    await rm(root, { recursive: true, force: true });
  }
});

test("Dedicated Worktrunk worktrees receive the captured context before later source edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-context-worktree-"));
  const repository = path.join(root, "nomo-server-app");
  await mkdir(repository, { recursive: true });
  await writeFile(path.join(repository, "CONTEXT.md"), "committed context\n");
  await writeFile(path.join(repository, "application.ts"), "committed application\n");
  await execFile("git", ["init", "-q", "-b", "develop", repository]);
  await execFile("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await execFile("git", ["-C", repository, "config", "user.name", "test"]);
  await execFile("git", ["-C", repository, "add", "."]);
  await execFile("git", ["-C", repository, "commit", "-qm", "init"]);
  let workspace: { cwd: string; branch?: string } | undefined;
  try {
    await writeFile(path.join(repository, "CONTEXT.md"), "launch-time context\n");
    await writeFile(path.join(repository, "application.ts"), "unrelated application change\n");
    const issue = { path: path.join(root, "local-tracker/server/issues/agent.md"), specPath: path.join(root, "local-tracker/server/specs/agent.md"), repository: "server" as const, title: "Context propagation", jiraId: "ITA-1", repositoryRoot: repository };
    workspace = await prepareWorkspace(fakePi() as never, issue, "worktrunk");
    assert.equal(await readFile(path.join(workspace.cwd, "CONTEXT.md"), "utf8"), "launch-time context\n");
    assert.equal(await readFile(path.join(workspace.cwd, "application.ts"), "utf8"), "committed application\n");
  } finally {
    if (workspace) await execFile("git", ["-C", repository, "worktree", "remove", "--force", workspace.cwd]);
    if (workspace?.branch) await execFile("git", ["-C", repository, "branch", "-D", workspace.branch]);
    await rm(root, { recursive: true, force: true });
  }
});

test("Core existing checkout targets the package while preserving monorepo identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-workspace-"));
  const repository = path.join(root, "nomo-server-app");
  const packageDirectory = path.join(repository, "packages", "core");
  await mkdir(packageDirectory, { recursive: true });
  await execFile("git", ["init", "-q", repository]);
  try {
    const issue = { path: path.join(root, "local-tracker/core/issues/ITA-1.md"), specPath: path.join(root, "local-tracker/core/specs/ITA-1.md"), repository: "core" as const, title: "Issue", jiraId: "ITA-1", repositoryRoot: packageDirectory };
    const workspace = await prepareWorkspace(fakePi() as never, issue, "existing");
    assert.equal(workspace.cwd, packageDirectory);
    assert.equal(workspace.repositoryId, await realpath(path.join(repository, ".git")));
    assert.equal(repositoryPath(root, "core"), packageDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
