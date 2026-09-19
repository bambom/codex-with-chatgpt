import { it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Workspace } from "../src/workspace/manager.js";
import { importImage } from "../src/workspace/import-image.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";

it("imports original image bytes locally, refuses overwrites, escapes and excluded targets", async () => {
  const root = makeTmpDir("image-import"); const downloads = makeTmpDir("downloads");
  try {
    write(root, ".c2cignore", "private/\n");
    const source = path.join(downloads, "generated.png");
    const bytes = await sharp({ create: { width: 12, height: 8, channels: 4, background: "green" } }).png().toBuffer();
    fs.writeFileSync(source, bytes);
    const workspace = new Workspace(root);
    const result = await importImage(workspace, source, "generated/test.png");
    expect(result.path).toBe("generated/test.png");
    expect(fs.readFileSync(path.join(root, result.path))).toEqual(bytes);
    await expect(importImage(workspace, source, "generated/test.png")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(importImage(workspace, source, "../escape.png")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    await expect(importImage(workspace, source, "private/test.png")).rejects.toMatchObject({ code: "ACCESS_DENIED_SENSITIVE_FILE" });
    await expect(importImage(workspace, source, "generated/test.exe")).rejects.toThrow("image extension");
  } finally { cleanup(root); cleanup(downloads); }
});
