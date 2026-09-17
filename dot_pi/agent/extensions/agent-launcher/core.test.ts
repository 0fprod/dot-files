import assert from "node:assert/strict";
import test from "node:test";
import { availableThinkingLevels, buildInitialPrompt, buildPiCommand, choosePanePlacement, modelListContains, ROLE_POLICIES, type LaunchRequest } from "./core.ts";

const issue = { path: "/workspace/local-tracker/server/issues/ITA-123-01.md", specPath: "/workspace/local-tracker/server/specs/ITA-123.md", repository: "server" as const, title: "Implement mapping", jiraId: "ITA-123", repositoryRoot: "/workspace/nomo-server-app" };
const request: LaunchRequest = { role: "writer", issue, workspace: "worktrunk", location: "tab", model: "openai-codex/gpt-5.4", thinking: "high" };

test("role policies expose exactly the three launch roles", () => {
  assert.deepEqual(Object.keys(ROLE_POLICIES), ["writer", "reader", "researcher"]);
  assert.ok(ROLE_POLICIES.writer.tools.includes("worktrunk_tools"));
});
test("thinking levels respect model reasoning support", () => {
  assert.deepEqual(availableThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(availableThinkingLevels({ reasoning: true, thinkingLevelMap: { high: null } }), ["off", "minimal", "low", "medium", "xhigh", "max"]);
});
test("the pane planner opens the first collaborator to the right", () => assert.deepEqual(choosePanePlacement("w1:p1", [{ paneId: "w1:p1", width: 140, height: 50 }]), { targetPaneId: "w1:p1", direction: "right" }));
test("the pane planner stacks later collaborators in the largest other pane", () => assert.deepEqual(choosePanePlacement("w1:p1", [{ paneId: "w1:p1", width: 70, height: 50 }, { paneId: "w1:p2", width: 70, height: 30 }, { paneId: "w1:p3", width: 60, height: 20 }]), { targetPaneId: "w1:p2", direction: "down" }));
test("the Pi command applies launch-time model and thinking", () => assert.equal(buildPiCommand(request, "writer: ITA-123", "/tmp/writer.md"), "pi --model 'openai-codex/gpt-5.4' --thinking 'high' --tools 'read,bash,edit,write,todo,worktrunk_tools,wt_list,wt_switch,wt_remove,wt_merge' --append-system-prompt '/tmp/writer.md' --name 'writer: ITA-123'"));
test("model validation requires an exact provider and model", () => {
  const output = "provider      model\nopenai-codex  gpt-5.4\nopenai-codex  gpt-5.4-mini\n";
  assert.equal(modelListContains(output, "openai-codex/gpt-5.4"), true);
  assert.equal(modelListContains(output, "openai-codex/gpt-5"), false);
});
test("Writer kickoff is fresh and enters Temper with optional focus", () => {
  const additionalInstructions = " Focus on mapper tests.\n  Keep the fixture unchanged. ";
  const prompt = buildInitialPrompt({ ...request, additionalInstructions }, "/worktrees/feature/ITA-123_mapping");
  assert.match(prompt, /^\/skill:temper Implement exactly/);
  assert.match(prompt, /ITA-123-01\.md/);
  assert.ok(prompt.includes(additionalInstructions));
  assert.doesNotMatch(prompt, /handoff|fork|clone|skill:worktrunk/i);
  assert.match(prompt, /Worktrunk extension tools/);
});
test("Reader kickoff follows the review brief for document scope", () => {
  const prompt = buildInitialPrompt({ ...request, role: "reader" }, "/workspace/nomo-server-app");
  assert.doesNotMatch(prompt, /^\/skill:temper/);
  assert.ok(prompt.includes(ROLE_POLICIES.reader.systemInstructions));
  assert.doesNotMatch(ROLE_POLICIES.reader.systemInstructions, /linked repository spec/);
  assert.match(prompt, /launch brief's document scope/);
  assert.doesNotMatch(prompt, /Read the complete issue, linked spec/);
});

test("Standards kickoff does not include issue or spec paths", () => {
  const prompt = buildInitialPrompt({ ...request, role: "reader", readerAngle: "standards" }, "/worktree/ITA-123");
  assert.match(prompt, /supplied change target/);
  assert.doesNotMatch(prompt, /local-tracker\/server\/(issues|specs)/);
});

test("Researcher kickoff remains read-only and reads its linked spec", () => {
  const prompt = buildInitialPrompt({ ...request, role: "researcher" }, "/workspace/nomo-server-app");
  assert.doesNotMatch(prompt, /^\/skill:temper/);
  assert.ok(prompt.includes(ROLE_POLICIES.researcher.systemInstructions));
  assert.match(prompt, /Read the complete issue, linked spec/);
});
