import * as fs from "node:fs/promises";
import * as path from "node:path";

export const resolveLaunchCwd = async (orchestratorCwd: string, requestedCwd?: string): Promise<string> => {
  const candidate = path.resolve(orchestratorCwd, requestedCwd ?? orchestratorCwd);
  let canonical: string;
  try {
    canonical = await fs.realpath(candidate);
  } catch {
    throw new Error(`Launch cwd does not exist or is unreadable: ${candidate}`);
  }

  const stat = await fs.stat(canonical);
  if (!stat.isDirectory()) throw new Error(`Launch cwd is not a directory: ${canonical}`);
  return canonical;
};
