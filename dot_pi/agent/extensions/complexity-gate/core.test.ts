import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSource, analyzeUnusedExports, formatReport, isHelperModulePath, isSupportedPath } from "./core.ts";

test("The complexity analyzer gives a straight-line function a complexity of 1", () => {
  const report = analyzeSource(
    "invoice.ts",
    `export function total(net: number) {
  return net + 1;
}
`,
    8,
  );

  assert.deepEqual(report.functions, [
    {
      name: "total",
      complexity: 1,
      line: 1,
      column: 1,
    },
  ]);
  assert.deepEqual(report.violations, []);
});

test("The complexity analyzer counts branching and looping paths inside a function", () => {
  const report = analyzeSource(
    "invoice.ts",
    `export function classify(total: number, items: number[]) {
  if (total > 100 && items.length > 0) {
    return "high";
  }

  for (const item of items) {
    if (item % 2 === 0) {
      return item > 10 ? "even-big" : "even-small";
    }
  }

  switch (items.length) {
    case 0:
      return "empty";
    case 1:
      return "single";
    default:
      return total ?? 0;
  }
}
`,
    5,
  );

  assert.deepEqual(report.functions, [
    {
      name: "classify",
      complexity: 8,
      line: 1,
      column: 1,
    },
  ]);
  assert.deepEqual(report.violations, [
    {
      name: "classify",
      complexity: 8,
      line: 1,
      column: 1,
    },
  ]);
});

test("The complexity analyzer reports methods and arrow functions separately from their parents", () => {
  const report = analyzeSource(
    "invoice.ts",
    `class InvoiceService {
  save(items: number[]) {
    const pick = (item: number) => {
      if (item > 2) {
        return item;
      }
      return 0;
    };

    for (const item of items) {
      if (pick(item)) {
        return item;
      }
    }

    return 0;
  }
}
`,
    2,
  );

  assert.deepEqual(report.functions, [
    {
      name: "save",
      complexity: 3,
      line: 2,
      column: 3,
    },
    {
      name: "pick",
      complexity: 2,
      line: 3,
      column: 18,
    },
  ]);
  assert.deepEqual(report.violations, [
    {
      name: "save",
      complexity: 3,
      line: 2,
      column: 3,
    },
  ]);
});

test("Complexity from 9 through 15 is blocking while 16 and above is warning-only", () => {
  const makeFunction = (branches: number) => `function classify(value: number) {\n${Array.from({ length: branches }, (_, index) => `  if (value === ${index}) return ${index};`).join("\n")}\n  return -1;\n}`;
  const report = analyzeSource("invoice.ts", makeFunction(14), 8, 16);
  const warningReport = analyzeSource("invoice.ts", makeFunction(15), 8, 16);

  assert.equal(report.functions[0]?.complexity, 15);
  assert.equal(report.violations.length, 1);
  assert.equal(report.warnings.length, 0);
  assert.equal(warningReport.functions[0]?.complexity, 16);
  assert.equal(warningReport.violations.length, 0);
  assert.equal(warningReport.warnings.length, 1);
  assert.match(formatReport(warningReport), /Warnings \(non-blocking\)/);
});

test("The complexity formatter emits a compact violation summary for supported TS files", () => {
  const report = analyzeSource(
    "src/invoice.ts",
    `export const classify = (total: number, items: number[]) => {
  if (total > 100 && items.length > 0) {
    return "high";
  }

  for (const item of items) {
    if (item % 2 === 0) {
      return item > 10 ? "even-big" : "even-small";
    }
  }

  switch (items.length) {
    case 0:
      return "empty";
    case 1:
      return "single";
    default:
      return total;
  }
};
`,
    5,
  );

  assert.equal(isSupportedPath("src/invoice.ts"), true);
  assert.equal(isSupportedPath("src/invoice.json"), false);
  assert.equal(
    formatReport(report),
    "Complexity gate: FAIL src/invoice.ts\n- classify line 1 col 25 complexity 8 > 5",
  );
});

test("The export analyzer flags helper exports with no external consumers", () => {
  const report = analyzeUnusedExports(
    "src/use-case.helper.ts",
    `export const classify = () => 1;
export function normalize() {
  return 2;
}
const localOnly = 3;
`,
    [
      {
        path: "src/use-case.ts",
        source: 'import { classify } from "./use-case.helper";\n',
      },
    ],
  );

  assert.equal(isHelperModulePath("src/use-case.helper.ts"), true);
  assert.equal(isHelperModulePath("src/use-case.ts"), false);
  assert.deepEqual(report, [
    {
      name: "normalize",
      line: 2,
      column: 1,
      message: "Unused export in helper module. Make it module-private.",
    },
  ]);
});
