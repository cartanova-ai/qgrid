import { createServer, type RequestListener, type Server } from "node:http";

import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";

import {
  anthropicTransportOptions,
  qgridFetch,
  toQgridTransportError,
} from "./http-transport";

const servers: Server[] = [];
const agents: Agent[] = [];

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.destroy()));
  const open = servers.splice(0);
  open.forEach((server) => server.closeAllConnections());
  await Promise.all(
    open.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback port");
  return `http://127.0.0.1:${address.port}`;
}

function agent(options: ConstructorParameters<typeof Agent>[0]): Agent {
  const created = new Agent(options);
  agents.push(created);
  return created;
}

function post(dispatcher: Agent, signal?: AbortSignal) {
  return {
    method: "POST" as const,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args: {} }),
    signal,
    dispatcher,
  };
}

describe("qgrid HTTP transport", () => {
  // Node 26 bundles undici 8, whose built-in fetch rejected the undici 6 dispatcher this path
  // used to pass with "invalid onError method".
  it("sends a request through a request-scoped dispatcher on this Node runtime", async () => {
    const serverUrl = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ method: req.method }));
    });

    const response = await qgridFetch(serverUrl, post(agent(anthropicTransportOptions())), {
      operation: "query",
      serverUrl,
    });

    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual({ method: "POST" });
  });

  it("enforces the dispatcher's response headers timeout", async () => {
    const serverUrl = await serve(() => {
      // Never respond.
    });

    await expect(
      qgridFetch(serverUrl, post(agent({ headersTimeout: 100, bodyTimeout: 100 })), {
        operation: "query",
        serverUrl,
        transportTimeoutMs: 100,
      }),
    ).rejects.toThrow(
      "qgrid query transport failed: response headers timed out after 100ms (UND_ERR_HEADERS_TIMEOUT)",
    );
  });

  it("rejects with the caller's AbortError when a dispatched request is cancelled", async () => {
    const serverUrl = await serve(() => {
      // Never respond.
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    await expect(
      qgridFetch(serverUrl, post(agent(anthropicTransportOptions()), controller.signal), {
        operation: "query",
        serverUrl,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses a qgrid server URL that is not http or https", async () => {
    await expect(
      qgridFetch("file:///etc/passwd", post(agent(anthropicTransportOptions())), {
        operation: "query",
        serverUrl: "file:///etc/passwd",
      }),
    ).rejects.toThrow("qgrid query transport failed: qgrid server URL must use http or https, not file:");
  });

  it("keeps the default Anthropic transport budget above the server timeout", () => {
    expect(anthropicTransportOptions()).toEqual({
      headersTimeout: 300_000,
      bodyTimeout: 300_000,
    });
  });

  it("derives both Undici timeouts from timeoutMs with response grace", () => {
    expect(anthropicTransportOptions(600_000)).toEqual({
      headersTimeout: 660_000,
      bodyTimeout: 660_000,
    });
  });

  it("finds connection errors nested inside an AggregateError", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:44900"), {
      code: "ECONNREFUSED",
    });
    const error = new TypeError("fetch failed", {
      cause: new AggregateError([refused]),
    });

    expect(
      toQgridTransportError(error, {
        operation: "query",
        serverUrl: "http://localhost:44900",
      }).message,
    ).toBe(
      "qgrid query transport failed: connection refused by http://localhost:44900 (ECONNREFUSED)",
    );
  });

  it("identifies response body timeouts", () => {
    const cause = Object.assign(new Error("Body Timeout Error"), {
      code: "UND_ERR_BODY_TIMEOUT",
    });

    expect(
      toQgridTransportError(new TypeError("fetch failed", { cause }), {
        operation: "query",
        serverUrl: "http://localhost:44900",
        transportTimeoutMs: 660_000,
      }).message,
    ).toBe(
      "qgrid query transport failed: response body timed out after 660000ms (UND_ERR_BODY_TIMEOUT)",
    );
  });

  it("preserves AbortError so AI SDK cancellation semantics remain intact", () => {
    const error = new DOMException("This operation was aborted", "AbortError");

    expect(
      toQgridTransportError(error, {
        operation: "query",
        serverUrl: "http://localhost:44900",
      }),
    ).toBe(error);
  });
});
