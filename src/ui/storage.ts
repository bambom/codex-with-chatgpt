import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getStateDir } from "../config/paths.js";
import type { Workspace } from "../workspace/manager.js";

export const UI_LIMITS = Object.freeze({
  chunkBytes: 512 * 1024,
  readChunkBytes: 64 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxJobBytes: 1024 * 1024 * 1024,
  maxSceneBytes: 2 * 1024 * 1024,
  maxManifestBytes: 16 * 1024 * 1024,
  maxImagePixels: 32 * 1024 * 1024,
  maxFiles: 2048,
});

export class UiWorkflowError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = "UiWorkflowError";
  }
}

export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new UiWorkflowError(code, message);
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  }));
}

/** Portable file names: no traversal, drives, UNC paths, ADS or Windows devices. */
export function safeRelative(value: string): string {
  invariant(typeof value === "string" && value.length > 0 && value.length <= 480,
    "INVALID_PATH", "Use a non-empty relative path of at most 480 characters.");
  const normalized = value.replace(/\\/g, "/");
  invariant(!normalized.startsWith("/") && !/[\u0000-\u001f\u007f:<>"|?*]/u.test(normalized),
    "INVALID_PATH", "Absolute paths, control characters and Windows special names are not allowed.");
  const parts = normalized.split("/");
  invariant(parts.every((s) => s && s !== "." && s !== ".." && s.length <= 160 &&
    !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s) &&
    !/^(\.git|\.c2c|\.env)(?:\.|$)/i.test(s)), "INVALID_PATH", "Unsafe path component.");
  return parts.join("/");
}

export function safeId(value: string, label = "id"): string {
  invariant(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value), "INVALID_ID", `Invalid ${label}.`);
  return value;
}

export function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const absolute = path.resolve(value);
    return process.platform === "win32" || process.platform === "darwin" ? absolute.toLowerCase() : absolute;
  };
  return normalize(a) === normalize(b);
}

/** Reject junction/symlink components, including leaves that do not exist yet. */
export async function containedPath(root: string, relative: string): Promise<string> {
  const rel = safeRelative(relative);
  const base = path.resolve(root);
  let current = base;
  const baseStat = await fs.lstat(base);
  invariant(baseStat.isDirectory() && !baseStat.isSymbolicLink(), "UNSAFE_DIRECTORY", "Managed root must be a real directory.");
  invariant(samePath(await fs.realpath(base), base), "UNSAFE_DIRECTORY", "An ancestor of the managed root was replaced by a link.");
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      invariant(!stat.isSymbolicLink(), "UNSAFE_SYMLINK", "Symbolic links and junctions are not allowed in managed paths.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}

export async function ensureParent(root: string, relative: string): Promise<string> {
  const result = await containedPath(root, relative);
  await fs.mkdir(path.dirname(result), { recursive: true, mode: 0o700 });
  return containedPath(root, relative);
}

export async function stateRoot(workspace: Workspace): Promise<string> {
  const root = path.join(getStateDir(), "ui-workflow", workspace.id);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  invariant(!(await fs.lstat(root)).isSymbolicLink(), "UNSAFE_DIRECTORY", "Workflow state root must not be a symbolic link.");
  return fs.realpath(root);
}

export async function jobRoot(workspace: Workspace, jobId: string): Promise<string> {
  safeId(jobId, "job id");
  const root = await stateRoot(workspace);
  const result = await containedPath(root, `jobs/${jobId}`);
  try {
    invariant((await fs.stat(result)).isDirectory(), "JOB_NOT_FOUND", "Job does not exist.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new UiWorkflowError("JOB_NOT_FOUND", "Job does not exist in this workspace.");
    throw error;
  }
  return result;
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await fs.rename(temporary, file); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

export async function readJson<T>(file: string, maxBytes = UI_LIMITS.maxSceneBytes): Promise<T> {
  const stat = await fs.lstat(file);
  invariant(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes,
    "INVALID_STATE", "State file is invalid or too large.");
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export async function hashFile(file: string): Promise<{ sizeBytes: number; sha256: string }> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    invariant(stat.isFile() && stat.size <= UI_LIMITS.maxJobBytes, "FILE_TOO_LARGE", "File exceeds the workflow limit.");
    const hash = createHash("sha256");
    let size = 0;
    const chunk = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      invariant(size <= UI_LIMITS.maxJobBytes, "FILE_TOO_LARGE", "File grew beyond the workflow limit.");
      hash.update(chunk.subarray(0, bytesRead));
    }
    invariant(size === stat.size, "FILE_CHANGED", "File changed during hashing; retry.");
    return { sizeBytes: size, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

const activeLocks = new Set<string>();

/** Exclusive, cross-request lock. Publish complete metadata atomically with a
 * hard link, so a crash can leave an orphan owner file but never an empty lock.
 * Local NTFS/APFS/ext4 state directories support this without symlink privileges.
 */
export async function withLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  invariant(!activeLocks.has(directory), "JOB_BUSY", "Another operation owns this job. Poll its status before retrying.");
  activeLocks.add(directory);
  const lock = path.join(directory, "operation.lock");
  const token = randomUUID();
  const ownerFile = path.join(directory, `operation-owner-${token}.tmp`);
  let acquired = false;
  try {
    const handle = await fs.open(ownerFile, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
      await handle.sync();
    } finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.link(ownerFile, lock);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const owner = await readJson<{ pid: number }>(lock, 4096);
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
            try { process.kill(owner.pid, 0); }
            catch (signalError) { stale = (signalError as NodeJS.ErrnoException).code === "ESRCH"; }
          }
        } catch { /* Never steal malformed externally-created state. */ }
        invariant(stale && attempt === 0, "JOB_BUSY", "Another operation owns this job. Poll its status before retrying.");
        await fs.unlink(lock);
      }
    }
    return await action();
  } finally {
    if (acquired) {
      try {
        if ((await readJson<{ token: string }>(lock, 4096)).token === token) await fs.unlink(lock);
      } catch { /* Preserve a lock owned by somebody else. */ }
    }
    await fs.rm(ownerFile, { force: true }).catch(() => undefined);
    activeLocks.delete(directory);
  }
}

export async function walkFiles(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  const directory = relative ? await containedPath(root, relative) : root;
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    safeRelative(rel);
    invariant(!entry.isSymbolicLink(), "UNSAFE_SYMLINK", "A generated directory contains a symbolic link.");
    if (entry.isDirectory()) result.push(...await walkFiles(root, rel));
    else if (entry.isFile()) result.push(rel);
    else throw new UiWorkflowError("INVALID_FILE", "Only regular output files are allowed.");
    invariant(result.length <= UI_LIMITS.maxFiles, "TOO_MANY_FILES", "Too many generated files.");
  }
  return result;
}
