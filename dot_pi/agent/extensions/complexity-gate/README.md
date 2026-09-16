# Complexity Gate

Pi extension that checks deterministic cyclomatic complexity in TypeScript and
JavaScript files. It also flags named exports from helper modules that are not
used by another module.

It complements the coupling gate:

- **Complexity gate:** how many control-flow paths one function contains.
- **Coupling gate:** how modules depend on one another.

## Thresholds

The built-in thresholds are:

```text
Blocking violation: complexity > 8 and < 16
Non-blocking warning: complexity >= 16
```

A function with complexity 8 passes. Complexity starts at 1 and adds one for
each supported branch, loop, catch clause, switch case, conditional expression,
and `&&`/`||` logical operator. Nested functions are analyzed separately and
do not contribute to their parent function's score.

The thresholds are currently constants in `index.ts`; there is no project
configuration file for changing them.

## Automatic behavior

After a successful `edit` or `write` tool call, supported source files are
analyzed automatically. The extension appends a report when it finds a new
blocking violation, a warning, or a useless helper export.

The gate is deterministic and only reports the current file's findings. It does
not fail the tool call itself. Warnings are explicitly non-blocking; blocking
violations should be reduced before continuing.

## Baseline behavior

The explicit `complexity_check` tool and `/complexity` command analyze either
changed Git files or supplied paths. The automatic `edit`/`write` hook reports
findings for that call; it does not maintain a previous-complexity baseline.

Changed-file discovery uses:

```text
git diff --name-only --diff-filter=ACMRTUXB
git ls-files --others --exclude-standard
```

Supported extensions are `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`,
and `.cjs`. Paths are interpreted relative to the current Pi working
directory unless already absolute. An `@` prefix is removed to support Pi tool
path arguments.

## Helper-module exports

Files whose names end in `.helper.*` or `.helpers.*` are checked for unused
named exports. The analyzer considers top-level exported function declarations
and variable declarations, then searches named imports in other tracked or
untracked source files.

An unused helper export produces a blocking finding with this recommendation:

```text
Make it module-private.
```

The export check is intentionally conservative: it recognizes named imports
and a small set of relative/import-path spellings. It does not replace a full
TypeScript compiler or bundler analysis.

## Commands and tools

### `/complexity`

Report changed source files:

```text
/complexity
```

Report explicit files by passing whitespace-separated paths:

```text
/complexity src/invoices/total.ts src/invoices/total.helper.ts
```

The command shows a compact pass/fail summary. Use `complexity_check` when you
need per-function details.

### `complexity_check`

The tool accepts an optional `paths` array. Omit it to inspect changed Git
files, or provide relative paths for an explicit report. Results include:

- Function names, complexity, line, and column.
- Blocking violations.
- Non-blocking warnings.
- Unused helper exports.
- The configured thresholds.

## Activation

The extension entry point is:

```text
~/.pi/agent/extensions/complexity-gate/index.ts
```

Enable it in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "+extensions/complexity-gate/index.ts"
  ]
}
```

Run `/reload` after changing the settings. The current installation enables it
with `+extensions/complexity-gate/index.ts`.

## Development

Run the extension tests with:

```bash
cd ~/.pi/agent/extensions/complexity-gate
npm test
```

The implementation parses source with the TypeScript compiler API and uses
`typebox` for the Pi tool schema. Tests cover straight-line functions,
branching, nested methods/arrows, thresholds, formatting, supported extensions,
and helper export usage.
