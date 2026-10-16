import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { zipSync } from "fflate";
import { expect, it } from "vitest";
import { hashBytes } from "@magicgamestudio/ui-design-contract";
import { createWebChatMcpServer, UNIFIED_CHAT_TOOLS, WEB_CHAT_TOOLS } from "../src/ui-design/web-chat.js";
import { chatFileUrl, publicIpv4, parseChatBundle } from "../src/ui-design/web-files.js";
import { Workspace } from "../src/workspace/manager.js";

const fixtures = path.resolve(path.dirname(createRequire(import.meta.url).resolve("@magicgamestudio/ui-design-contract")), "../../fixtures");
it("adds two design operations to all thirteen base tools without exposing legacy local design production", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "web-chat-catalog-"));
  const server = createWebChatMcpServer(new Workspace(dir)), client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
  try {
    const { tools } = await client.listTools();expect(tools.map(t => t.name).sort()).toEqual([...UNIFIED_CHAT_TOOLS].sort());
    expect(tools).toHaveLength(15);
    for (const tool of tools.filter(t => WEB_CHAT_TOOLS.includes(t.name as typeof WEB_CHAT_TOOLS[number]))) {
      expect(tool._meta?.["openai/fileParams"]).toEqual(["result_file"]);
      const schema = tool.inputSchema.properties?.result_file as { properties: object; required: string[] };
      expect(Object.keys(schema.properties).sort()).toEqual(["download_url", "file_id", "file_name", "mime_type"]);
      expect(schema.required.sort()).toEqual(["download_url", "file_id"]);
    }
  } finally { await client.close();await server.close();await fs.rm(dir, { recursive: true, force: true }); }
});
it("rejects arbitrary, credential-bearing and private attachment destinations", () => {
  expect(chatFileUrl("https://files.oaiusercontent.com/file?id=bounded").hostname).toBe("files.oaiusercontent.com");
  for (const url of ["http://files.oaiusercontent.com/a", "https://127.0.0.1/a", "https://files.oaiusercontent.com.evil.test/a", "https://user:secret@files.oaiusercontent.com/a", "file:///tmp/a", "https://files.oaiusercontent.com:8443/a"])
    expect(() => chatFileUrl(url)).toThrow();
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.1.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1"])
    expect(publicIpv4(ip)).toBe(false);
  expect(publicIpv4("8.8.8.8")).toBe(true);
});
it("preserves producer bytes and rejects omitted, extra, mismatched and unsafe archive files", async () => {
  const document = JSON.parse(await fs.readFile(path.join(fixtures, "complete.authoring.json"), "utf8"));
  const fixture = JSON.parse(await fs.readFile(path.join(fixtures, "submission-fixtures.json"), "utf8"));
  const manifest = fixture.manifest;
  const files: Record<string, Uint8Array> = { "document.json": Buffer.from(JSON.stringify(document)) };
  for (const file of manifest.files) {
    let bytes: Buffer;
    try { bytes = await fs.readFile(path.join(fixtures, file.path)); }
    catch { bytes = file.role === "provenance" ? Buffer.from('{}') : await fs.readFile(path.join(fixtures, "files/reference.png")); }
    files[file.path] = bytes;file.sha256 = hashBytes(bytes);file.byteLength = bytes.length;
  }
  files["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  const binding = { designId: document.designId, submissionId: manifest.submissionId, baseRevision: manifest.baseRevision };
  const result = parseChatBundle(zipSync(files), binding);expect(result.document).toEqual(document);
  for (const file of manifest.files) expect(Buffer.from(result.files[file.path]!)).toEqual(Buffer.from(files[file.path]!));
  const missing = { ...files };delete missing[manifest.files[0].path];expect(() => parseChatBundle(zipSync(missing), binding)).toThrow();
  expect(() => parseChatBundle(zipSync({ ...files, "extra.txt": Buffer.from('extra') }), binding)).toThrow();
  expect(() => parseChatBundle(zipSync({ ...files, [manifest.files[0].path]: Buffer.from('wrong') }), binding)).toThrow();
  expect(() => parseChatBundle(zipSync({ ...files, "../escape": Buffer.from('escape') }), binding)).toThrow();
  expect(() => parseChatBundle(zipSync(files), { ...binding, designId: "D9876543210" })).toThrow();
});
