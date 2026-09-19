import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { Workspace } from "../src/workspace/manager.js";
import { readImage } from "../src/workspace/image.js";
import { makeTmpDir, cleanup, write } from "./helpers.js";

const dirs: string[] = [];
function setup() { const root = makeTmpDir("images"); dirs.push(root); return root; }
afterEach(() => { dirs.splice(0).forEach(cleanup); });

describe("workspace image previews", () => {
  it.each(["png", "jpeg", "webp", "gif"] as const)("decodes %s based on bytes rather than extension", async (format) => {
    const root = setup();
    const bytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: "blue" } }).toFormat(format).toBuffer();
    fs.writeFileSync(path.join(root, "image.bin"), bytes);
    const result = await readImage(new Workspace(root), "image.bin");
    expect(result.metadata.width).toBe(20);
    expect(result.metadata.height).toBe(10);
    expect((await sharp(Buffer.from(result.data, "base64")).metadata()).format).toBe("png");
  });

  it("rejects damaged images, SVG and oversized inputs", async () => {
    const root = setup();
    fs.writeFileSync(path.join(root, "bad.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    write(root, "vector.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const large = fs.openSync(path.join(root, "large.png"), "w");
    fs.ftruncateSync(large, 20 * 1024 * 1024 + 1); fs.closeSync(large);
    const workspace = new Workspace(root);
    await expect(readImage(workspace, "bad.png")).rejects.toMatchObject({ code: "INVALID_IMAGE" });
    await expect(readImage(workspace, "vector.svg")).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE" });
    await expect(readImage(workspace, "large.png")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("honors custom exclusions and rejects directory symlinks escaping the workspace", async () => {
    const root = setup(); const outside = setup();
    write(root, ".c2cignore", "private/\n");
    write(root, "private/image.png", "hidden");
    fs.symlinkSync(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    const workspace = new Workspace(root);
    await expect(readImage(workspace, "private/image.png")).rejects.toMatchObject({ code: "ACCESS_DENIED_SENSITIVE_FILE" });
    await expect(readImage(workspace, "escape/image.png")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });
});
