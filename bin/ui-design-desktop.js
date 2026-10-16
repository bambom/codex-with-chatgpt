#!/usr/bin/env node
import { desktopOperation } from "../dist/ui-design/desktop.js";
import { UiWorkflowError } from "../dist/ui/storage.js";
try {
  const chunks = []; let count = 0;
  for await (const chunk of process.stdin) {
    count += chunk.length; if (count > 8192) throw Error("INPUT_TOO_LARGE"); chunks.push(chunk);
  }
  const result = await desktopOperation(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof UiWorkflowError ? error.code : "DESKTOP_OPERATION_FAILED" }) + "\n");
  process.exitCode = 1;
}
