import { Command } from "commander";
import { ContractError } from "@magicgamestudio/ui-design-contract";
import { z } from "zod";
import { Workspace } from "../workspace/manager.js";
import { UiWorkflowError } from "../ui/storage.js";
import { pairPlatform, platformStatus, disconnectPlatform } from "../ui-design/platform.js";
import { prepareLocal, rebindLocal, localStatus, listLocalPreparations, reconstructLocal } from "../ui-design/local.js";
import { inspectLegacyMigration, migrateLegacy } from "../ui-design/migration.js";

/** Endpoint and pairing configuration stay in local CLI authority, outside model tool inputs. */
export function registerUiDesignCommands(program: Command): void {
  const ui = program.command("ui-design").description("Connect the independent UI design platform")
    .option("-w, --workspace <path>", "Connected project root").option("--json", "Machine-readable output", false);
  async function run(command: Command, action: (workspace: Workspace, options: Record<string, unknown>) => Promise<unknown>) {
    const options = command.optsWithGlobals();
    try { const result = await action(new Workspace(options.workspace ?? process.cwd()), options); process.stdout.write(JSON.stringify({ ok: true, ...result as object }) + "\n"); }
    catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error instanceof UiWorkflowError||error instanceof ContractError ? error.code :error instanceof z.ZodError?"INVALID_ARGUMENTS": "PLATFORM_OPERATION_FAILED",
      message: error instanceof UiWorkflowError||error instanceof ContractError ? error.message : "The operation failed; no completion is confirmed.",...(error instanceof UiWorkflowError?{details:error.details}:error instanceof ContractError?{path:error.path}:{}) }) + "\n"); process.exitCode = 1; }
  }
  ui.command("connect").description("Exchange a platform one-time code and securely store the scoped credential")
    .requiredOption("--server <url>", "Trusted platform HTTPS URL; loopback HTTP is allowed")
    .requiredOption("--pairing-code <code>", "One-time code explicitly issued in the platform")
    .action(async (_options, command: Command) => run(command, (workspace, options) => pairPlatform(workspace, String(options.server), String(options.pairingCode))));
  ui.command("status").description("Show connection metadata without exposing credentials")
    .action(async (_options, command: Command) => run(command, workspace => platformStatus(workspace)));
  ui.command("disconnect").description("Revoke the platform connection and remove its local credential")
    .action(async (_options, command: Command) => run(command, workspace => disconnectPlatform(workspace)));
  ui.command("prepare").description("Preserve canonical inputs locally; no platform upload")
    .option("--document <path>","Canonical authoring JSON").option("--resources <path>","Resource binding JSON array").option("--package <path>","Workspace-relative source directory")
    .option("--source-job <uuid>","Rebind retained inputs into a new preparation")
    .requiredOption("--base-revision <number>","Declared platform base revision").option("--submission <id>","Server-generated submission ID").option("--checkpoint <uuid>","Declared checkpoint ID")
    .action(async(_options,command:Command)=>run(command,(workspace,o)=>{
      const association={baseRevision:Number(o.baseRevision),submissionId:o.submission as string|undefined,checkpointId:o.checkpoint as string|undefined};
      if(o.sourceJob){if(o.document||o.resources||o.package)throw new UiWorkflowError("INVALID_ARGUMENTS","Choose a source job or input paths.");return rebindLocal(workspace,String(o.sourceJob),association);}
      if(!o.document||!o.resources||!o.package)throw new UiWorkflowError("INVALID_ARGUMENTS","Provide document, resources and package paths.");
      return prepareLocal(workspace,{documentPath:String(o.document),resourcesPath:String(o.resources),packageDirectory:String(o.package),association});
    }));
  ui.command("legacy-source <job>").description("Read the legacy Scene and explicit migration blockers")
    .action(async(job:string,_options,command:Command)=>run(command,workspace=>inspectLegacyMigration(workspace,job)));
  ui.command("migrate <job>").description("Explicitly convert a supported legacy job into a new canonical preparation")
    .requiredOption("--design <id>","Platform design ID").requiredOption("--destination <path>","New workspace migration directory").requiredOption("--base-revision <number>","Declared base revision").option("--submission <id>","Server-generated submission ID").option("--checkpoint <uuid>","Declared checkpoint ID")
    .action(async(job:string,_options,command:Command)=>run(command,(workspace,o)=>migrateLegacy(workspace,{jobId:job,designId:String(o.design),destinationDirectory:String(o.destination),association:{baseRevision:Number(o.baseRevision),submissionId:o.submission as string|undefined,checkpointId:o.checkpoint as string|undefined}})));
  ui.command("preparations").description("Read local preparation state and attempts").option("--job <uuid>","One preparation")
    .action(async(_options,command:Command)=>run(command,(workspace,o)=>o.job?localStatus(workspace,String(o.job)):listLocalPreparations(workspace)));
  ui.command("reconstruct <job>").description("Produce a standard submission bundle in a new workspace directory")
    .requiredOption("--destination <path>","New workspace-relative directory")
    .action(async(job:string,_options,command:Command)=>run(command,(workspace,o)=>reconstructLocal(workspace,job,String(o.destination))));
}
