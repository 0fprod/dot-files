---
name: code-review
description: Prepare two independent read-only Reader reviews for standards and spec compliance. Use only when the user explicitly requests code review.
disable-model-invocation: true
argument-hint: "[--cwd <target>] [spec or fixed point]"
---

# Code Review

Run this workflow only from the orchestrator inside Herdr; the current
`/agent` launcher requires that context. The `/agent` wizard is the only way to
launch reviewers: launch exactly two fresh, read-only `Reader` sessions, one for
Standards and one for Spec analysis. Use separate Herdr tabs or panes, never a
background location, and launch them sequentially. Do not use `launch_agent`,
GPT profiles, forks, handoffs, or an automatic launcher, and do not launch any
other agents.

The Writer's pane and absolute worktree must remain open while review is in
progress. Readers may start in the canonical checkout selected by `/agent`, but
their briefs must direct every review command at the Writer's absolute worktree.
Review happens before commit or PR publication; keep the Writer available in the
same worktree for fixes until final checks are complete.

## 1. Resolve the review target

Accept optional `--cwd <target>`. Resolve workspace aliases from
`/Users/francisco.palacios/Workspace/AGENTS.md` or accept an explicit absolute
path. Without it, use the current directory. Verify the target is a Git
repository and use its absolute path for every Git command and reviewer
instruction.

Inspect:

```bash
git -C <target> status --porcelain=v1 --untracked-files=all
```

- **Dirty tree:** review staged, unstaged, and untracked changes against `HEAD`.
  Give Readers `git diff HEAD --` and `git ls-files --others --exclude-standard`.
- **Clean tree:** require a fixed point from the user. Validate it with
  `git rev-parse`, then review `git diff <fixed-point>...HEAD` and
  `git log <fixed-point>..HEAD --oneline`.

Reject an empty review target. Do not create commits, branches, worktrees, or
files while preparing the review.

## 2. Resolve the issue, blockers, and standards

Resolve the approved issue/spec. A user-supplied issue, URL, or path wins.
Otherwise infer the source only when exactly one issue/spec is clear from the
conversation or current work. Ask when none or several are plausible. Read the
complete issue and approved spec before preparing the launch instructions.

Before launching either Reader, inspect the issue's `## Blocked by` section.
Treat any value other than `None - can start immediately.` as an active blocker.
Explain the blocker and stop the review launch; do not bypass `/agent` issue
validation. After a dependency is confirmed completed and merged (not merely
created, open, or draft), use `github_tools` to enable `gh_pr_unblock` with the
completed issue's absolute path. It verifies the merged PR, clears only that
dependency, preserves any other blockers, and reports changed, skipped, and
ambiguous references. Use this exact value when none remain:

```md
## Blocked by

None - can start immediately.
```

Reread the issue after the edit, then restart the review. Do not silently clear
an unverified dependency or change unrelated tracker text.

Find repository standards such as `AGENTS.md`, `CONTRIBUTING.md`, and local
coding standards. Do not treat the product spec or changed files as standards
sources. State explicitly when no documented standards exist.

## 3. Prepare two Reader launches

Do not create handoff files. Print or show the following two launch briefs to
the user, then have the user run `/agent` twice from the orchestrator:

1. Select **Reader**.
2. Select the same approved issue.
3. Select any permitted model and thinking level.
4. Launch each Reader in a separate Herdr tab or pane.
5. Paste the corresponding brief into **optional instructions**.
6. Confirm each launch.

Use the absolute review target path in both briefs. The Reader may start in the
canonical repository workspace, but must run all review commands against the
specified target path.

### Standards Reader brief

```text
Review only the change target at <absolute-target> for repository standards.
Remain strictly read-only: do not edit files, Git state, Jira, databases, or
external systems. Read <absolute-path-to-STANDARDS-REVIEW.md> completely.

For a dirty target, review git -C <absolute-target> diff HEAD -- and all files
listed by git -C <absolute-target> ls-files --others --exclude-standard. For a
clean target, review <fixed-point>...HEAD and <fixed-point>..HEAD --oneline.
Applicable standards: <standards-paths-or-none>.

This is the Standards review: do not read or assess the originating product
issue/spec. Follow this brief when it differs from generic Reader kickoff text.
Skip formatting and checks already enforced by tooling. Report actionable
findings in your pane using the rubric's exact output format, with severity,
file, line, evidence, and rule. Do not modify anything.
```

### Spec Reader brief

```text
Review only the change target at <absolute-target> against the complete issue
at <absolute-issue> and complete approved spec at <absolute-spec>. Remain
strictly read-only: do not edit files, Git state, Jira, databases, or external
systems. Read both documents completely, then read
<absolute-path-to-SPEC-REVIEW.md> completely.

For a dirty target, review git -C <absolute-target> diff HEAD -- and all files
listed by git -C <absolute-target> ls-files --others --exclude-standard. For a
clean target, review <fixed-point>...HEAD and <fixed-point>..HEAD --oneline.

Trace every acceptance criterion in the issue and spec to changed code and
tests. Report only missing, incorrect, unsupported, or unverified requirements,
citing the requirement text and changed file/line. Use the rubric's exact
output format. Do not report style concerns and do not modify anything.
```

Replace every placeholder before giving the briefs to the user. The two
Readers must remain independent: the Standards Reader must not assess the
product spec, and the Spec Reader must not report style or standards concerns.

Launch the two Readers sequentially through `/agent` to avoid Herdr
pane-placement races. Wait for the launch notification before starting the
second. If one launch fails, inspect the reported pane/session before retrying:
a timeout or stalled response does not prove that no Reader was started. Use
Herdr's `agent get`/`agent read` on the resolved pane or agent name, and do not
blindly submit a duplicate. Retry only after establishing that no usable Reader
exists, using `/agent` again for a fresh Reader; still complete the other review
and report both outcomes. Never retry by sending a second prompt to an uncertain
session. Do not close the Writer pane, aggregate findings automatically, modify
files, or merge branches from this skill.

## 4. Apply findings

After both Readers finish, the user reviews their pane output and relays
accepted findings to the existing Writer session. The Writer fixes findings in
the same absolute worktree and reruns the relevant tests. Do not replace a
Writer for that worktree while its tracked pane or background process still
holds the lock. If that tracked pane/process is gone and the launcher detects
the stale lock, `/agent` may replace it; make that replacement deliberate and
do not manually delete the lock.

A Writer using another dedicated worktree has a separate lock scope and may run
independently; that does not authorize two Writers in the same worktree or
canonical existing checkout.

Only after review fixes and final checks are complete should the Writer pane be
closed and the branch be committed or the PR published manually.
