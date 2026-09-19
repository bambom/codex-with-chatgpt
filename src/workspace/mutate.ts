import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Workspace } from "./manager.js";
import { redact } from "../logger/index.js";

const LIMIT = 1024 * 1024;
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");

function target(workspace: Workspace, requested: string) {
  if (requested.replace(/\\/g, "/").split("/").some(p => p.includes(":") || /[. ]$/.test(p) && p !== "." && p !== "..")) {
    throw new Error("Use a workspace-relative path without alternate streams or trailing dots/spaces.");
  }
  const resolved = workspace.resolve(requested);
  if (resolved.rel.split("/").some(p => [".git", ".codex", ".c2c.json", ".c2cignore"].includes(p.toLowerCase()))) {
    throw new Error("Project control files cannot be changed by file tools.");
  }
  return resolved;
}

export function writeFile(workspace: Workspace, requested: string, content: string, expected?: string) {
  if (Buffer.byteLength(content) > LIMIT || content.includes("\0")) throw new Error("Only UTF-8 text up to 1 MiB is supported.");
  let dest = target(workspace, requested);
  const exists = fs.existsSync(dest.abs);
  if (exists) {
    const stat = fs.statSync(dest.abs);
    if (!stat.isFile() || stat.size > LIMIT || stat.nlink > 1) throw new Error("Target must be a regular, unlinked text file up to 1 MiB.");
    const previous = fs.readFileSync(dest.abs, "utf8");
    if (previous.includes("\0")) throw new Error("Binary files are not supported.");
    if (!expected || digest(previous) !== expected) throw new Error("CONFLICT: supply the current file SHA-256 to replace an existing file.");
  } else if (expected) throw new Error("CONFLICT: expected file does not exist.");
  fs.mkdirSync(path.dirname(dest.abs), { recursive: true });
  dest = target(workspace, requested);
  const temporary = path.join(path.dirname(dest.abs), `.c2c-write-${randomUUID()}`);
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode: exists ? fs.statSync(dest.abs).mode : 0o600 });
    if (exists) {
      if (digest(fs.readFileSync(dest.abs, "utf8")) !== expected) throw new Error("CONFLICT: file changed during write.");
      fs.renameSync(temporary, dest.abs);
    } else {
      fs.linkSync(temporary, dest.abs); // Atomic creation, never overwrites a new file.
    }
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { path: dest.rel, sha256: digest(content), sizeBytes: Buffer.byteLength(content) };
}

export function applyPatch(workspace: Workspace, requested: string, edits: { old_text: string; new_text: string }[]) {
  const dest = target(workspace, requested);
  const stat = fs.statSync(dest.abs);
  if (!stat.isFile() || stat.size > LIMIT) throw new Error("Patch target must be a text file up to 1 MiB.");
  const original = fs.readFileSync(dest.abs, "utf8");
  let content = original;
  for (const edit of edits) {
    const offset = content.indexOf(edit.old_text);
    if (!edit.old_text || offset < 0 || content.indexOf(edit.old_text, offset + 1) >= 0) throw new Error("CONFLICT: each old_text must match exactly once.");
    content = content.slice(0, offset) + edit.new_text + content.slice(offset + edit.old_text.length);
  }
  return writeFile(workspace, requested, content, digest(original));
}

/** Executes with host user privileges. cwd is not an OS sandbox. */
export async function runCommand(workspace: Workspace, command: string, cwd = ".", timeoutMs = 30000) {
  const dir = workspace.resolve(cwd).abs;
  if (!fs.statSync(dir).isDirectory()) throw new Error("cwd must be a directory.");
  return new Promise<object>((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "powershell.exe" : "/bin/sh",
      process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command],
      { cwd: dir, windowsHide: true, detached: process.platform !== "win32", env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_ALL)$/i.test(k))) });
    child.stdin.end(); // Interactive commands cannot wait indefinitely for user input.
    let output = "", truncated = false, timedOut = false;
    const capture = (chunk: Buffer) => {
      const text = chunk.toString();
      if (output.length + text.length > 65536) truncated = true;
      output += text.slice(0, Math.max(0, 65536 - output.length));
    };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        killer.on("error", () => child.kill());
      } else if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); } }
    }, Math.min(120000, Math.max(100, timeoutMs)));
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, timedOut, truncated, output: redact(output) }); });
  });
}
