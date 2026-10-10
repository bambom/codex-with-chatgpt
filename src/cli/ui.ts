import fs from "node:fs/promises";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { Workspace } from "../workspace/manager.js";
import { addDestination, listDestinations, removeDestination } from "../ui/destinations.js";
import { addNativeAdapter, listNativeAdapters, removeNativeAdapter, runNativeValidation } from "../ui/native.js";
import {
  UI_LIMITS, workflowCapabilities, createJob, getJob, listJobs, listArtifacts,
  importFile, importLocalFile, abortUpload, inspectTarget, setScene, buildJob, deliverJob,
} from "../ui/workflow.js";
import { getWorkflowGuidance } from "../ui/tools.js";

type CliOptions = { workspace?: string; json?: boolean } & Record<string, unknown>;
type MaterialRole = "reference" | "design" | "asset" | "font" | "license" | "data";

function revision(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError("revision must be a non-negative safe integer");
  }
  return Number(value);
}

function role(value: string): MaterialRole {
  if (!["reference", "design", "asset", "font", "license", "data"].includes(value)) {
    throw new InvalidArgumentError("role must be reference, design, asset, font, license, or data");
  }
  return value as MaterialRole;
}

function nativeTimeout(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1000 || Number(value) > 300_000) {
    throw new InvalidArgumentError("timeout-ms must be an integer between 1000 and 300000");
  }
  return Number(value);
}

