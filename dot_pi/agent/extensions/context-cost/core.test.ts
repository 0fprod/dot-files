import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { analyzeContextCost, countLines, formatReport, isOverBudget, isSupportedPath } from "./core.ts";

const dir = mkdtempSync(join(tmpdir(), "context-cost-"));

function write(name: string, source: string): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function read(name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

test("Counting lines ignores the trailing newline", () => {
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines(""), 0);
});

test("Only TS/JS paths are supported", () => {
  assert.equal(isSupportedPath("src/a.ts"), true);
  assert.equal(isSupportedPath("src/a.json"), false);
});

test("The context cost sums the file and its direct relative imports only", () => {
  write("imported.ts", "export const a = 1;\nexport const b = 2;\n");
  write(
    "entry.ts",
    `import { a } from "./imported";
import { join } from "node:path";
import lodash from "lodash";
export const value = a;
`,
  );

  const report = analyzeContextCost(join(dir, "entry.ts"), read("entry.ts"), 100);

  assert.equal(report.selfLines, 4);
  assert.deepEqual(
    report.imports.map((entry) => entry.path.split("/").at(-1)),
    ["imported.ts"],
  );
  assert.equal(report.totalLines, 6);
  assert.equal(isOverBudget(report), false);
  assert.ok(formatReport(report).includes("PASS"));
});

test("Package and node: imports never count toward the budget", () => {
  write(
    "external-only.ts",
    `import { join } from "node:path";
import ts from "typescript";
export const x = join("a");
`,
  );

  const report = analyzeContextCost(join(dir, "external-only.ts"), read("external-only.ts"), 1);

  assert.equal(report.imports.length, 0);
  assert.equal(report.totalLines, 3);
  assert.equal(isOverBudget(report), true);
});

test("Over-budget reports fail and list the heaviest imports", () => {
  write("heavy.ts", Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  write("over-budget.ts", `import { v0 } from "./heavy";\nexport const pick = v0;\n`);

  const report = analyzeContextCost(join(dir, "over-budget.ts"), read("over-budget.ts"), 5);

  assert.equal(report.totalLines, 14);
  assert.equal(isOverBudget(report), true);
  const formatted = formatReport(report);
  assert.ok(formatted.startsWith("Context cost: FAIL"));
  assert.ok(formatted.includes("heavy.ts: 12 lines"));
});

test("A directory import resolves to its index file", () => {
  write("pkg/index.ts", "export const ok = true;\n");
  write("uses-index.ts", `import { ok } from "./pkg";\nexport const check = ok;\n`);

  const report = analyzeContextCost(join(dir, "uses-index.ts"), read("uses-index.ts"), 100);

  assert.deepEqual(
    report.imports.map((entry) => entry.path.split("/").slice(-2).join("/")),
    ["pkg/index.ts"],
  );
});

test("The allow marker passes a file regardless of budget", () => {
  write("heavy2.ts", Array.from({ length: 10 }, (_, i) => `export const w${i} = ${i};`).join("\n") + "\n");
  write("allowed.ts", `// context-cost:allow\nimport { w0 } from "./heavy2";\nexport const pick = w0;\n`);

  const report = analyzeContextCost(join(dir, "allowed.ts"), read("allowed.ts"), 2);

  assert.equal(report.allowed, true);
  assert.equal(isOverBudget(report), false);
  assert.ok(formatReport(report).includes("allowed by context-cost:allow"));
});
