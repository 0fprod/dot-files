import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { isSourcePath, resolveImport } from "./resolver.ts";

export const CE_BUDGET = 20;
export const CONTEXT_BUDGET = 2500;
const ALLOW_MARKER = "coupling-gate:allow";
const MAX_BARREL_DEPTH = 5;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".next", "out", "coverage"]);

export type DependencyEdge = {
  from: string;
  to: string;
  weight: 0 | 1;
  uses: number;
};

export type FileMetrics = {
  path: string;
  selfLines: number;
  ce: number;
  ca: number;
  contextCost: number;
  imports: DependencyEdge[];
  allowed: boolean;
};

export type CycleReport = {
  files: string[];
  edges: DependencyEdge[];
  weakest: DependencyEdge;
};

export type LayerViolation = {
  edge: DependencyEdge;
  rule: { from: string; to: string };
};

export type CouplingReport = {
  root: string;
  ceBudget: number;
  contextBudget: number;
  files: FileMetrics[];
  edges: DependencyEdge[];
  crossEdges: DependencyEdge[];
  cycles: CycleReport[];
  layerViolations: LayerViolation[];
};

export type GateState = {
  cycles: Set<string>;
  crossEdges: Set<string>;
  ce: number;
  ctxCost: number;
};

type SourceFile = {
  absolutePath: string;
  relativePath: string;
  source: string;
};

type RawImport = {
  specifier: string;
  weight: 0 | 1;
};

