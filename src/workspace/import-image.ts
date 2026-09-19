import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { Workspace } from "./manager.js";
import { readImage } from "./image.js";

/** Local Codex-only operation. This is deliberately not exposed as a web tool. */
export async function importImage(workspace: Workspace, source: string, destination: string) {
  const sourcePath = await fs.realpath(source);
  const sourceWorkspace = new Workspace(path.dirname(sourcePath));
  const preview = await readImage(sourceWorkspace, path.basename(sourcePath));
  const target = workspace.resolve(destination);
  if (!/\.(png|jpe?g|webp|gif)$/i.test(target.rel)) throw new Error("Destination must have an image extension.");
  await fs.mkdir(path.dirname(target.abs), { recursive: true });
  // Re-resolve after creating parents to retain the workspace's symlink boundary.
  const verified = workspace.resolve(destination);
  await fs.copyFile(sourcePath, verified.abs, constants.COPYFILE_EXCL);
  return { ok: true, path: verified.rel, source: sourcePath, sizeBytes: (await fs.stat(verified.abs)).size,
    width: preview.metadata.sourceWidth, height: preview.metadata.sourceHeight };
}
