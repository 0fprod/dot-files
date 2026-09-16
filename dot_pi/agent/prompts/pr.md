---
description: Create a labelled, self-assigned GitHub pull request
argument-hint: "[--cwd <target>] <base-branch>"
---

Create a pull request using `$@`. `gh` is installed and authenticated.

## Arguments

Accept optional `--cwd <target>` plus one required base branch. Resolve target
aliases from `/Users/francisco.palacios/Workspace/AGENTS.md` or accept an
explicit path. Without `--cwd`, use the current directory.

Resolve the absolute repository path first. Run every Git and GitHub command
from that repository; never treat the workspace root as Git.

## Workflow

1. Verify the repository, base branch, current branch, remote, and authenticated
   GitHub user. Stop if the current branch is the base branch.
2. Inspect `git status`, `git log <base>..HEAD`, and
   `git diff <base>...HEAD`. Stop if there are no committed changes. Warn about
   uncommitted changes because they will not be included.
3. Check whether the current branch already has a pull request. If so, report
   its URL and stop instead of creating a duplicate.
4. List available labels before asking the user:

   ```bash
   gh label list --limit 100 --sort name --order asc \
     --json name,description \
     --jq '.[] | [.name, (.description // "")] | @tsv'
   ```

5. Ask for both decisions in one message, then wait:
   - Exact label name(s), or `none`.
   - Status: `draft` or `ready for review`.
6. Infer a Jira ticket ID from the current branch when present. Never invent
   one.
7. Propose the PR title:
   - With Jira: `JIRA_TASK_ID: Commit message`
   - Without Jira: `Commit message`
   - Use imperative wording; capitalize only the first letter of the first
     word after the optional Jira prefix.
8. Build the English PR body using exactly:

   ```md
   ## Description
   <Brief description of the goal of the PR>

   ## Main changes
   <Why and what changed>

   ## Jira
   https://nomoapp.atlassian.net/browse/<Jira ticket ID>
   ```

   If the branch has no Jira ticket ID, use `N/A`.

   For the **Tests** section, list every implemented or modified test file using the exact `describe` blocks as top-level bullets and the exact `test` / `it` names as nested bullets. Use the form:

   ```md
   ## Tests
   - The <describe subject>
     - <exact test name>
     - <exact test name>
   - The <describe subject>
     - <exact test name>
   ```

   Do not collapse, summarize, or rephrase test names.

9. Show the final preview: repository, branches, assignee, labels, status,
   title, and body.
10. Ask for explicit final approval and wait.
11. Write the body to a temporary Markdown file and run `gh pr create` from the
    target repository with:
    - `--base <base>`
    - `--head <current-branch>`
    - `--title <title>`
    - `--body-file <temporary-file>`
    - `--assignee @me`
    - one `--label <exact-name>` per selected label
    - `--draft` only for draft status
12. Remove the temporary file. Report the URL and verify with
    `gh pr view --json url,isDraft,labels,assignees`.

## After merge

When the PR is later confirmed merged, use `github_tools` to enable `gh_pr_unblock` and run it with the completed issue's absolute path. It verifies the PR state with GitHub before changing any tracker file, clears only that dependency, preserves other blockers, and reports changed, skipped, and ambiguous references. Do not run it for a created, draft, open, or otherwise unmerged PR.

## Restrictions

- Focus on the main behavior; omit incidental refactors.
- Preserve the four body section names exactly.
- Use `N/A` in Jira when the branch has no ticket ID.
- Never guess labels.
- Never use `--no-verify`, force-push, or create a duplicate PR.