export function analyzeProject(repoRoot: string, changedPaths: string[] = []): CouplingReport {
  const root = resolve(repoRoot);
  const allFiles = scanSourceFiles(root);
  const countedFiles = allFiles.filter((file) => !isTestPath(file.relativePath));
  const countedByPath = new Map(countedFiles.map((file) => [file.absolutePath, file]));
  const edgeMap = new Map<string, DependencyEdge>();

  for (const file of countedFiles) {
    for (const rawImport of collectImports(file.absolutePath, file.source)) {
      for (const target of resolveTargets(rawImport.specifier, file.absolutePath, root, new Set(), 0)) {
        if (!countedByPath.has(target)) {
          continue;
        }
        const from = file.relativePath;
        const to = relativePath(root, target);
        const key = `${from}\0${to}`;
        const existing = edgeMap.get(key);
        if (existing) {
          existing.weight = Math.max(existing.weight, rawImport.weight) as 0 | 1;
          existing.uses += 1;
        } else {
          edgeMap.set(key, { from, to, weight: rawImport.weight, uses: 1 });
        }
      }
    }
  }

  const edges = [...edgeMap.values()].sort(compareEdges);
  const incoming = new Map<string, number>();
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const changed = new Set(changedPaths.map((path) => relativePath(root, resolve(root, path))));
  const files = countedFiles
    .map((file) => {
      const imports = edges.filter((edge) => edge.from === file.relativePath);
      const contextTargets = new Set(imports.map((edge) => edge.to));
      const contextCost = countLines(file.source) + [...contextTargets].reduce((sum, target) => {
        const targetFile = countedByPath.get(resolve(root, target));
        return sum + (targetFile ? countLines(targetFile.source) : 0);
      }, 0);

      return {
        path: file.relativePath,
        selfLines: countLines(file.source),
        ce: new Set(imports.filter((edge) => edge.weight > 0).map((edge) => edge.to)).size,
        ca: incoming.get(file.relativePath) ?? 0,
        contextCost,
        imports,
        allowed: file.source.includes(ALLOW_MARKER),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const crossEdges = edges.filter((edge) => folderOf(edge.from) !== folderOf(edge.to));
  const cycles = findCycles(countedFiles.map((file) => file.relativePath), edges, changed);
  const layerViolations = readLayerRules(root).flatMap((rule) =>
    edges.filter((edge) => matchesLayer(rule.from, folderOf(edge.from)) && matchesLayer(rule.to, edge.to)).map((edge) => ({ edge, rule })), 
  );

  return {
    root,
    ceBudget: CE_BUDGET,
    contextBudget: CONTEXT_BUDGET,
    files,
    edges,
    crossEdges,
    cycles,
    layerViolations,
  };
}

export function countLines(source: string): number {
  const lines = source.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines.length;
}

export function getGateState(report: CouplingReport, path: string): GateState {
  const file = report.files.find((entry) => entry.path === path);
  if (!file) {
    return { cycles: new Set(), crossEdges: new Set(), ce: 0, ctxCost: 0 };
  }
  return {
    cycles: new Set(report.cycles.filter((cycle) => cycle.files.includes(path)).map((cycle) => cycle.files.join(" ↔ "))),
    crossEdges: new Set(report.crossEdges.filter((edge) => edge.from === path || edge.to === path).map(edgeKey)),
    ce: file.ce,
    ctxCost: file.contextCost,
  };
}

export function evaluateGate(previous: GateState | undefined, file: FileMetrics, report: CouplingReport, allowed: boolean): string[] {
  const current = getGateState(report, file.path);
  if (!previous) {
    return [];
  }

  const failures: string[] = [];
  for (const cycle of [...current.cycles].filter((entry) => !previous.cycles.has(entry))) {
    const weakest = report.cycles.find((entry) => entry.files.join(" ↔ ") === cycle)?.weakest;
    failures.push(`new cycle ${cycle}${weakest ? `; break ${weakest.from} → ${weakest.to}` : ""}`);
  }
  if (!allowed) {
    for (const crossing of [...current.crossEdges].filter((entry) => !previous.crossEdges.has(entry))) {
      failures.push(`new folder crossing ${crossing}`);
    }
    if (file.ce > report.ceBudget && file.ce > previous.ce) {
      failures.push(`${file.path} Ce ${file.ce} > ${report.ceBudget}`);
    }
    if (file.contextCost > report.contextBudget && file.contextCost > previous.ctxCost) {
      failures.push(`${file.path} context cost ${file.contextCost} > ${report.contextBudget}`);
    }
  }
  for (const violation of report.layerViolations) {
    if (violation.edge.from === file.path || violation.edge.to === file.path) {
      failures.push(`layer rule: ${violation.edge.from} → ${violation.edge.to}`);
    }
  }
  return failures;
}

export function formatReport(report: CouplingReport): string {
  const lines = [`Coupling gate: ${report.files.length} file(s)`];
  for (const file of report.files) {
    const topImports = [...file.imports].sort((a, b) => b.uses - a.uses || compareEdges(a, b)).slice(0, 5).map(edgeKey);
    const imports = topImports.length > 0 ? `, imports: ${topImports.join(", ")}` : "";
    lines.push(`- ${file.path}: Ce ${file.ce}, Ca ${file.ca}, context ${file.contextCost}/${report.contextBudget}${imports}`);
  }
  if (report.crossEdges.length > 0) {
    lines.push("Folder crossings:", ...report.crossEdges.map((edge) => `- ${edge.from} → ${edge.to} (${edge.uses} use(s))`));
  }
  if (report.cycles.length > 0) {
    lines.push("Cycles:", ...report.cycles.map((cycle) => `- cycle: ${cycle.files.join(" ↔ ")}; break ${cycle.weakest.from} → ${cycle.weakest.to}`));
  }
  if (report.layerViolations.length > 0) {
    lines.push("Layer violations:", ...report.layerViolations.map(({ edge, rule }) => `- ${edge.from} → ${edge.to} (forbid ${rule.from} → ${rule.to})`));
  }
  return lines.join("\n");
}

function scanSourceFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        visit(resolve(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !isSourcePath(entry.name)) {
        continue;
      }
      const absolutePath = resolve(directory, entry.name);
      try {
        files.push({ absolutePath, relativePath: relativePath(root, absolutePath), source: readFileSync(absolutePath, "utf8") });
      } catch {
        // A file that disappears during a check is not a dependency input.
      }
    }
  };
  visit(root);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function collectImports(filePath: string, source: string): RawImport[] {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKindFromPath(filePath));
  const imports: RawImport[] = [];
  const add = (specifier: string, weight: 0 | 1) => imports.push({ specifier, weight });

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, importWeight(node));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, exportWeight(node));
    } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        add(node.arguments[0].text, 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return imports;
}

function importWeight(node: ts.ImportDeclaration): 0 | 1 {
  const clause = node.importClause;
  if (!clause) return 1;
  if (clause.isTypeOnly) return 0;
  if (clause.name) return 1;
  if (!clause.namedBindings) return 1;
  if (ts.isNamespaceImport(clause.namedBindings)) return 1;
  return clause.namedBindings.elements.some((element) => !element.isTypeOnly) ? 1 : 0;
}

