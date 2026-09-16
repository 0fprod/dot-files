import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireWriterLease } from "./writer-lock.ts";

const options = (stateDir: string, repositoryId: string, workingTree: string, paneExists: (paneId: string) => Promise<boolean>, ownershipKey?: string) => ({ stateDir, repositoryId, workingTree, profile: "writer", paneExists, ...(ownershipKey ? { ownershipKey } : {}) });

test("one live writer pane owns a canonical repository", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-lock-"));
  try {
    const first = await acquireWriterLease(options(stateDir, "/repo/.git", "/worktree-one", async () => false));
    await first.attachPane("w1:p2");
    await assert.rejects(acquireWriterLease(options(stateDir, "/repo/.git", "/worktree-two", async (paneId) => paneId === "w1:p2")), /already owns this writer scope/i);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("separate worktrees in one canonical repository allow independent writers", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-lock-"));
  try {
    const first = await acquireWriterLease(options(stateDir, "/repo/.git", "/worktree-one", async () => false, "/worktree-one"));
    await first.attachPane("w1:p2");
    const second = await acquireWriterLease(options(stateDir, "/repo/.git", "/worktree-two", async () => true, "/worktree-two"));
    await second.attachPane("w1:p3");
    assert.notEqual(first.lockPath, second.lockPath);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("the same dedicated worktree remains exclusive", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-lock-"));
  try {
    const first = await acquireWriterLease(options(stateDir, "/repo/.git", "/worktree-one", async () => false, "/worktree-one"));
    await first.attachPane("w1:p2");
    await assert.rejects(acquireWriterLease(options(stateDir, "/repo/.git", "/worktree-one", async (paneId) => paneId === "w1:p2", "/worktree-one")), /already owns this writer scope/i);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("separate canonical Git repositories allow independent writers", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-lock-"));
  try {
    const server = await acquireWriterLease(options(stateDir, "/server/.git", "/server", async () => true));
    await server.attachPane("w1:p2");
    const web = await acquireWriterLease(options(stateDir, "/web/.git", "/web", async () => true));
    await web.attachPane("w1:p3");
    assert.notEqual(server.lockPath, web.lockPath);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("a live background writer process owns a canonical repository", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-lock-"));
  try {
    const first = await acquireWriterLease({ ...options(stateDir, "/repo/.git", "/worktree-one", async () => false), processExists: (pid) => pid === 4242 });
    await first.attachProcess(4242);
    await assert.rejects(acquireWriterLease({ ...options(stateDir, "/repo/.git", "/worktree-two", async () => false), processExists: (pid) => pid === 4242 }), /already owns this writer scope/i);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});

test("a dead writer pane can be replaced", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-lock-"));
  try {
    const first = await acquireWriterLease(options(stateDir, "/repo/.git", "/repo", async () => false));
    await first.attachPane("w1:p2");
    const replacement = await acquireWriterLease(options(stateDir, "/repo/.git", "/repo-two", async () => false));
    assert.equal(typeof replacement.lockPath, "string");
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
