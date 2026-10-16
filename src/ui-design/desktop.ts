import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Workspace } from "../workspace/manager.js";
import { pairPlatform, platformStatus, disconnectPlatform, normalizePlatformServer } from "./platform.js";
import { relayPair, relayStatus } from "./relay.js";
import { containedPath, stateRoot, UiWorkflowError } from "../ui/storage.js";

const inputSchema = z.object({ action: z.enum(["status", "bind", "disconnect", "pair"]),
  workspace: z.string().min(1).max(4096), server: z.string().max(2048),
  pairingCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), replace: z.boolean().optional(),
}).strict();

/** Private desktop pipe only. Never registered as a model tool or a network endpoint. */
export async function desktopOperation(input: unknown) {
  const value = inputSchema.parse(input), workspace = new Workspace(value.workspace);
  const server = normalizePlatformServer(value.server), current = await platformStatus(workspace);
  if ("server" in current && current.server !== server) throw new UiWorkflowError("PLATFORM_SERVER_CHANGED", "This workspace belongs to a different server.");
  if (value.action === "bind") {
    if (!value.pairingCode) throw new UiWorkflowError("INVALID_PAIRING_CODE", "A one-time authorization code is required.");
    const result = await pairPlatform(workspace, server, value.pairingCode, value.replace);
    // The host has stopped the old worker. Preserve any interrupted operation for review,
    // without letting its old grant block the new connection or re-executing it.
    const root = await containedPath(await stateRoot(workspace), "cloud-relay");
    const pending = path.join(root, "pending.json");
    let retainedOperation = false;
    try { await fs.rename(pending, path.join(root, `retained-${Date.now()}.json`)); retainedOperation = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return { ...result, retainedOperation };
  }
  if (value.action === "disconnect") return disconnectPlatform(workspace);
  if (value.action === "pair") return relayPair(workspace);
  if (!current.connected) return { connection: current };
  try { return { connection: current, relay: await relayStatus(workspace) }; }
  catch (error) { return { connection: current, relayError: error instanceof UiWorkflowError ? error.code : "RELAY_UNAVAILABLE" }; }
}
