# CLI

Instead of the following traditional commands, use faster alternatives:

- `rg`/`grep` → `ast-grep`
- `find` → `fd`
- `grep` → `rg`
- `tree` for structure
- `jq` and `yq` for data

When reporting information to me, be extremely concise and sacrifice grammar for the sake of concision.

# Git diffs

When reviewing changes:

- Start with `git status --short`, `git diff --stat <base>...HEAD`, `git diff --name-status <base>...HEAD`, and `git log --oneline <base>..HEAD`.
- Use three-dot diffs (`<base>...HEAD`) for branch/PR review.
- Read per-file hunks with `git diff --unified=3 <base>...HEAD -- <path>`.
- Avoid loading full diffs/files unless needed; exclude generated/lockfile noise when irrelevant.