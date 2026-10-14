// Test-only preload: real chat requests, deterministic standalone Images failures.
// Load explicitly with NODE_OPTIONS=--import=<absolute path> on an isolated server.
import fs from "node:fs";

import { PNG } from "pngjs";
import WsClient from "ws";

const stateFile = process.env.QGRID_IMAGE_E2E_FAULT_FILE;
const traceFile = process.env.QGRID_IMAGE_E2E_TRACE_FILE;
if (
  process.env.QGRID_REAL_PROVIDER_ACCEPTANCE !== "1" ||
  process.env.HOST !== "127.0.0.1" ||
  !process.env.SONAMU_DB_NAME?.startsWith("qgrid_e2e_") ||
  !stateFile ||
  !traceFile
)
  throw new Error("Image fault preload requires an explicitly opted-in isolated local E2E server");

function state() {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

function record(value) {
  fs.appendFileSync(traceFile, `${JSON.stringify({ caseId: state().caseId, ...value })}\n`);
}

const emit = WsClient.prototype.emit;
WsClient.prototype.emit = function (event, ...args) {
  if (
    event === "message" &&
    this.url?.startsWith("wss://chatgpt.com/backend-api/codex/responses")
  ) {
    try {
      const data = JSON.parse(args[0].toString());
      if (data.type === "response.completed") {
        const response = data.response;
        record({
          event: "driver-completed",
          model: response.model,
          usage: {
            input_tokens: response.usage?.input_tokens,
            output_tokens: response.usage?.output_tokens,
            cached_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
          },
        });
      }
    } catch {
      // Missing trace evidence fails the runner; instrumentation never changes transport.
    }
  }
  return emit.call(this, event, ...args);
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (
    url.origin !== "https://chatgpt.com" ||
    !/^\/backend-api\/codex\/images\/(generations|edits)$/.test(url.pathname)
  ) {
    return originalFetch(input, init);
  }
  const { mode } = state();
  record({ event: "image-request", mode, path: url.pathname });
  switch (mode) {
    case "http":
      return Response.json(
        { error: { message: "E2E injected image HTTP failure" } },
        { status: 503 },
      );
    case "network":
      throw new TypeError("E2E injected image connection reset");
    case "invalid-image":
      return Response.json({ data: [{ b64_json: "aW52YWxpZA==" }] });
    case "cancel":
      return new Promise((_, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error("Missing image cancellation signal"));
        const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    case "success": {
      const png = new PNG({ width: 1, height: 1 });
      png.data.set([255, 0, 0, 255]);
      return Response.json({
        data: [{ b64_json: PNG.sync.write(png).toString("base64") }],
        background: "opaque",
        model: "gpt-image-2",
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5,
          input_tokens_details: { text_tokens: 2, image_tokens: 0 },
        },
      });
    }
    default:
      throw new Error(`Images requests are blocked without an E2E fault mode: ${mode}`);
  }
};
