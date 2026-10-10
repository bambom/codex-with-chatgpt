import fs from "node:fs/promises";
import path from "node:path";
import type { Workspace } from "../workspace/manager.js";
import { atomicJson, containedPath, invariant, readJson, safeId, samePath, stateRoot, withLock } from "./storage.js";

export interface UiDestination {
  id: string;
  path: string;
  kind: "workspace" | "local";
}

interface DestinationConfig { version: 1; destinations: UiDestination[] }

async function readConfig(workspace: Workspace): Promise<DestinationConfig> {
  const file = path.join(await stateRoot(workspace), "destinations.json");
  try {
    const config = await readJson<DestinationConfig>(file, 64 * 1024);
    invariant(config.version === 1 && Array.isArray(config.destinations), "INVALID_CONFIG", "Invalid destination configuration.");
    for (const destination of config.destinations) {
      safeId(destination.id, "destination id");
      invariant(destination.id !== "workspace" && destination.kind === "local" && path.isAbsolute(destination.path),
        "INVALID_CONFIG", "Invalid named destination.");
    }
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, destinations: [] };
    throw error;
  }
}

export async function listDestinations(workspace: Workspace): Promise<UiDestination[]> {
  const root = workspace.resolve("generated/ui-deliveries").abs;
  return [{ id: "workspace", path: root, kind: "workspace" }, ...(await readConfig(workspace)).destinations];
}

/** Local CLI only. Do not register this as an MCP tool or accept it in a scene. */
export async function addDestination(workspace: Workspace, input: { id: string; path: string }): Promise<UiDestination> {
  safeId(input.id, "destination id");
  invariant(input.id !== "workspace", "RESERVED_DESTINATION", "The workspace destination is built in.");
  invariant(path.isAbsolute(input.path), "INVALID_DESTINATION", "Choose an absolute path on this computer.");
  const requested = path.resolve(input.path);
  await fs.mkdir(requested, { recursive: true, mode: 0o700 });
  const canonical = await fs.realpath(requested);
  invariant((await fs.stat(canonical)).isDirectory(), "INVALID_DESTINATION", "Destination must be a directory.");
  const destination: UiDestination = { id: input.id, path: canonical, kind: "local" };
  const root = await stateRoot(workspace);
  return withLock(root, async () => {
    const config = await readConfig(workspace);
    const old = config.destinations.find((d) => d.id === input.id);
    invariant(!old || old.path === canonical, "DESTINATION_CONFLICT", "Remove the old destination name locally before changing its root.");
    if (!old) config.destinations.push(destination);
    await atomicJson(path.join(root, "destinations.json"), config);
    return destination;
  });
}

export async function removeDestination(workspace: Workspace, id: string): Promise<{ removed: boolean }> {
  safeId(id, "destination id");
  invariant(id !== "workspace", "RESERVED_DESTINATION", "The workspace destination is built in.");
  const root = await stateRoot(workspace);
  return withLock(root, async () => {
    const config = await readConfig(workspace);
    const before = config.destinations.length;
    config.destinations = config.destinations.filter((d) => d.id !== id);
    await atomicJson(path.join(root, "destinations.json"), config);
    return { removed: before !== config.destinations.length };
  });
}

export async function resolveDestination(workspace: Workspace, id: string): Promise<UiDestination> {
  const destination = (await listDestinations(workspace)).find((d) => d.id === id);
  invariant(destination, "DESTINATION_NOT_CONFIGURED", "Choose a listed destination, or register a directory with the local c2c ui destination command.");
  if (destination.kind === "workspace") {
    // Recheck the connected root; ordinary workspace containment is unchanged.
    const requested = workspace.resolve("generated/ui-deliveries").abs;
    await fs.mkdir(requested, { recursive: true, mode: 0o700 });
    invariant(workspace.resolve("generated/ui-deliveries").abs === requested,
      "DESTINATION_CHANGED", "Destination changed during directory creation.");
    destination.path = await fs.realpath(requested);
  }
  const stat = await fs.lstat(destination.path);
  invariant(stat.isDirectory() && !stat.isSymbolicLink(), "DESTINATION_CHANGED", "Configured destination is no longer a real directory.");
  invariant(samePath(await fs.realpath(destination.path), destination.path), "DESTINATION_CHANGED", "A configured destination ancestor was replaced by a link. Re-select the directory locally.");
  // A probe path validates all normal path checks without creating a file.
  await containedPath(destination.path, "delivery-probe");
  return destination;
}
