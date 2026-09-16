import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveLaunchCwd } from "./target.ts";

test("The launch target resolves independently of the orchestrator directory", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-launcher-target-"));
  try {
    const packageDirectory = path.join(workspace, "nomo-server-app", "packages", "core");
    await mkdir(packageDirectory, { recursive: true });

    assert.equal(
      await resolveLaunchCwd(workspace, "nomo-server-app/packages/core"),
      await realpath(packageDirectory),
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
