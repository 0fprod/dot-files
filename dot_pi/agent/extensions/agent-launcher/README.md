# Agent launcher

Pi extension for launching approved local-tracker collaborators from a Herdr
orchestrator.

## Commands

### `/agent`

Interactive single-agent launcher. Selects:

- role: Writer, Reader, or Researcher;
- approved Core, Server, or Web issue;
- Writer workspace strategy;
- Herdr location, model, and thinking level.

Writers use a dedicated Worktrunk worktree by default. Readers and Researchers
use the canonical repository checkout and remain read-only. Visible tabs route
to the canonical Herdr workspace: `nomo-server-app` for Core/Server and
`nomo-web-app` for Web.

### `/review`

One-shot two-angle review launcher:

```text
/review --cwd <absolute-Writer-worktree> --issue <absolute-issue-path>
```

For a clean target, provide a fixed point:

```text
/review --cwd <worktree> --issue <issue> --fixed-point <commit>
```

The command:

1. validates the target Git repository and review range;
2. resolves and validates the approved issue and its blockers;
3. prepares separate Standards and Spec briefs;
4. reuses the orchestrator's current model;
5. asks for one confirmation;
6. launches exactly two fresh Reader tabs sequentially.

Both Readers receive the Writer worktree as review target. The Standards Reader
reviews changed files and applicable `AGENTS.md`/`CONTRIBUTING.md` files only;
it must not assess the product issue or spec. The Spec Reader reads the complete
issue and approved spec and traces every acceptance criterion to changed code
and tests.

The Writer pane and worktree stay open for accepted review fixes. A failed
launch leaves any successfully created Reader available and reports the failed
angle; inspect Herdr state before retrying.

## Implementation map

- `index.ts` — registers `/agent` and `/review`.
- `wizard.ts` — interactive single-agent request flow.
- `review.ts` — target validation and sequential two-Reader orchestration.
- `review-core.ts` — review argument parsing and brief construction.
- `launch.ts` — Herdr/Pi process and tab launch.
- `workspaces.ts` — Worktrunk preparation and repository validation.
- `core.ts` — roles, prompts, workspace mapping, and launch contracts.

Reload Pi after extension changes:

```text
/reload
```

Run tests from this directory:

```text
npm test
```
