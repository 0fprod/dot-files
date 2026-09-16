import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

interface WriterRecord {
  version: 1;
  workingTree: string;
  profile: string;
  ownerPid: number;
  token: string;
  paneId?: string;
  createdAt: string;
}

export interface AcquireWriterLeaseOptions {
  stateDir: string;
  repositoryId: string;
  /** Lock key for the selected launch scope. Defaults to the canonical repository. */
  ownershipKey?: string;
  workingTree: string;
  profile: string;
  paneExists: (paneId: string) => Promise<boolean>;
  processExists?: (pid: number) => boolean;
}

export interface WriterLease {
  lockPath: string;
  attachPane(paneId: string): Promise<void>;
  attachProcess(pid: number): Promise<void>;
  releaseReservation(): Promise<void>;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function fileNameFor(ownershipKey: string): string {
  return `${createHash("sha256").update(ownershipKey).digest("hex")}.json`;
}

async function readRecord(lockPath: string): Promise<WriterRecord | undefined> {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8")) as WriterRecord;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new Error(`Cannot read writer lock ${lockPath}: ${String(error)}`);
  }
}

async function removeRecord(lockPath: string, token: string): Promise<void> {
  const current = await readRecord(lockPath);
  if (current?.token !== token) return;
  await fs.unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function createRecord(lockPath: string, record: WriterRecord): Promise<boolean> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function acquireWriterLease(options: AcquireWriterLeaseOptions): Promise<WriterLease> {
  await fs.mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(options.stateDir, fileNameFor(options.ownershipKey ?? options.repositoryId));
  const ownerIsAlive = options.processExists ?? processExists;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await readRecord(lockPath);
    if (existing) {
      const active = existing.paneId
        ? await options.paneExists(existing.paneId)
        : ownerIsAlive(existing.ownerPid);
      if (active) {
        const owner = existing.paneId ? `pane ${existing.paneId}` : `launcher process ${existing.ownerPid}`;
        throw new Error(`Writer ${owner} already owns this writer scope (working tree: ${options.workingTree})`);
      }
      await removeRecord(lockPath, existing.token);
      continue;
    }

    const record: WriterRecord = {
      version: 1,
      workingTree: options.workingTree,
      profile: options.profile,
      ownerPid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    if (!(await createRecord(lockPath, record))) continue;

    return {
      lockPath,
      async attachPane(paneId: string) {
        const current = await readRecord(lockPath);
        if (current?.token !== record.token) {
          throw new Error(`Writer reservation was lost for ${options.workingTree}`);
        }
        const attached = { ...current, paneId };
        await fs.writeFile(lockPath, `${JSON.stringify(attached, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      },
      async attachProcess(pid: number) {
        const current = await readRecord(lockPath);
        if (current?.token !== record.token) {
          throw new Error(`Writer reservation was lost for ${options.workingTree}`);
        }
        await fs.writeFile(lockPath, `${JSON.stringify({ ...current, ownerPid: pid }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      },
      async releaseReservation() {
        const current = await readRecord(lockPath);
        if (current?.token === record.token && !current.paneId) {
          await removeRecord(lockPath, record.token);
        }
      },
    };
  }

  throw new Error(`Could not acquire writer ownership for ${options.workingTree}`);
}
