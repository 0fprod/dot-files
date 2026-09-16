import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { Container, fuzzyFilter, Input, SelectList, Text, type SelectItem } from "@earendil-works/pi-tui";
import { availableThinkingLevels, type AgentRole, type LaunchLocation, type LaunchRequest, type RepositoryScope, ROLE_POLICIES, type ThinkingLevel, type WorkspaceStrategy } from "./core.ts";
import { createIssuePickerTheme } from "./picker-theme.ts";
import { discoverIssues, validateIssue } from "./issues.ts";
import { branchName } from "./workspaces.ts";

const roleOrder: AgentRole[] = ["writer", "reader", "researcher"];
const repositoryFilters: Array<RepositoryScope | "all"> = ["all", "core", "server", "web"];
const locations: LaunchLocation[] = ["tab", "pane", "background"];

type Issue = Awaited<ReturnType<typeof discoverIssues>>[number];

function choose<T extends string>(ctx: ExtensionContext, title: string, values: T[], label: (value: T) => string): Promise<T | undefined> {
  return ctx.ui.select(title, values.map(label)).then((selected) => {
    if (!selected) return undefined;
    const index = values.map(label).indexOf(selected);
    return index < 0 ? undefined : values[index];
  });
}

function selectTheme(theme: Theme) {
  return createIssuePickerTheme(theme);
}

async function searchableChoose<T extends string>(ctx: ExtensionContext, title: string, values: T[], label: (value: T) => string): Promise<T | undefined> {
  const items: SelectItem[] = values.map((value) => ({ value, label: label(value) }));
  const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const input = new Input({ prompt: "Search: " });
    let selecting = false;
    let list = buildSearchList(items, selectTheme(theme), done);
    input.focused = true;
    input.onSubmit = () => {
      if (!list.getSelectedItem()) return;
      selecting = true;
      input.focused = false;
      tui.requestRender();
    };
    input.onEscape = () => done(null);
    container.addChild(new Text(title));
    container.addChild(input);
    container.addChild(list);
    container.addChild(new Text("Type to filter • enter to browse • ↑↓ navigate • enter select • esc cancel"));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (selecting) list.handleInput(data);
        else {
          input.handleInput(data);
          list = buildSearchList(fuzzyFilter(items, input.getValue(), (item) => item.label), selectTheme(theme), done);
          container.children[2] = list;
        }
        tui.requestRender();
      },
    };
  });
  return selected === null || selected === undefined ? undefined : values.find((value) => value === selected);
}

function buildSearchList(items: SelectItem[], theme: ReturnType<typeof selectTheme>, done: (value: string | null) => void): SelectList {
  const list = new SelectList(items, Math.min(items.length, 8), theme);
  list.onSelect = (item) => done(item.value);
  list.onCancel = () => done(null);
  return list;
}

function issueLabel(issue: Issue): string {
  const key = issue.jiraId ?? "no-jira";
  const blocked = issue.blockedBy ? ` [blocked: ${issue.blockedBy}]` : "";
  return `${issue.repository.toUpperCase()}  ${key}  ${issue.title}${blocked}`;
}

function roleLabel(value: AgentRole): string { return `${value[0].toUpperCase()}${value.slice(1)} — ${ROLE_POLICIES[value].description}`; }
function repositoryLabel(value: RepositoryScope | "all"): string { return value === "all" ? "All repositories" : value.toUpperCase(); }
function locationLabel(value: LaunchLocation): string { return value === "tab" ? "New Herdr tab (recommended)" : value === "pane" ? "Split Herdr pane" : "Background process"; }
function workspaceLabel(value: WorkspaceStrategy): string { return value === "worktrunk" ? "Dedicated Worktrunk worktree (recommended)" : "Existing checkout"; }

