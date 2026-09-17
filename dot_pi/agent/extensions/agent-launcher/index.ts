import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectLaunchRequest } from "./wizard.ts";
import { findWorkspaceRoot } from "./issues.ts";
import { launchAgent, validateModel } from "./launch.ts";
import { prepareWorkspace, worktreePreview } from "./workspaces.ts";
import { runReviewCommand } from "./review.ts";

const PROGRESS_WIDGET = "agent-launcher-progress";
const SPINNER_FRAMES = ["|", "/", "-", "\\"];

interface LaunchProgress {
  update(message: string): void;
  stop(): void;
}

function createLaunchProgress(ctx: ExtensionContext): LaunchProgress {
  let frame = 0;
  let message = "Starting agent launch...";
  const render = () => {
    ctx.ui.setStatus(PROGRESS_WIDGET, message);
    ctx.ui.setWidget(PROGRESS_WIDGET, [`${SPINNER_FRAMES[frame]} ${message}`]);
  };
  const timer = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length;
    render();
  }, 120);
  render();
  return {
    update(nextMessage) {
      message = nextMessage;
      render();
    },
    stop() {
      clearInterval(timer);
      ctx.ui.setStatus(PROGRESS_WIDGET, undefined);
      ctx.ui.setWidget(PROGRESS_WIDGET, undefined);
    },
  };
}

export default function agentLauncher(pi: ExtensionAPI): void {
  pi.registerCommand("review", {
    description: "Launch Standards and Spec Reader reviews for a Writer worktree",
    handler: async (args, ctx) => {
      try { await runReviewCommand(pi, ctx, args); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); }
    },
  });

  pi.registerCommand("agent", {
    description: "Launch one fresh Reader, Researcher, or Writer session for an approved issue",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/agent is interactive only; run it without arguments", "warning");
        return;
      }
      try {
        const workspaceRoot = await findWorkspaceRoot(ctx.cwd);
        const request = await collectLaunchRequest(pi, ctx, workspaceRoot);
        if (!request) {
          ctx.ui.notify("Agent launch cancelled", "info");
          return;
        }
        const progress = createLaunchProgress(ctx);
        try {
          progress.update("Validating selected model...");
          await validateModel(pi, request.model, ctx.signal);
          progress.update("Preparing Worktrunk worktree...");
          const workspace = await prepareWorkspace(pi, request.issue, request.workspace, ctx.signal, progress.update);
          progress.update(`Worktree ready: ${worktreePreview(workspace)}`);
          const result = await launchAgent(pi, request, workspace, ctx.signal, progress.update);
          const target = result.tabId ? `tab ${result.tabId}` : result.paneId ? `pane ${result.paneId}` : `pid ${result.pid}`;
          progress.update(`${request.role} launched in ${target}`);
          ctx.ui.notify(`${request.role} launched in ${target}`, "info");
        } finally {
          progress.stop();
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
