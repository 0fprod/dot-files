import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

export type ImportCost = {
  path: string;
  lines: number;
};

export type ContextCostReport = {
  path: string;
  budget: number;
  selfLines: number;
  imports: ImportCost[];
  totalLines: number;
  allowed: boolean;
};

const ALLOW_MARKER = "context-cost:allow";
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

export function isSupportedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return RESOLVE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function isOverBudget(report: ContextCostReport): boolean {
  return !report.allowed && report.totalLines > report.budget;
}

export function countLines(source: string): number {
  const lines = source.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length;
}

export function analyzeContextCost(entryPath: string, source: string, budget: number): ContextCostReport {
  const imports = collectDirectImports(entryPath, source);
  const selfLines = countLines(source);
  const totalLines = selfLines + imports.reduce((sum, entry) => sum + entry.lines, 0);

  return {
    path: entryPath,
    budget,
    selfLines,
    imports,
    totalLines,
    allowed: source.includes(ALLOW_MARKER),
  };
}

function collectDirectImports(entryPath: string, source: string): ImportCost[] {
  const sourceFile = ts.createSourceFile(entryPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = new Set<string>();

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier) && isRelativeSpecifier(specifier.text)) {
        specifiers.add(specifier.text);
      }
    }

    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      isRelativeSpecifier(node.arguments[0].text)
    ) {
      specifiers.add(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const entryDir = dirname(entryPath);
  const costs: ImportCost[] = [];
  for (const specifier of specifiers) {
    const resolved = resolveSpecifier(entryDir, specifier);
    if (!resolved) {
      continue;
    }
    const source = readSourceSync(resolved);
    if (source === undefined) {
      continue;
    }
    costs.push({ path: relative(process.cwd(), resolved), lines: countLines(source) });
  }

  return costs.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function resolveSpecifier(fromDir: string, specifier: string): string | undefined {
  const base = resolve(fromDir, specifier);
  if (existsSync(base) && !existsSync(`${base}/`)) {
    return base;
  }

  for (const extension of RESOLVE_EXTENSIONS) {
    if (existsSync(base + extension)) {
      return base + extension;
    }
  }

  for (const extension of RESOLVE_EXTENSIONS) {
    const index = resolve(base, `index${extension}`);
    if (existsSync(index)) {
      return index;
    }
  }

  return undefined;
}

function readSourceSync(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function formatReport(report: ContextCostReport): string {
  const imported = report.imports.reduce((sum, entry) => sum + entry.lines, 0);
  const summary = `${report.path}: self ${report.selfLines} + ${report.imports.length} import(s) ${imported} = ${report.totalLines} lines (budget ${report.budget})`;

  if (report.allowed) {
    return `Context cost: PASS ${summary} (allowed by context-cost:allow)`;
  }

  if (report.totalLines <= report.budget) {
    return `Context cost: PASS ${summary}`;
  }

  return [
    `Context cost: FAIL ${summary}`,
    ...report.imports.slice(0, 10).map((entry) => `- ${entry.path}: ${entry.lines} lines`),
  ].join("\n");
}