async function chooseIssue(ctx: ExtensionContext, workspaceRoot: string): Promise<Issue | undefined> {
  const filter = await choose(ctx, "Filter issues by repository", repositoryFilters, repositoryLabel);
  if (!filter) return undefined;
  const issues = await discoverIssues(workspaceRoot, filter);
  if (issues.length === 0) throw new Error("No approved local-tracker issues found");
  const labels = issues.map(issueLabel);
  const selected = await searchableChoose(ctx, "Select one approved issue", labels, (value) => value);
  return selected ? issues[labels.indexOf(selected)] : undefined;
}

async function chooseWorkspace(ctx: ExtensionContext, role: AgentRole): Promise<WorkspaceStrategy | undefined> {
  if (role !== "writer") return "existing";
  return choose(ctx, "Select Writer workspace", ["worktrunk", "existing"], workspaceLabel);
}

function modelKey(model: Model<any>): string { return `${model.provider}/${model.id}`; }

function modelChoices(ctx: ExtensionContext): Model<any>[] {
  const scoped = ctx.scopedModels?.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
  return [...scoped].sort((left, right) => modelKey(left).localeCompare(modelKey(right)));
}

async function chooseModel(ctx: ExtensionContext, role: AgentRole): Promise<{ model: string; thinking: ThinkingLevel } | undefined> {
  await ctx.modelRegistry.refresh().catch(() => undefined);
  const models = modelChoices(ctx);
  if (models.length === 0) throw new Error("No available Pi models");
  const selectedModelKey = await searchableChoose(ctx, "Select model", models.map(modelKey), (value) => value);
  if (!selectedModelKey) return undefined;
  const selectedModel = models.find((model) => modelKey(model) === selectedModelKey);
  if (!selectedModel) throw new Error(`Selected model is unavailable: ${selectedModelKey}`);
  const levels = availableThinkingLevels(selectedModel);
  const preferred = ROLE_POLICIES[role].defaultThinking;
  const orderedLevels = levels.includes(preferred) ? [preferred, ...levels.filter((level) => level !== preferred)] : levels;
  const thinking = await choose(ctx, `Thinking level for ${selectedModelKey}`, orderedLevels, (value) => value);
  return thinking ? { model: selectedModelKey, thinking } : undefined;
}

async function confirmRequest(ctx: ExtensionContext, request: LaunchRequest): Promise<LaunchRequest | undefined> {
  const { issue, additionalInstructions } = request;
  const preview = [
    `Role: ${request.role}`, `Issue: ${issue.path}`, `Spec: ${issue.specPath}`, `Repository: ${issue.repository}`,
    `Workspace: ${request.workspace}`, `Branch: ${request.workspace === "worktrunk" ? branchName(issue) : "existing checkout"}`, `Location: ${request.location}`, `Model: ${request.model}`, `Thinking: ${request.thinking}`,
    `Additional instructions: ${additionalInstructions || "none"}`,
  ].join("\n");
  return await ctx.ui.confirm("Confirm agent launch", preview) ? request : undefined;
}

export async function collectLaunchRequest(_pi: ExtensionAPI, ctx: ExtensionContext, workspaceRoot: string): Promise<LaunchRequest | undefined> {
  const role = await choose(ctx, "Select agent role", roleOrder, roleLabel);
  if (!role) return undefined;
  const issue = await chooseIssue(ctx, workspaceRoot);
  if (!issue) return undefined;
  await validateIssue(issue, role === "writer");
  const workspace = await chooseWorkspace(ctx, role);
  if (!workspace) return undefined;
  const location = await choose(ctx, "Select launch location", locations, locationLabel);
  if (!location) return undefined;
  const model = await chooseModel(ctx, role);
  if (!model) return undefined;
  const additionalInstructions = await ctx.ui.editor("Additional instructions for this run (optional)", "");
  if (additionalInstructions === undefined) return undefined;
  return confirmRequest(ctx, { role, issue, workspace, location, model: model.model, thinking: model.thinking, ...(additionalInstructions.trim() ? { additionalInstructions } : {}) });
}
