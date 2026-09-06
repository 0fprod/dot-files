import ts from "typescript";

export type FunctionComplexity = {
  name: string;
  complexity: number;
  line: number;
  column: number;
};

export type ComplexityReport = {
  path: string;
  threshold: number;
  functions: FunctionComplexity[];
  violations: FunctionComplexity[];
  allowed: boolean;
};

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const ALLOW_MARKER = "complexity-gate:allow";

export function isSupportedPath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const extension of SUPPORTED_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

export function analyzeSource(path: string, source: string, threshold: number): ComplexityReport {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindFromPath(path));
  const functions = collectFunctions(sourceFile);
  const allowed = source.includes(ALLOW_MARKER);

  return {
    path,
    threshold,
    functions,
    violations: allowed ? [] : functions.filter((entry) => entry.complexity > threshold),
    allowed,
  };
}

export function formatReport(report: ComplexityReport): string {
  if (report.violations.length === 0) {
    return report.allowed
      ? `Complexity gate: PASS ${report.path} (allowed by complexity-gate:allow)`
      : `Complexity gate: PASS ${report.path}`;
  }

  return [
    `Complexity gate: FAIL ${report.path}`,
    ...report.violations.map(
      (entry) => `- ${entry.name} line ${entry.line} col ${entry.column} complexity ${entry.complexity} > ${report.threshold}`,
    ),
    "Suggestion: see the codebase-design skill: use deepening to narrow the interface at the seam, rather than fragmenting behavior artificially.",
  ].join("\n");
}

function collectFunctions(sourceFile: ts.SourceFile): FunctionComplexity[] {
  const functions: FunctionComplexity[] = [];

  const visit = (node: ts.Node) => {
    if (isTrackedFunction(node)) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      functions.push({
        name: getFunctionName(node),
        complexity: countComplexity(node),
        line: position.line + 1,
        column: position.character + 1,
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return functions;
}

function isBranch(child: ts.Node): boolean {
  return (
    ts.isIfStatement(child) ||
    ts.isForStatement(child) ||
    ts.isForInStatement(child) ||
    ts.isForOfStatement(child) ||
    ts.isWhileStatement(child) ||
    ts.isDoStatement(child) ||
    ts.isCatchClause(child) ||
    ts.isConditionalExpression(child) ||
    ts.isSwitchStatement(child) ||
    (ts.isBinaryExpression(child) &&
      (child.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        child.operatorToken.kind === ts.SyntaxKind.BarBarToken))
  );
}

function countComplexity(node: ts.Node): number {
  let complexity = 1;

  // Flat branches (guard clauses, early returns) cost 1; nested branches cost
  // 1 + depth so pyramid-shaped code is penalized while flat code is not.
  const visit = (child: ts.Node, depth: number) => {
    if (child !== node && isTrackedFunction(child)) {
      return;
    }

    const branch = child !== node && isBranch(child);
    if (branch) {
      complexity += 1 + depth;
    }

    ts.forEachChild(child, (grandchild) => visit(grandchild, branch ? depth + 1 : depth));
  };

  ts.forEachChild(node, (child) => visit(child, 0));
  return complexity;
}

function isTrackedFunction(node: ts.Node): node is TrackedFunctionNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

type TrackedFunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

function getFunctionName(node: TrackedFunctionNode): string {
  if (ts.isConstructorDeclaration(node)) {
    return "constructor";
  }

  if (node.name) {
    return node.name.getText();
  }

  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }

  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name.getText();
  }

  return "<anonymous>";
}

function scriptKindFromPath(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}
