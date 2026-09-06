import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveImport, type ModuleResolution } from "./resolver.ts";

const fixtureRoot = mkdtempSync(join(tmpdir(), "coupling-gate-resolver-"));

test.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

function write(name: string, source: string): string {
  const path = join(fixtureRoot, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function resolve(name: string, specifier: string): ModuleResolution {
  return resolveImport(specifier, join(fixtureRoot, name), fixtureRoot);
}

test("resolves an alias from the nearest tsconfig", () => {
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  write("src/value.ts", "export const value = 1;\n");
  write("packages/app/src/entry.ts", "import { value } from \"@/value\";\n");
  write("packages/app/tsconfig.json", JSON.stringify({ extends: "../../tsconfig.json" }));

  assert.deepEqual(resolve("packages/app/src/entry.ts", "@/value"), {
    kind: "internal",
    path: join(fixtureRoot, "src/value.ts"),
    tsconfigPath: join(fixtureRoot, "packages/app/tsconfig.json"),
  });
});

test("merges inherited paths while the child overrides the base url", () => {
  write("configs/base.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["../shared/lib/*"] } } }));
  write("configs/child.json", JSON.stringify({ extends: "./base.json", compilerOptions: { paths: { "@app/*": ["app/*"] } } }));
  write("shared/lib/base.ts", "export const base = 1;\n");
  write("configs/app/value.ts", "export const value = 1;\n");
  write("packages/entry.ts", "export {};\n");
  write("packages/tsconfig.json", JSON.stringify({ extends: "../configs/child.json", compilerOptions: { baseUrl: "../configs" } }));

  assert.equal(resolve("packages/entry.ts", "@lib/base").path, join(fixtureRoot, "shared/lib/base.ts"));
  assert.equal(resolve("packages/entry.ts", "@app/value").path, join(fixtureRoot, "configs/app/value.ts"));
});

test("resolves directories and TypeScript and JavaScript module extensions", () => {
  write("pkg/index.ts", "export const index = true;\n");
  write("widget.tsx", "export const widget = true;\n");
  write("module.mjs", "export const module = true;\n");
  write("entry.ts", "export {};\n");

  assert.equal(resolve("entry.ts", "./pkg").path, join(fixtureRoot, "pkg/index.ts"));
  assert.equal(resolve("entry.ts", "./widget").path, join(fixtureRoot, "widget.tsx"));
  assert.equal(resolve("entry.ts", "./module").path, join(fixtureRoot, "module.mjs"));
});

test("excludes bare packages and unresolved aliases", () => {
  write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  write("entry.ts", "export {};\n");

  assert.deepEqual(resolve("entry.ts", "lodash"), { kind: "external", tsconfigPath: join(fixtureRoot, "tsconfig.json") });
  assert.deepEqual(resolve("entry.ts", "node:path"), { kind: "external", tsconfigPath: join(fixtureRoot, "tsconfig.json") });
  assert.deepEqual(resolve("entry.ts", "@/missing"), { kind: "external", tsconfigPath: join(fixtureRoot, "tsconfig.json") });
});

test("reports when no tsconfig exists and treats bare imports as external", () => {
  const root = join(fixtureRoot, "without-config");
  mkdirSync(root, { recursive: true });
  const entry = join(root, "entry.ts");
  writeFileSync(entry, "export {};\n");

  assert.deepEqual(resolveImport("react", entry, root), {
    kind: "external",
    note: "no tsconfig found, bare imports treated as external",
  });
  assert.equal(resolveImport("./entry", entry, root).kind, "internal");
});
