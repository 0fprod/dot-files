# Coupling Gate

Pi extension that checks architectural coupling in TypeScript and JavaScript
projects. It complements the complexity gate: complexity measures individual
functions; this extension measures module relationships.

## What it measures

For internal source modules, the gate reports:

- **Ce** — distinct runtime dependencies imported by a module.
- **Ca** — modules that depend on the module.
- **Folder crossings** — imports crossing top-level folders.
- **Cycles** — strongly connected dependency components.
- **Layer violations** — edges forbidden by `coupling-gate.json`.
- **Context cost** — the module's lines plus the lines of its direct imported
  modules.

Tests are included when calculating inverse dependencies and cycles, but test
files are not counted as production modules.

Default budgets:

```text
Ce: 20
Context cost: 2500 lines
```

The automatic gate follows a “do not make legacy coupling worse” policy. It
records the previous report in memory and reports only newly introduced or
worsened budget/crossing problems. Cycles and layer violations are always
reported when newly observed. Reloading Pi resets the in-memory baseline.

## Activation

The extension is loaded from:

```text
~/.pi/agent/extensions/coupling-gate/index.ts
```

Enable it in `~/.pi/agent/settings.json` by removing the disable entry and
adding the extension if needed:

```json
{
  "extensions": [
    "+extensions/coupling-gate/index.ts"
  ]
}
```

Run `/reload` after changing the settings. The current installation may have
`-extensions/coupling-gate/index.ts`, which explicitly disables it.

## Commands and tools

### Automatic checks

After `edit` or `write` changes a supported `.ts`, `.tsx`, `.js`, `.jsx`,
`.mts`, `.cts`, `.mjs`, or `.cjs` file, the extension analyzes the project and
appends suggestions when new gate failures appear.

### `/coupling`

Reports coupling for changed source files:

```text
/coupling
```

Pass whitespace-separated paths to inspect explicit files:

```text
/coupling src/features/invoice.ts src/shared/money.ts
```

### `coupling_check`

The tool accepts an optional `paths` array. Omit it to inspect changed source
files, or provide relative paths for an explicit report. The report includes
named dependency edges and is useful after restructuring a module.

## Allow marker

Add this marker to a module to allow its Ce, context-cost, and folder-crossing
budgets when the dependency is intentional:

```ts
// coupling-gate:allow
```

The marker does **not** suppress cycles or layer violations.

## Layer rules

Create `coupling-gate.json` at the project root to forbid dependency directions:

```json
{
  "forbid": [
    { "from": "shared", "to": "features/*" },
    { "from": "domain", "to": "infrastructure/*" }
  ]
}
```

Patterns use `*` as a wildcard. Rules match the importing module's top-level
folder and the imported path.

## Resolution behavior

The resolver understands relative imports, TypeScript/JavaScript extensions,
directory indexes, `baseUrl`/`paths` aliases, and inherited `tsconfig.json`
files. It follows re-export-only barrels up to five levels. Bare external
packages are excluded from internal coupling metrics.

## Development

Run the extension tests with:

```bash
cd ~/.pi/agent/extensions/coupling-gate
npm test
```

The extension has no runtime dependency on the Pi package beyond its peer
interfaces; it uses TypeScript for source parsing and module resolution.