function literalArgument(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function output(value: unknown, json: boolean): void {
  if (json) {
    const data = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : { items: value };
    process.stdout.write(JSON.stringify({ ok: true, ...data }) + "\n");
  } else process.stdout.write((typeof value === "string" ? value : JSON.stringify(value, null, 2)) + "\n");
}

async function run(command: Command, operation: (workspace: Workspace, options: CliOptions) => unknown | Promise<unknown>): Promise<void> {
  const options = command.optsWithGlobals() as CliOptions;
  try {
    const workspace = new Workspace(path.resolve(options.workspace ?? process.cwd()));
    output(await operation(workspace, options), options.json === true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "UI_OPERATION_FAILED";
    process.stdout.write(options.json ? JSON.stringify({ ok: false, error: code, message }) + "\n" : `UI production: ${message}\n`);
    process.exitCode = 1;
  }
}

/** Local configuration authority is deliberately only registered in the CLI, never in MCP. */
export function registerUiCommands(program: Command): void {
  const ui = program.command("ui")
    .description("Produce layered PSD, PNG assets and native FairyGUI source from a semantic scene")
    .option("-w, --workspace <path>", "Connected project root")
    .option("--json", "Machine-readable output", false);

  ui.command("info").description("Show supported workflow limits and capabilities")
    .action(async (_options, command: Command) => run(command, () => workflowCapabilities()));
  ui.command("guidance").description("Read the bundled UI production skill")
    .action(async (_options, command: Command) => run(command, async () => getWorkflowGuidance()));

  const destination = ui.command("destination").description("Configure named output directories locally");
  destination.command("list").description("List this workspace's available destinations")
    .action(async (_options, command: Command) => run(command, ws => listDestinations(ws)));
  destination.command("add").description("Authorize a local output directory for this workspace")
    .requiredOption("--name <name>", "Stable destination name")
    .requiredOption("--path <path>", "Absolute local output directory, including a Windows drive path on Windows")
    .action(async (_options, command: Command) => run(command, (ws, opts) => addDestination(ws, {
      id: String(opts.name), path: String(opts.path),
    })));
  destination.command("remove").description("Remove a configured destination without deleting delivered files")
    .requiredOption("--name <name>", "Configured destination name")
    .action(async (_options, command: Command) => run(command, (ws, opts) => removeDestination(ws, String(opts.name))));

  const validator = ui.command("validator").description("Configure fixed native editor/runtime validators locally");
  validator.command("list").description("List native validators available to this workspace")
    .action(async (_options, command: Command) => run(command, ws => listNativeAdapters(ws)));
  validator.command("add").description("Authorize a fixed executable and literal arguments as a trusted native validator")
    .requiredOption("--id <id>", "Stable validator ID")
    .requiredOption("--command <path>", "Absolute executable path, or node for the current Node executable")
    .option("--arg <value>", "Literal argument; repeat for multiple arguments, use {request} for the generated request file", literalArgument, [])
    .option("--timeout-ms <number>", "Execution timeout in milliseconds, 1000–300000", nativeTimeout)
    .action(async (_options, command: Command) => run(command, (ws, opts) => addNativeAdapter(ws, {
      id: String(opts.id), command: String(opts.command), args: opts.arg as string[], timeoutMs: opts.timeoutMs as number | undefined,
    })));
  validator.command("remove").description("Remove a validator registration without deleting its executable or evidence")
    .requiredOption("--id <id>", "Configured validator ID")
    .action(async (_options, command: Command) => run(command, (ws, opts) => removeNativeAdapter(ws, String(opts.id))));

  ui.command("create").description("Create a persisted UI production job")
    .requiredOption("--name <name>", "Interface name")
    .option("--target <path>", "Workspace-relative FairyGUI project path")
    .option("--design <path>", "Workspace-relative approved design image")
    .option("--destination <name>", "Configured output destination", "workspace")
    .option("--subdirectory <path>", "Relative subdirectory under that destination")
    .option("--atlas", "Additionally produce the supported atlas output", false)
    .action(async (_options, command: Command) => run(command, (ws, opts) => createJob(ws, {
      name: String(opts.name), targetProject: opts.target as string | undefined,
      designFile: opts.design as string | undefined, destinationId: opts.destination as string | undefined,
      outputSubdirectory: opts.subdirectory as string | undefined, atlas: opts.atlas === true,
    })));
  ui.command("list").description("List UI jobs for this workspace")
    .action(async (_options, command: Command) => run(command, ws => listJobs(ws)));
  ui.command("status <job>").description("Show job revision, materials, outputs, and validation state")
    .action(async (job: string, _options, command: Command) => run(command, ws => getJob(ws, job)));
  ui.command("artifacts <job>").description("List built artifact metadata without reading bytes")
    .action(async (job: string, _options, command: Command) => run(command, ws => listArtifacts(ws, job)));

  ui.command("import <job>").description("Import an existing workspace file without altering the original")
    .requiredOption("--source <path>", "Workspace-relative source file")
    .requiredOption("--path <path>", "Relative material path within the job")
    .requiredOption("--role <role>", "reference/design/asset/font/license/data", role)
    .option("--sha256 <hex>", "Expected full-file SHA-256")
    .action(async (job: string, _options, command: Command) => run(command, (ws, opts) => importFile(ws, job, {
      sourcePath: String(opts.source), path: String(opts.path), role: opts.role as MaterialRole,
      sha256: opts.sha256 as string | undefined,
    })));
  ui.command("inspect-target <job>").description("Inspect the actual source format and save target evidence")
    .option("--path <path>", "Workspace-relative project path; defaults to the job target")
    .option("--revision <number>", "Expected job revision", revision)
    .action(async (job: string, _options, command: Command) => run(command, (ws, opts) => inspectTarget(ws, job, {
      path: opts.path as string | undefined, expectedRevision: opts.revision as number | undefined,
    })));
  ui.command("import-local <job>").description("Import an explicitly chosen file from this computer; available only in the local CLI")
    .requiredOption("--source <path>", "Local source file selected by the user")
    .requiredOption("--path <path>", "Relative material path within the job")
    .requiredOption("--role <role>", "reference/design/asset/font/license/data", role)
    .action(async (job: string, _options, command: Command) => run(command, (ws, opts) => importLocalFile(ws, job, {
      sourcePath: String(opts.source), path: String(opts.path), role: opts.role as MaterialRole,
    })));
  ui.command("abort-upload <job> <upload>").description("Discard an unfinished upload without removing any committed material")
    .action(async (job: string, upload: string, _options, command: Command) => run(command, ws => abortUpload(ws, job, upload)));
  ui.command("set-scene <job>").description("Validate and save shared semantic layout JSON")
    .requiredOption("--file <path>", "Workspace-relative scene JSON file")
    .requiredOption("--revision <number>", "Expected job revision", revision)
    .action(async (job: string, _options, command: Command) => run(command, async (ws, opts) => {
      const sceneFile = ws.resolve(String(opts.file));
      const stat = await fs.stat(sceneFile.abs);
      if (!stat.isFile() || stat.size > UI_LIMITS.maxSceneBytes) throw new Error("Scene must be a regular JSON file within the advertised size limit.");
      const scene: unknown = JSON.parse(await fs.readFile(sceneFile.abs, "utf8"));
      return setScene(ws, job, { scene, expectedRevision: opts.revision as number });
    }));
  ui.command("build <job>").description("Build and validate real deliverables from this job")
    .requiredOption("--revision <number>", "Expected job revision", revision)
    .action(async (job: string, _options, command: Command) => run(command, (ws, opts) => buildJob(ws, job, {
      expectedRevision: opts.revision as number,
    })));
  ui.command("validate-native").description("Run a locally registered editor/runtime validator on a verified build")
    .requiredOption("--job <id>", "Built job ID")
    .requiredOption("--adapter <id>", "Locally configured validator ID")
    .action(async (_options, command: Command) => run(command, (ws, opts) => runNativeValidation(ws, String(opts.job), {
      adapterId: String(opts.adapter),
    })));
  ui.command("deliver <job>").description("Copy built artifacts into a configured local destination")
    .option("--destination <name>", "Configured output destination; defaults to the job choice")
    .option("--subdirectory <path>", "Relative output subdirectory")
    .action(async (job: string, _options, command: Command) => run(command, (ws, opts) => deliverJob(ws, job, {
      destinationId: opts.destination as string | undefined, subdirectory: opts.subdirectory as string | undefined,
    })));
}
