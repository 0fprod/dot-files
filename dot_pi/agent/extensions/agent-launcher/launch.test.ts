import assert from "node:assert/strict";
import test from "node:test";
import { workspaceIdForLabel, workspaceLabelForRepository } from "./core.ts";

test("repository launches map to their canonical Herdr workspaces", () => {
  assert.equal(workspaceLabelForRepository("core"), "nomo-server-app");
  assert.equal(workspaceLabelForRepository("server"), "nomo-server-app");
  assert.equal(workspaceLabelForRepository("web"), "nomo-web-app");
});

test("workspace lookup resolves the exact Herdr workspace label", () => {
  const output = JSON.stringify({ result: { workspaces: [
    { workspace_id: "wC", label: "nomo-server-app" },
    { workspace_id: "w6", label: "nomo-web-app" },
  ] } });
  assert.equal(workspaceIdForLabel(output, "nomo-server-app"), "wC");
});

test("workspace lookup rejects missing and duplicate labels", () => {
  const missing = JSON.stringify({ result: { workspaces: [{ workspace_id: "wC", label: "nomo-server-app" }] } });
  assert.throws(() => workspaceIdForLabel(missing, "missing"), /workspace not found: missing/);
  const duplicate = JSON.stringify({ workspaces: [
    { workspace_id: "w1", label: "nomo-server-app" },
    { workspace_id: "w2", label: "nomo-server-app" },
  ] });
  assert.throws(() => workspaceIdForLabel(duplicate, "nomo-server-app"), /label is ambiguous/);
});
