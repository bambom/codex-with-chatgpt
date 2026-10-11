import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  hashBytes,
  hashDocument,
  parseStrict,
  type AuthoringDocument,
  type AssetManifest,
} from "@magicgamestudio/ui-design-contract";
import {
  SPEC_DIGEST,
  getSpecification,
} from "@magicgamestudio/ui-design-contract/spec";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { precheckAuthoring } from "../src/ui-design/precheck.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const packageRoot = path.resolve(path.dirname(createRequire(import.meta.url).resolve("@magicgamestudio/ui-design-contract")), "../..");
const fixtureRoot = path.join(packageRoot, "fixtures");
const document = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, "complete.authoring.json"), "utf8"),
) as AuthoringDocument;
const fixture = JSON.parse(
  fs.readFileSync(path.join(fixtureRoot, "submission-fixtures.json"), "utf8"),
) as { manifest: AssetManifest };
let root: string,
  state: string,
  bridge: Bridge,
  workspace: Workspace,
  reader: Client,
  denied: Client;
const clients: Client[] = [];
const manifest = structuredClone(fixture.manifest);
function data(result: { content?: unknown }) {
  return JSON.parse((result.content as { text: string }[])[0].text);
}
async function connect(scopes: string[]) {
  const token = bridge.authStore.issueTokens({
    clientId: "ui-design-" + clients.length,
    scopes,
  });
  const client = new Client({ name: "ui-design-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(bridge.localBaseUrl() + "/mcp"), {
      requestInit: {
        headers: { authorization: "Bearer " + token.accessToken },
      },
    }),
  );
  clients.push(client);
  return client;
}
beforeAll(async () => {
  state = isolateStateDir();
  root = makeTmpDir("ui-design-ws");
  workspace = new Workspace(root);
  fs.cpSync(fixtureRoot, path.join(root, "package"), { recursive: true });
  write(root, ".env", "PRIVATE_TEST_VALUE=never-return\n");
  const preview = fs.readFileSync(
    path.join(fixtureRoot, "files/reference.png"),
  );
  const overview = fs.readFileSync(path.join(fixtureRoot, "files/skin.png"));
  for (const file of manifest.files)
    if (["preview", "overview", "provenance"].includes(file.role)) {
      const bytes =
        file.role === "preview"
          ? preview
          : file.role === "overview"
            ? overview
            : Buffer.from('{"testOnly":true}');
      fs.mkdirSync(path.dirname(path.join(root, "package", file.path)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, "package", file.path), bytes);
      file.sha256 = hashBytes(bytes);
      file.byteLength = bytes.length;
    }
  write(root, "package/manifest.json", JSON.stringify(manifest));
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(state, "auth.json"),
  });
  reader = await connect(["workspace.read"]);
  denied = await connect(["git.read"]);
});
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await bridge.close();
  cleanup(root);
  cleanup(state);
  delete process.env.C2C_STATE_DIR;
});

