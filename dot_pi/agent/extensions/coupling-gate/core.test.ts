import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  analyzeProject,
  evaluateGate,
  formatReport,
  getGateState,
  type CouplingReport,
} from "./core.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "coupling-gate-core-"));
test.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function write(root: string, name: string, source: string): void {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
}

function paths(report: CouplingReport): string[] {
  return report.edges.map((edge) => `${edge.from} → ${edge.to}`);
}

test("extracts static, dynamic, require, export, and type-only edges at the fixture seam", () => {
  const root = join(fixtureRoot, "edges");
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { moduleResolution: "NodeNext" } }));
  write(root, "shared/types.ts", "export type Money = number;\n");
  write(root, "shared/value.ts", "export const value = 1;\n");
  write(root, "shared/index.ts", 'export { value } from "./value";\n');
  write(
    root,
    "pricing/quote.ts",
    `import type { Money } from "../shared/types";
import { value } from "../shared/index";
export { value as exported } from "../shared/value";
const lazy = import("../shared/value");
const required = require("../shared/value");
export const quote = (amount: Money) => value + Boolean(lazy) + Boolean(required) + amount;
`,
  );

  const report = analyzeProject(root);
  assert.deepEqual(paths(report), [
    "pricing/quote.ts → shared/types.ts",
    "pricing/quote.ts → shared/value.ts",
    "shared/index.ts → shared/value.ts",
  ]);
  const quote = report.files.find((file) => file.path === "pricing/quote.ts");
  assert.equal(quote?.ce, 1);
  assert.equal(quote?.imports.find((edge) => edge.to === "shared/types.ts")?.weight, 0);
  assert.equal(quote?.imports.find((edge) => edge.to === "shared/value.ts")?.uses, 4);
  assert.equal(quote?.contextCost, 8);
});

test("computes inverse Ca, folder crossings, and follows a re-export-only barrel", () => {
  const root = join(fixtureRoot, "metrics");
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  write(root, "shared/money.ts", "export const money = 1;\nexport const currency = 2;\n");
  write(root, "shared/index.ts", 'export { money } from "./money";\n');
  write(root, "pricing/quote.ts", 'import { money } from "../shared";\nexport const quote = money;\n');
  write(root, "checkout/cart.ts", 'import { money } from "../shared/money";\nexport const cart = money;\n');

  const report = analyzeProject(root, ["pricing/quote.ts"]);
  const money = report.files.find((file) => file.path === "shared/money.ts");
  const quote = report.files.find((file) => file.path === "pricing/quote.ts");
  assert.equal(money?.ca, 3);
  assert.deepEqual(quote?.imports.map((edge) => edge.to), ["shared/money.ts"]);
  assert.deepEqual(report.crossEdges.map((edge) => `${edge.from} → ${edge.to}`), [
    "checkout/cart.ts → shared/money.ts",
    "pricing/quote.ts → shared/money.ts",
  ]);
});

test("scans tests for inverse dependencies without counting test files as modules", () => {
  const root = join(fixtureRoot, "test-dependants");
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: {} }));
  write(root, "shared/value.ts", "export const value = 1;\n");
  write(root, "pricing/quote.ts", 'import { value } from "../shared/value";\nexport const quote = value;\n');
  write(root, "pricing/quote.test.ts", 'import { quote } from "./quote";\nvoid quote;\n');

  const report = analyzeProject(root);
  assert.equal(report.files.some((file) => file.path.endsWith(".test.ts")), false);
  assert.equal(report.files.find((file) => file.path === "pricing/quote.ts")?.ca, 1);
  assert.equal(report.files.find((file) => file.path === "shared/value.ts")?.ca, 1);
});

test("reports a changed-file cycle and names its weakest edge", () => {
  const root = join(fixtureRoot, "cycles");
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: {} }));
  write(root, "a.ts", 'import { b } from "./b";\nexport const a = b;\n');
  write(root, "b.ts", 'import { c } from "./c";\nexport const b = c;\n');
  write(root, "c.ts", 'import { a } from "./a";\nexport const c = a;\n');

  const report = analyzeProject(root, ["a.ts"]);
  assert.deepEqual(report.cycles.map((cycle) => cycle.files), [["a.ts", "b.ts", "c.ts"]]);
  assert.equal(report.cycles[0]?.weakest.from, "a.ts");
  assert.equal(report.cycles[0]?.weakest.to, "b.ts");
  const formatted = formatReport(report);
  assert.match(formatted, /break a\.ts → b\.ts/);
  assert.match(formatted, /imports: b\.ts/);
});

test("fails only newly worsening coupling and lets allow bypass budgets, not cycles", () => {
  const root = join(fixtureRoot, "gate");
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: {} }));
  write(root, "a.ts", 'import { b } from "./b";\nexport const a = b;\n');
  write(root, "b.ts", "export const b = 1;\n");

  const first = analyzeProject(root, ["a.ts"]);
  const firstFile = first.files.find((file) => file.path === "a.ts")!;
  const baseline = getGateState(first, firstFile.path);
  assert.deepEqual(evaluateGate(baseline, firstFile, first, false), []);

  write(root, "b.ts", 'import { a } from "./a";\nexport const b = a;\n');
  const worsened = analyzeProject(root, ["a.ts"]);
  const worsenedFile = worsened.files.find((file) => file.path === "a.ts")!;
  const failures = evaluateGate(baseline, worsenedFile, worsened, false);
  assert.equal(failures.length, 1);
  assert.match(failures[0]!, /cycle.*a\.ts.*b\.ts/);
  assert.equal(evaluateGate(baseline, worsenedFile, worsened, true).length, 1);
});

test("enforces declared folder layer rules", () => {
  const root = join(fixtureRoot, "layers");
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: {} }));
  write(root, "coupling-gate.json", JSON.stringify({ forbid: [{ from: "shared", to: "features/*" }] }));
  write(root, "features/catalog.ts", "export const catalog = true;\n");
  write(root, "shared/format.ts", 'import { catalog } from "../features/catalog";\nexport const label = catalog;\n');

  const report = analyzeProject(root);
  assert.deepEqual(report.layerViolations.map((violation) => `${violation.edge.from} → ${violation.edge.to}`), [
    "shared/format.ts → features/catalog.ts",
  ]);
});
