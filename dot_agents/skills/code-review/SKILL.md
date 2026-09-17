---
name: code-review
description: Explain the workspace's two-angle read-only review workflow. Use `/review` for the normal one-shot launch.
disable-model-invocation: true
argument-hint: "[--cwd <target> --issue <path> [--fixed-point <commit>]]"
---

# Code Review

The normal review flow is one explicit command from the orchestrator:

```text
/review --cwd <absolute-Writer-worktree> --issue <absolute-issue-path>
```

For a clean target, add `--fixed-point <commit>`. `/review` requires the
orchestrator to be inside Herdr and then:

- validates the Git target and approved issue;
- rejects active tracker blockers; if a dependency is confirmed merged, clear only that reference with `github_tools`/`gh_pr_unblock`, then rerun;
- prepares independent Standards and Spec review briefs;
- launches exactly two fresh read-only Readers sequentially in separate Herdr
tabs;
- passes the Writer worktree, issue, spec, standards, diff range, and rubrics
as launch context;
- leaves the Writer pane and worktree open for fixes.

Readers run in the repository's canonical Herdr workspace but direct every
review command at the Writer's absolute worktree. They do not create or modify
worktrees. Standards and Spec reviews use separate scopes:

- **Standards Reader:** changed files plus applicable `AGENTS.md` and
  `CONTRIBUTING.md`; never assess the product issue/spec.
- **Spec Reader:** complete issue and approved repository spec; trace every
  acceptance criterion to changed code and tests; do not report style concerns.

Review happens before commit or PR publication. Relay accepted findings to the
existing Writer, rerun checks, and close the Writer only after review and fixes
are complete. Do not launch a replacement Writer while its lock is held.

If a Reader launch fails, inspect the reported Herdr pane/session before any
retry. A timeout does not prove that no Reader started. `/agent` remains
available for deliberate single Reader, Researcher, or Writer launches, but it
is not needed for the normal two-Reader review flow.
