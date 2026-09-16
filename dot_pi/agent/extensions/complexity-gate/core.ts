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
  warningThreshold: number;
  functions: FunctionComplexity[];
  violations: FunctionComplexity[];
  warnings: FunctionComplexity[];
};

export type ExportUsageIssue = {
  name: string;
  line: number;
  column: number;
  message: string;
};

const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const COMPLEXITY_BRANCH_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CaseClause,
]);
const LOGICAL_OPERATOR_KINDS = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken]);
const HELPER_MODULE_PATTERN = /\.helpers?\.[mc]?[jt]sx?$/i;

export function isSupportedPath(path: string): boolean {
  const lower = path.toLowerCase();
  for (const extension of SUPPORTED_EXTENSIONS) {
    if (lower.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

export function isHelperModulePath(path: string): boolean {
  return HELPER_MODULE_PATTERN.test(path);
}

export function analyzeSource(path: string, source: string, threshold: number, warningThreshold = threshold + 8): ComplexityReport {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindFromPath(path));
  const functions = collectFunctions(sourceFile);
  const effectiveWarningThreshold = Math.max(warningThreshold, threshold + 1);

  return {
    path,
    threshold,
    warningThreshold: effectiveWarningThreshold,
    functions,
    violations: functions.filter((entry) => entry.complexity > threshold && entry.complexity < effectiveWarningThreshold),
    warnings: functions.filter((entry) => entry.complexity >= effectiveWarningThreshold),
  };
}

export function analyzeUnusedExports(
  path: string,
  source: string,
  consumers: Array<{ path: string; source: string }>,
): ExportUsageIssue[] {
  if (!isHelperModulePath(path)) {
    return [];
  }

  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKindFromPath(path));
  const exported = collectNamedExports(sourceFile);
  if (exported.length === 0) {
    return [];
  }

  const usedNames = new Set<string>();
  for (const consumer of consumers) {
    const consumerFile = ts.createSourceFile(
      consumer.path,
      consumer.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFromPath(consumer.path),
    );
    for (const name of collectImportedNames(consumerFile, path)) {
      usedNames.add(name);
    }
  }

  return exported
    .filter((entry) => !usedNames.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      line: entry.line,
      column: entry.column,
      message: "Unused export in helper module. Make it module-private.",
    }));
}

export function formatReport(report: ComplexityReport): string {
  const lines = [report.violations.length > 0 ? `Complexity gate: FAIL ${report.path}` : `Complexity gate: PASS ${report.path}`];
  lines.push(
    ...report.violations.map(
      (entry) => `- ${entry.name} line ${entry.line} col ${entry.column} complexity ${entry.complexity} > ${report.threshold}`,
    ),
  );
  if (report.warnings.length > 0) {
    lines.push(
      "Warnings (non-blocking):",
      ...report.warnings.map(
        (entry) => `- ${entry.name} line ${entry.line} col ${entry.column} complexity ${entry.complexity} >= ${report.warningThreshold}`,
      ),
    );
  }
  return lines.join("\n");
}

function collectNamedExports(sourceFile: ts.SourceFile): Array<{ name: string; line: number; column: number }> {
  const exported: Array<{ name: string; line: number; column: number }> = [];

  const add = (nameNode: ts.Node | undefined, declarationNode: ts.Node) => {
    if (!nameNode) {
      return;
    }

    const position = sourceFile.getLineAndCharacterOfPosition(declarationNode.getStart(sourceFile));
    exported.push({
      name: nameNode.getText(sourceFile),
      line: position.line + 1,
      column: position.character + 1,
    });
  };

  for (const statement of sourceFile.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!isExported) {
      continue;
    }

    if (ts.isFunctionDeclaration(statement)) {
      add(statement.name, statement);
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          add(declaration.name, statement);
        }
      }
    }
  }

  return exported;
}

function collectImportedNames(sourceFile: ts.SourceFile, importedPath: string): string[] {
  const names: string[] = [];
  const targetBases = candidateImportBases(importedPath);

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    if (!targetBases.has(statement.moduleSpecifier.text)) {
      continue;
    }

    const clause = statement.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
      continue;
    }

    for (const element of clause.namedBindings.elements) {
      names.push((element.propertyName ?? element.name).text);
    }
  }

  return names;
}

function candidateImportBases(path: string): Set<string> {
  const withoutExtension = path.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension.replace(/^(\.\/)+/, "");
  const fileName = normalized.split("/").at(-1) ?? normalized;

  return new Set([
    withoutExtension,
    normalized,
    `./${normalized}`,
    `../${fileName}`,
    `./${fileName}`,
    fileName,
  ]);
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

function countComplexity(node: ts.Node): number {
  let complexity = 1;

  const visit = (child: ts.Node) => {
    if (child !== node && isTrackedFunction(child)) {
      return;
    }

    if (COMPLEXITY_BRANCH_KINDS.has(child.kind)) {
      complexity += 1;
    }

    if (ts.isBinaryExpression(child) && LOGICAL_OPERATOR_KINDS.has(child.operatorToken.kind)) {
      complexity += 1;
    }

    ts.forEachChild(child, visit);
  };

  ts.forEachChild(node, visit);
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