function exportWeight(node: ts.ExportDeclaration): 0 | 1 {
  if (node.isTypeOnly) return 0;
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return 1;
  if (ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements.some((element) => !element.isTypeOnly) ? 1 : 0;
  }
  return 1;
}

function resolveTargets(specifier: string, containingFile: string, root: string, seen: Set<string>, depth: number): string[] {
  const resolution = resolveImport(specifier, containingFile, root);
  if (resolution.kind !== "internal" || !resolution.path) return [];
  const target = resolve(resolution.path);
  if (depth >= MAX_BARREL_DEPTH || seen.has(target) || !isReExportOnlyBarrel(target)) return [target];

  const nextSeen = new Set(seen).add(target);
  const targets = collectImports(target, readFileSync(target, "utf8"))
    .flatMap((entry) => resolveTargets(entry.specifier, target, root, nextSeen, depth + 1));
  return targets.length > 0 ? [...new Set(targets)] : [target];
}

function isReExportOnlyBarrel(path: string): boolean {
  if (!path.endsWith("/index.ts") && !path.endsWith("/index.tsx") && !path.endsWith("/index.js")) return false;
  try {
    const sourceFile = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, scriptKindFromPath(path));
    return sourceFile.statements.length > 0 && sourceFile.statements.every((statement) => ts.isExportDeclaration(statement) && !!statement.moduleSpecifier);
  } catch {
    return false;
  }
}

function findCycles(paths: string[], edges: DependencyEdge[], changed: Set<string>): CycleReport[] {
  const adjacency = new Map(paths.map((path) => [path, [] as string[]]));
  for (const edge of edges) adjacency.get(edge.from)?.push(edge.to);
  for (const targets of adjacency.values()) targets.sort();

  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const strongConnect = (path: string) => {
    indices.set(path, index);
    lowLinks.set(path, index++);
    stack.push(path);
    onStack.add(path);
    for (const target of adjacency.get(path) ?? []) {
      if (!indices.has(target)) {
        strongConnect(target);
        lowLinks.set(path, Math.min(lowLinks.get(path)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(path, Math.min(lowLinks.get(path)!, indices.get(target)!));
      }
    }
    if (lowLinks.get(path) === indices.get(path)) {
      const component: string[] = [];
      let item: string;
      do {
        item = stack.pop()!;
        onStack.delete(item);
        component.push(item);
      } while (item !== path);
      if (component.length > 1 || (adjacency.get(component[0]) ?? []).includes(component[0])) {
        components.push(component.sort());
      }
    }
  };
  for (const path of paths) if (!indices.has(path)) strongConnect(path);

  return components
    .filter((component) => component.some((path) => changed.size === 0 || changed.has(path)))
    .map((component) => {
      const componentSet = new Set(component);
      const componentEdges = edges.filter((edge) => componentSet.has(edge.from) && componentSet.has(edge.to)).sort(compareEdges);
      return { files: component, edges: componentEdges, weakest: [...componentEdges].sort((a, b) => a.uses - b.uses || compareEdges(a, b))[0] };
    })
    .sort((a, b) => a.files[0].localeCompare(b.files[0]));
}

function readLayerRules(root: string): Array<{ from: string; to: string }> {
  const path = resolve(root, "coupling-gate.json");
  if (!existsSync(path)) return [];
  try {
    const config = JSON.parse(readFileSync(path, "utf8")) as { forbid?: unknown };
    return Array.isArray(config.forbid)
      ? config.forbid.filter((rule): rule is { from: string; to: string } => isRule(rule))
      : [];
  } catch {
    return [];
  }
}

function isRule(value: unknown): value is { from: string; to: string } {
  return typeof value === "object" && value !== null && typeof (value as { from?: unknown }).from === "string" && typeof (value as { to?: unknown }).to === "string";
}

function matchesLayer(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function folderOf(path: string): string {
  return path.includes("/") ? path.split("/")[0]! : ".";
}

function relativePath(root: string, path: string): string {
  return relative(root, path).split("\\").join("/");
}

function edgeKey(edge: DependencyEdge): string {
  return `${edge.from} → ${edge.to}`;
}

function compareEdges(a: DependencyEdge, b: DependencyEdge): number {
  return a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)|(?:\.test|\.spec)\.[^.]+$/.test(path);
}

function scriptKindFromPath(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