describe("platform authoring tools over real MCP HTTP transport", () => {
  it("publishes the pinned platform spec independently of legacy scene/FGUI tools", async () => {
    const tools = (await reader.listTools()).tools;
    for (const name of ["ui_design_spec", "ui_design_precheck"])
      expect(
        tools.find((t) => t.name === name)?.annotations?.readOnlyHint,
      ).toBe(true);
    const summary = data(
      await reader.callTool({ name: "ui_design_spec", arguments: {} }),
    );
    expect(summary).toMatchObject({
      specDigest: SPEC_DIGEST,
      source: "platform-bundled",
      liveServer: false,
    });
    expect(summary.data.capabilities.save.serverPersistenceImplemented).toBe(
      false,
    );
    const example = data(
      await reader.callTool({
        name: "ui_design_spec",
        arguments: { section: "example" },
      }),
    );
    expect(hashDocument(example.data)).toBe(hashDocument(document));
  });
  it("requires read scope for spec and precheck", async () => {
    for (const name of ["ui_design_spec", "ui_design_precheck"]) {
      const response = await denied.callTool({
        name,
        arguments:
          name === "ui_design_spec"
            ? {}
            : { document_json: JSON.stringify(document) },
      });
      expect(response.isError).toBe(true);
      expect(data(response).error).toBe("INSUFFICIENT_SCOPE");
    }
  });
  it("passes an editable document while explicitly remaining unsaved", async () => {
    const response = await reader.callTool({
      name: "ui_design_precheck",
      arguments: { document_path: "package/complete.authoring.json" },
    });
    expect(response.isError).not.toBe(true);
    expect(data(response)).toMatchObject({
      valid: true,
      saved: false,
      receipt: null,
      documentHash: hashDocument(document),
      checks: {
        authoring: "PASS",
        layout: "PASS",
        files: "NOT_CHECKED",
        visual: "NOT_IMPLEMENTED",
        platformAuthorization: "NOT_CONNECTED",
      },
    });
  });
  it("preserves duplicate-key and precision errors from raw JSON", async () => {
    for (const [raw, code] of [
      ['{"a":1,"a":2}', "DUPLICATE_KEY"],
      ["1.000000000000000001", "NUMBER"],
    ]) {
      const response = await reader.callTool({
        name: "ui_design_precheck",
        arguments: { document_json: raw },
      });
      expect(response.isError).toBe(true);
      expect(data(response).issues[0].code).toBe(code);
      expect(data(response).saved).toBe(false);
    }
  });
  it("cannot read sensitive files or paths outside the workspace", async () => {
    for (const document_path of [".env", "../outside.json"]) {
      const response = await reader.callTool({
        name: "ui_design_precheck",
        arguments: { document_path },
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).not.toContain("never-return");
    }
  });
  it("checks real file hashes and RGBA decode without granting visual or save success", async () => {
    const response = await reader.callTool({
      name: "ui_design_precheck",
      arguments: {
        document_path: "package/complete.authoring.json",
        manifest_path: "package/manifest.json",
        submission_id: manifest.submissionId,
        base_revision: 0,
        verify_files: true,
        package_directory: "package",
      },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(data(response)).toMatchObject({
      valid: true,
      saved: false,
      receipt: null,
      assetManifestHash: hashDocument(manifest),
      checks: {
        manifest: "PASS",
        files: "PASS",
        visual: "NOT_IMPLEMENTED",
        fontShaping: "NOT_IMPLEMENTED",
      },
    });
    expect(
      data(response).fileChecks.filter(
        (f: { imageDecode: string }) => f.imageDecode === "PASS",
      ).length,
    ).toBe(5);
  });
});
describe("precheck boundaries", () => {
  it("refuses ambiguous inputs and missing candidate identity", async () => {
    await expect(
      precheckAuthoring(workspace, {
        documentJson: JSON.stringify(document),
        documentPath: "package/complete.authoring.json",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
    await expect(
      precheckAuthoring(workspace, {
        documentJson: JSON.stringify(document),
        manifestJson: JSON.stringify(manifest),
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENTS" });
  });
  it("detects stale specification digests and missing fixed dependencies", async () => {
    const wrong = structuredClone(manifest);
    wrong.specDigest = "0".repeat(64);
    wrong.files = wrong.files.filter((f) => f.role !== "font");
    const report = await precheckAuthoring(workspace, {
      documentJson: JSON.stringify(document),
      manifestJson: JSON.stringify(wrong),
      submissionId: manifest.submissionId,
      baseRevision: 0,
    });
    expect(report.valid).toBe(false);
    expect(report.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(["MANIFEST_IDENTITY", "MANIFEST_REFERENCE"]),
    );
  });
  it("rejects altered bytes before image decoding", async () => {
    const wrong = structuredClone(manifest);
    const file = wrong.files.find((f) => f.role === "preview")!;
    file.sha256 = "0".repeat(64);
    const report = await precheckAuthoring(workspace, {
      documentJson: JSON.stringify(document),
      manifestJson: JSON.stringify(wrong),
      submissionId: manifest.submissionId,
      baseRevision: 0,
      verifyFiles: true,
      packageDirectory: "package",
    });
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "FILE_HASH")).toBe(true);
    expect(report.saved).toBe(false);
  });
  it("rejects a hash-correct truncated PNG", async () => {
    const wrong = structuredClone(manifest);
    const file = wrong.files.find((f) => f.role === "preview")!;
    const bytes = fs
      .readFileSync(path.join(root, "package", file.path))
      .subarray(0, 45);
    file.path = "outputs/truncated.png";
    file.sha256 = hashBytes(bytes);
    file.byteLength = bytes.length;
    fs.writeFileSync(path.join(root, "package", file.path), bytes);
    const report = await precheckAuthoring(workspace, {
      documentJson: JSON.stringify(document),
      manifestJson: JSON.stringify(wrong),
      submissionId: manifest.submissionId,
      baseRevision: 0,
      verifyFiles: true,
      packageDirectory: "package",
    });
    expect(report.valid).toBe(false);
    expect(report.checks.files).toBe("FAIL");
  });
  it("rejects malformed UTF-8 and BOM rather than silently normalizing", async () => {
    fs.writeFileSync(
      path.join(root, "invalid.json"),
      Buffer.from([0x22, 0xc3, 0x28, 0x22]),
    );
    await expect(
      precheckAuthoring(workspace, { documentPath: "invalid.json" }),
    ).rejects.toMatchObject({ code: "INVALID_UTF8" });
    fs.writeFileSync(
      path.join(root, "bom.json"),
      Buffer.from("\ufeff" + JSON.stringify(document)),
    );
    expect(
      (await precheckAuthoring(workspace, { documentPath: "bom.json" }))
        .issues[0].code,
    ).toBe("JSON");
  });
  it("does not mutate the bundled specification or input", async () => {
    const before = hashDocument(document);
    await precheckAuthoring(workspace, {
      documentJson: JSON.stringify(document),
    });
    expect(hashDocument(document)).toBe(before);
    const info = getSpecification("example");
    (info.data as { title: string }).title = "mutated";
    expect(hashDocument(getSpecification("example").data)).toBe(before);
  });
});
