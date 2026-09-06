import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";

export type ModuleResolution = {
  kind: "internal" | "external";
  path?: string;
  tsconfigPath?: string;
  note?: string;
};

type LoadedConfig = {
  compilerOptions: ts.CompilerOptions;
  tsconfigPath: string;
};

const MAX_EXTENDS_DEPTH = 10;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

export function findNearestTsconfig(filePath: string, root: string): string | undefined {
  let directory = dirname(resolve(filePath));
  const boundary = resolve(root);

  while (directory.startsWith(boundary)) {
    const candidate = resolve(directory, "tsconfig.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    if (directory === boundary) {
      break;
    }
    directory = dirname(directory);
  }

  return undefined;
}

export function resolveImport(specifier: string, containingFile: string, repoRoot: string): ModuleResolution {
  const configPath = findNearestTsconfig(containingFile, repoRoot);
  const config = configPath ? loadConfig(configPath) : undefined;
  const compilerOptions = config?.compilerOptions ?? {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  };
  const containingPath = resolve(containingFile);
  const resolved = ts.resolveModuleName(specifier, containingPath, compilerOptions, ts.sys).resolvedModule ??
    resolveWithModernModuleResolution(specifier, containingPath, compilerOptions);
  const resolvedPath = resolved?.resolvedFileName
    ? resolve(resolved.resolvedFileName)
    : resolveSourceFallback(specifier, containingPath, compilerOptions);

  if (resolvedPath) {
    const rootRelative = relative(resolve(repoRoot), resolvedPath);
    if (!rootRelative.startsWith("..") && !rootRelative.includes(`${ts.sys.useCaseSensitiveFileNames ? "/" : "\\"}node_modules${ts.sys.useCaseSensitiveFileNames ? "/" : "\\"}`) && !isNodeModulesPath(rootRelative)) {
      return {
        kind: "internal",
        path: resolvedPath,
        tsconfigPath: config?.tsconfigPath,
      };
    }
  }

  return {
    kind: "external",
    ...(config?.tsconfigPath ? { tsconfigPath: config.tsconfigPath } : {}),
    ...(configPath ? {} : { note: "no tsconfig found, bare imports treated as external" }),
  };
}

function resolveWithModernModuleResolution(
  specifier: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
): ts.ResolvedModuleFull | undefined {
  return ts.resolveModuleName(
    specifier,
    containingFile,
    { ...compilerOptions, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
    ts.sys,
  ).resolvedModule;
}

function resolveSourceFallback(
  specifier: string,
  containingFile: string,
  compilerOptions: ts.CompilerOptions,
): string | undefined {
  const candidates: string[] = [];
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    candidates.push(resolve(dirname(containingFile), specifier));
  }

  if (compilerOptions.baseUrl && compilerOptions.paths) {
    for (const [pattern, targets] of Object.entries(compilerOptions.paths)) {
      const wildcard = pattern.indexOf("*");
      const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
      const suffix = wildcard < 0 ? "" : pattern.slice(wildcard + 1);
      if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
        const match = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
        candidates.push(...targets.map((target) => resolve(compilerOptions.baseUrl!, target.replace("*", match))));
      }
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate) && !isNodeModulesPath(relative(process.cwd(), candidate))) {
      return candidate;
    }
    for (const extension of SOURCE_EXTENSIONS) {
      if (existsSync(candidate + extension)) {
        return candidate + extension;
      }
    }
    for (const extension of SOURCE_EXTENSIONS) {
      const index = resolve(candidate, `index${extension}`);
      if (existsSync(index)) {
        return index;
      }
    }
  }

  return undefined;
}

function isNodeModulesPath(path: string): boolean {
  return path.split(/[\\/]/).includes("node_modules");
}

function loadConfig(configPath: string): LoadedConfig {
  const chain = loadConfigChain(resolve(configPath), new Set<string>(), 0);
  const compilerOptions = toCompilerOptions(chain.options, chain.baseUrlOrigin);
  return { compilerOptions, tsconfigPath: resolve(configPath) };
}

type ConfigChain = {
  options: Record<string, unknown>;
  baseUrlOrigin: string;
};

function loadConfigChain(configPath: string, seen: Set<string>, depth: number): ConfigChain {
  if (depth > MAX_EXTENDS_DEPTH || seen.has(configPath)) {
    return { options: {}, baseUrlOrigin: dirname(configPath) };
  }
  seen.add(configPath);

  const parsed = ts.readConfigFile(configPath, ts.sys.readFile);
  if (parsed.error || !parsed.config || typeof parsed.config !== "object") {
    return { options: {}, baseUrlOrigin: dirname(configPath) };
  }

  const config = parsed.config as Record<string, unknown>;
  const parentPath = typeof config.extends === "string" ? findExtendedConfig(configPath, config.extends) : undefined;
  const parent = parentPath ? loadConfigChain(parentPath, seen, depth + 1) : { options: {}, baseUrlOrigin: dirname(configPath) };
  const childCompilerOptions = isRecord(config.compilerOptions) ? config.compilerOptions : {};
  const options = { ...parent.options, ...childCompilerOptions };

  if (isRecord(parent.options.paths) || isRecord(childCompilerOptions.paths)) {
    options.paths = {
      ...(isRecord(parent.options.paths) ? parent.options.paths : {}),
      ...(isRecord(childCompilerOptions.paths) ? childCompilerOptions.paths : {}),
    };
  }

  const baseUrlOrigin = typeof childCompilerOptions.baseUrl === "string" ? dirname(configPath) : parent.baseUrlOrigin;
  return { options, baseUrlOrigin };
}

function findExtendedConfig(configPath: string, extendsValue: string): string | undefined {
  const base = isAbsolute(extendsValue) ? extendsValue : resolve(dirname(configPath), extendsValue);
  for (const candidate of [base, `${base}.json`, resolve(base, "tsconfig.json")]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function toCompilerOptions(raw: Record<string, unknown>, baseUrlOrigin: string): ts.CompilerOptions {
  const baseUrl = typeof raw.baseUrl === "string" ? resolve(baseUrlOrigin, raw.baseUrl) : undefined;
  const paths = isRecord(raw.paths) && baseUrl
    ? Object.fromEntries(
        Object.entries(raw.paths).map(([key, values]) => [
          key,
          Array.isArray(values)
            ? values.filter((value): value is string => typeof value === "string").map((value) => resolve(baseUrl, value))
            : [],
        ]),
      )
    : undefined;
  const converted = ts.convertCompilerOptionsFromJson(
    {
        moduleResolution: raw.moduleResolution,
      module: raw.module,
      target: raw.target,
    },
    baseUrlOrigin,
  );

  return {
    ...converted.options,
    moduleResolution: converted.options.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
    module: converted.options.module ?? ts.ModuleKind.NodeNext,
    ...(baseUrl ? { baseUrl } : {}),
    ...(paths ? { paths } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
}
