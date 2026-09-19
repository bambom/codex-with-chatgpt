import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../src/workspace/manager.js";
import { writeFile, applyPatch, runCommand, digest } from "../src/workspace/mutate.js";
import { filterScopes } from "../src/auth/store.js";
import { makeTmpDir, cleanup } from "./helpers.js";

it("defaults never grant write or execute access", () => {
  for (const request of [undefined, "", "unknown"]) {
    expect(filterScopes(request)).not.toContain("workspace.write");
    expect(filterScopes(request)).not.toContain("workspace.execute");
  }
  expect(filterScopes("workspace.write workspace.execute")).toEqual(["workspace.write", "workspace.execute"]);
});
it("writes and patches with conflict detection and project boundaries", () => {
  const root = makeTmpDir("mutation"); const ws = new Workspace(root);
  try {
    writeFile(ws, "nested/a.txt", "one two");
    expect(() => writeFile(ws, "nested/a.txt", "bad")).toThrow("CONFLICT");
    expect(() => applyPatch(ws, "nested/a.txt", [{ old_text: "one", new_text: "three" }, { old_text: "absent", new_text: "four" }])).toThrow("CONFLICT");
    expect(fs.readFileSync(path.join(root, "nested/a.txt"), "utf8")).toBe("one two");
    applyPatch(ws, "nested/a.txt", [{ old_text: "one", new_text: "three" }]);
    writeFile(ws, "nested/a.txt", "done", digest("three two"));
    for (const filename of ["../escape.txt", ".env", ".git/config", "a.txt:stream", ".codex/config.toml"]) expect(() => writeFile(ws, filename, "bad")).toThrow();
    const outside = makeTmpDir("outside");
    try { fs.symlinkSync(outside, path.join(root, "escape"), "junction"); expect(() => writeFile(ws, "escape/no.txt", "bad")).toThrow(); } finally { fs.unlinkSync(path.join(root, "escape")); cleanup(outside); }
    expect(() => writeFile(ws, "large.txt", "x".repeat(1048577))).toThrow();
  } finally { cleanup(root); }
});
it("commands capture failures and stop on timeout", async () => {
  const root = makeTmpDir("command"); const ws = new Workspace(root);
  try {
    expect(await runCommand(ws, "exit 7")).toMatchObject({ exitCode: 7, timedOut: false });
    expect(await runCommand(ws, process.platform === "win32" ? "Start-Sleep -Seconds 10" : "sleep 10", ".", 500)).toMatchObject({ timedOut: true });
  } finally { cleanup(root); }
});
