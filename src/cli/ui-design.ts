import { Command } from "commander";
import { Workspace } from "../workspace/manager.js";
import { UiWorkflowError } from "../ui/storage.js";
import { pairPlatform, platformStatus, disconnectPlatform } from "../ui-design/platform.js";

/** Endpoint and pairing configuration stay in local CLI authority, outside model tool inputs. */
export function registerUiDesignCommands(program: Command): void {
  const ui = program.command("ui-design").description("Connect the independent UI design platform")
    .option("-w, --workspace <path>", "Connected project root").option("--json", "Machine-readable output", false);
  async function run(command: Command, action: (workspace: Workspace, options: Record<string, unknown>) => Promise<unknown>) {
    const options = command.optsWithGlobals();
    try { const result = await action(new Workspace(options.workspace ?? process.cwd()), options); process.stdout.write(JSON.stringify({ ok: true, ...result as object }) + "\n"); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof UiWorkflowError ? error.code : "PLATFORM_OPERATION_FAILED",
      message: error instanceof UiWorkflowError ? error.message : "The platform operation failed; no completion is confirmed." }) + "\n"); process.exitCode = 1; }
  }
  ui.command("connect").description("Exchange a platform one-time code and securely store the scoped credential")
    .requiredOption("--server <url>", "Trusted platform HTTPS URL; loopback HTTP is allowed")
    .requiredOption("--pairing-code <code>", "One-time code explicitly issued in the platform")
    .action(async (_options, command: Command) => run(command, (workspace, options) => pairPlatform(workspace, String(options.server), String(options.pairingCode))));
  ui.command("status").description("Show connection metadata without exposing credentials")
    .action(async (_options, command: Command) => run(command, workspace => platformStatus(workspace)));
  ui.command("disconnect").description("Revoke the platform connection and remove its local credential")
    .action(async (_options, command: Command) => run(command, workspace => disconnectPlatform(workspace)));
}
