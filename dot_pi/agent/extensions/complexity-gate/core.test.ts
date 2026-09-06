import assert from "node:assert/strict";
import test from "node:test";
import { analyzeSource, formatReport, isSupportedPath } from "./core.ts";

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

  // if +1, && nested +2, for +1, nested if +2, ternary +3, switch +1 => 11
  assert.deepEqual(report.functions, [
    {
      name: "classify",
      complexity: 11,
      line: 1,
      column: 1,
    },
  ]);
  assert.deepEqual(report.violations, [
    {
      name: "classify",
      complexity: 11,
      line: 1,
      column: 1,
    },
  ]);
});

test("Guard clauses stay cheap at depth zero while nested branches are penalized", () => {
  const flat = analyzeSource(
    "guards.ts",
    `export function handle(value?: number) {
  if (!value) return 0;
  if (value < 0) return 0;
  if (value === 0) return 0;
  if (value > 100) return 0;
  if (value % 2 === 0) return 0;
  return value;
}
`,
    6,
  );

  assert.equal(flat.functions[0]?.complexity, 6);
  assert.deepEqual(flat.violations, []);

  const nested = analyzeSource(
    "pyramid.ts",
    `export function pyramid(value?: number) {
  if (value) {
    if (value > 1) {
      if (value > 2) {
        return "deep";
      }
    }
  }
  return "shallow";
}
`,
    6,
  );

  assert.deepEqual(nested.violations, [
    {
      name: "pyramid",
      complexity: 7,
      line: 1,
      column: 1,
    },
  ]);
});

test("Switch dispatch counts once regardless of case count and the allow marker whitelists a file", () => {
  const dispatch = analyzeSource(
    "dispatch.ts",
    `export function label(code: "a" | "b" | "c" | "d") {
  switch (code) {
    case "a":
      return 1;
    case "b":
      return 2;
    case "c":
      return 3;
    default:
      return 0;
  }
}
`,
    12,
  );

  assert.equal(dispatch.functions[0]?.complexity, 2);
  assert.deepEqual(dispatch.violations, []);

  const allowed = analyzeSource(
    "parser.ts",
    `// complexity-gate:allow
export function parse(input: string) {
  if (input.startsWith("{")) {
    if (input.includes(":")) {
      return "object";
    }
  }
  return "plain";
}
`,
    2,
  );

  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.violations, []);
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
      complexity: 4,
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
      complexity: 4,
      line: 2,
      column: 3,
    },
  ]);
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
  const formatted = formatReport(report);
  assert.match(formatted, /Complexity gate: FAIL src\/invoice\.ts/);
  assert.match(formatted, /see the codebase-design skill/);
  assert.match(formatted, /deepening/);
  assert.match(formatted, /narrow the interface at the seam/);
});
