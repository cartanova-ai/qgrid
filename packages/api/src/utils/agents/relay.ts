import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { zstdDecompressSync } from "node:zlib";

import { type HarnessV1RequestTransformation } from "@ai-sdk/harness";
import { getLogger } from "@logtape/logtape";

import {
  isJsonObject,
  jsonString,
  type JsonObject,
  type JsonValue,
} from "../providers/common/provider-types";
import { type OpenAIDispatcher } from "../providers/openai/openai-dispatcher";
import { parseOpenAISSE } from "../providers/openai/openai-sse";

const logger = getLogger(["qgrid", "agents", "relay"]);
const UPSTREAM = "https://chatgpt.com";
const MAX_BODY = 8 * 1024 * 1024;
const MAX_DECODED_BODY = 32 * 1024 * 1024;
const RECEIVE_TIMEOUT = 30_000;

const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

export type RelaySession = {
  sessionId: string;
  tokenId: number;
  model: string;
  status: string;
  activeTurn?: { turnId: string; modelCallCount: number; startedAt: number };
  containerIp: string;
};

export type RelayCallStart = {
  sessionId: string;
  turnId: string;
  callId: string;
  model: string;
  reqBytes: number;
  t0: number;
};

export type RelayCallEnd = {
  callId: string;
  status: number;
  responseId?: string;
  model?: string;
  usage: JsonObject | null;
  error?: string;
  attempts: number;
  ms: number;
};

export type RelaySessionStore = {
  resolveSession(sessionKey: string): RelaySession | undefined | Promise<RelaySession | undefined>;
  onCallStart(record: RelayCallStart): void | Promise<void>;
  onCallEnd(record: RelayCallEnd): void | Promise<void>;
  onLimitExceeded?(sessionId: string, which: "model_calls" | "time"): void;
};

export type AgentsRelayOptions = {
  sessions: RelaySessionStore;
  dispatcher: Pick<OpenAIDispatcher, "tokenMetadata" | "refreshCredentials" | "isQuotaEligible">;
  bindAddresses?: readonly string[];
  port?: number;
  limits: { maxModelCalls: number; maxTurnMs: number };
  isLinux?: boolean;
  fetch?: typeof globalThis.fetch;
};

class RelayError extends Error {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(code);
  }
}

type Matcher = NonNullable<HarnessV1RequestTransformation["match"]["path"]>;

function matches(matcher: Matcher | undefined, value: string): boolean {
  if (!matcher) return true;

  if ("exact" in matcher) return value === matcher.exact;

  if ("startsWith" in matcher) return value.startsWith(matcher.startsWith);

  return new RegExp(matcher.regex).test(value);
}

function stripHopHeaders(headers: Headers) {
  const connectionHeaders = headers.get("connection")?.split(",") ?? [];

  for (const name of [...connectionHeaders, ...HOP_HEADERS]) headers.delete(name.trim());
}

function requestHeaders(req: IncomingMessage) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  return headers;
}

function reply(res: ServerResponse, status: number, error: string) {
  if (res.destroyed) return;

  if (res.headersSent) {
    res.destroy();

    return;
  }

  // Refused bodies must not be buffered for reuse on a keep-alive connection.
  res.shouldKeepAlive = false;
  res.writeHead(status, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error }));
}

function readBody(
  req: IncomingMessage,
  signal: AbortSignal,
  t0: number,
): Promise<Buffer<ArrayBuffer>> {
  signal.throwIfAborted();

  if (Number(req.headers["content-length"]) > MAX_BODY) throw new RelayError(413, "body_too_large");

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const cleanup = () => {
      clearTimeout(timer);
      req.off("data", data);
      req.off("end", end);
      req.off("error", error);
      signal.removeEventListener("abort", abort);
      req.pause();
    };

    const fail = (reason: Error) => {
      cleanup();
      reject(reason);
    };

    const data = (chunk: Buffer) => {
      size += chunk.length;

      if (size > MAX_BODY) fail(new RelayError(413, "body_too_large"));
      else chunks.push(chunk);
    };

    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const error = () => fail(new RelayError(400, "body_disconnected"));
    const abort = () => fail(new RelayError(403, "aborted"));

    const timer = setTimeout(
      () => fail(new RelayError(408, "body_timeout")),
      Math.max(0, RECEIVE_TIMEOUT - (Date.now() - t0)),
    );

    req.on("data", data);
    req.once("end", end);
    req.once("error", error);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function bodyModel(body: Buffer, encoding: string | undefined): string | undefined {
  let decoded = body;

  if (encoding && encoding !== "identity") {
    if (encoding !== "zstd") throw new RelayError(415, "unsupported_encoding");

    try {
      decoded = zstdDecompressSync(body, { maxOutputLength: MAX_DECODED_BODY });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE") {
        throw new RelayError(413, "body_too_large");
      }

      throw new RelayError(400, "invalid_body");
    }
  }

  try {
    const parsed: JsonValue = JSON.parse(decoded.toString("utf8"));

    return isJsonObject(parsed) ? jsonString(parsed.model) : undefined;
  } catch {
    throw new RelayError(400, "invalid_body");
  }
}

/** The runner owns lifecycle and persistence; this server brokers model calls. */
export class AgentsRelay {
  private readonly servers: Server[] = [];
  private readonly rules = new Map<string, readonly HarnessV1RequestTransformation[]>();
  private readonly turns = new Map<string, Set<AbortController>>();
  private readonly counts = new Map<string, { turnId: string; started: number; pending: number }>();
  private readonly fetch: typeof globalThis.fetch;

  constructor(private readonly options: AgentsRelayOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;

    for (const address of new Set(options.bindAddresses ?? ["127.0.0.1", "172.30.0.1"])) {
      if (!address) throw new Error("Relay bind address must not be empty");

      const server = http.createServer(
        { headersTimeout: RECEIVE_TIMEOUT, requestTimeout: RECEIVE_TIMEOUT },
        (req, res) => {
          void this.handle(req, res);
        },
      );

      server.on("upgrade", (_req, socket) => {
        logger.warn("WebSocket upgrade rejected: agents relay requires SSE");
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });
      this.servers.push(server);
    }
  }

  async listen(): Promise<void> {
    const addresses = [...new Set(this.options.bindAddresses ?? ["127.0.0.1", "172.30.0.1"])];

    try {
      for (const [index, server] of this.servers.entries()) {
        const listening = once(server, "listening");
        server.listen(this.options.port ?? 44901, addresses[index]);
        await listening;
      }
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    for (const turnId of this.turns.keys()) this.abortTurn(turnId);
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            if (!server.listening) {
              resolve();

              return;
            }

            server.close((error) => (error ? reject(error) : resolve()));
            server.closeAllConnections();
          }),
      ),
    );
  }

  addRules(sessionId: string, rules: readonly HarnessV1RequestTransformation[]) {
    this.rules.set(sessionId, [...(this.rules.get(sessionId) ?? []), ...rules]);
  }

  removeRules(sessionId: string) {
    this.rules.delete(sessionId);
    this.counts.delete(sessionId);
  }

  abortTurn(turnId: string) {
    for (const controller of this.turns.get(turnId) ?? []) controller.abort();
  }

  private transform(req: IncomingMessage, url: URL) {
    const headers = requestHeaders(req);
    const auth = headers.get("authorization") ?? "";

    // Pi wraps the SDK placeholder in the signature of a synthetic JWT.
    if (/^Bearer\s+/i.test(auth)) {
      for (const rules of this.rules.values()) {
        for (const rule of rules) {
          for (const header of rule.match.headers ?? []) {
            if (
              header.key &&
              "exact" in header.key &&
              header.key.exact.toLowerCase() === "authorization" &&
              header.value &&
              "exact" in header.value
            ) {
              const placeholder = header.value.exact.replace(/^Bearer\s+/i, "");

              if (placeholder.startsWith("aisdkhc_") && auth.includes(placeholder))
                headers.set("authorization", `Bearer ${placeholder}`);
            }
          }
        }
      }
    }

    let owner: string | undefined;
    const host = new URL(`http://${req.headers.host ?? "localhost"}`).hostname;

    for (const [sessionId, rules] of this.rules) {
      for (const rule of rules) {
        const match = rule.match;

        if (match.host !== host || !matches(match.path, url.pathname)) continue;

        if (match.method && !match.method.includes(req.method ?? "GET")) continue;

        if (
          !(match.queryString ?? []).every((part) =>
            [...url.searchParams].some(
              ([key, value]) => matches(part.key, key) && matches(part.value, value),
            ),
          )
        )
          continue;

        if (
          !(match.headers ?? []).every((part) =>
            [...headers].some(([key, value]) => {
              const keyMatcher =
                part.key && "exact" in part.key
                  ? { exact: part.key.exact.toLowerCase() }
                  : part.key;

              return matches(keyMatcher, key) && matches(part.value, value);
            }),
          )
        )
          continue;

        for (const [key, value] of Object.entries(rule.transform.headers)) headers.set(key, value);
        owner = sessionId;
      }
    }

    return { headers, owner };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = Date.now();
    const controller = new AbortController();
    const { signal } = controller;

    const disconnect = () => {
      if (!res.writableFinished) controller.abort();
    };

    res.once("close", disconnect);
    req.once("aborted", disconnect);
    let turnId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let count: { turnId: string; started: number; pending: number } | undefined;
    let reserved = false;
    let record: RelayCallEnd | undefined;
    let timedOut = false;

    try {
      const url = new URL(req.url ?? "/", UPSTREAM);

      if (!url.pathname.startsWith("/backend-api/codex/")) throw new RelayError(404, "not_found");
      // An absolute request target must never choose the destination host.
      const target = new URL(UPSTREAM);
      target.pathname = url.pathname;
      target.search = url.search;
      const { headers, owner } = this.transform(req, url);
      const auth = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "");
      const sessionKey = auth?.[1];

      const session = sessionKey
        ? await this.options.sessions.resolveSession(sessionKey)
        : undefined;

      if (!sessionKey || !session || (owner !== undefined && owner !== session.sessionId))
        throw new RelayError(401, "unknown_session");

      if (
        (this.options.isLinux ?? process.platform === "linux") &&
        req.socket.remoteAddress?.replace(/^::ffff:/, "") !== session.containerIp
      )
        throw new RelayError(403, "ip_mismatch");

      if (session.status !== "running") throw new RelayError(403, "invalid_state");
      const turn = session.activeTurn;

      if (!turn) throw new RelayError(403, "inactive_turn");
      turnId = turn.turnId;
      count = this.counts.get(session.sessionId);

      if (!count || count.turnId !== turnId) {
        count = { turnId, started: turn.modelCallCount, pending: 0 };
        this.counts.set(session.sessionId, count);
      }

      count.started = Math.max(count.started, turn.modelCallCount);
      const remaining = turn.startedAt + this.options.limits.maxTurnMs - Date.now();

      if (count.started + count.pending >= this.options.limits.maxModelCalls || remaining <= 0) {
        this.options.sessions.onLimitExceeded?.(
          session.sessionId,
          remaining <= 0 ? "time" : "model_calls",
        );
        throw new RelayError(429, "limit_exceeded");
      }

      count.pending++;
      reserved = true;
      const controllers = this.turns.get(turnId) ?? new Set<AbortController>();
      controllers.add(controller);
      this.turns.set(turnId, controllers);
      timer = setTimeout(() => {
        timedOut = true;
        this.options.sessions.onLimitExceeded?.(session.sessionId, "time");
        controller.abort();
      }, remaining);
      signal.throwIfAborted();
      const dispatcher = this.options.dispatcher;
      const metadata = dispatcher.tokenMetadata.get(session.tokenId);

      if (!metadata?.active) throw new RelayError(503, "token_unavailable");

      if (!(await dispatcher.isQuotaEligible(session.tokenId, metadata, signal)))
        throw new RelayError(503, "quota_exceeded");
      signal.throwIfAborted();
      const body = await readBody(req, signal, t0);

      if (
        bodyModel(body, headers.get("content-encoding") ?? undefined) !==
        session.model.replace(/^openai\//, "")
      )
        throw new RelayError(403, "model_mismatch");
      // Both quota lookup and body reception can outlive the active turn or token.
      const current = await this.options.sessions.resolveSession(sessionKey);
      signal.throwIfAborted();

      if (current?.status !== "running" || current.activeTurn?.turnId !== turnId)
        throw new RelayError(403, "inactive_turn");
      const token = dispatcher.tokenMetadata.get(session.tokenId);

      if (!token?.active) throw new RelayError(503, "token_unavailable");
      count.pending--;
      reserved = false;
      count.started++;
      record = { callId: randomUUID(), status: 502, usage: null, attempts: 1, ms: 0 };
      await this.options.sessions.onCallStart({
        sessionId: session.sessionId,
        turnId,
        callId: record.callId,
        model: session.model,
        reqBytes: body.length,
        t0,
      });
      stripHopHeaders(headers);
      headers.delete("host");
      headers.delete("content-length");
      let credentials = token.credentials;

      const secrets = new Set([
        credentials.accessToken,
        credentials.refreshToken,
        credentials.accountId,
        sessionKey,
        req.headers.authorization ?? "",
      ]);

      headers.set("authorization", `Bearer ${credentials.accessToken}`);
      headers.delete("chatgpt-account-id");

      if (credentials.accountId) headers.set("chatgpt-account-id", credentials.accountId);

      const send = () => {
        signal.throwIfAborted();

        return this.fetch(target, {
          method: req.method,
          headers,
          body,
          redirect: "manual",
          signal,
        });
      };

      let upstream = await send();

      if (upstream.status === 401) {
        await upstream.body?.cancel();

        try {
          credentials = {
            ...credentials,
            ...(await dispatcher.refreshCredentials(session.tokenId)),
          };
        } catch {
          throw new RelayError(503, "token_unavailable");
        }

        signal.throwIfAborted();
        secrets.add(credentials.accessToken);
        secrets.add(credentials.accountId);
        headers.set("authorization", `Bearer ${credentials.accessToken}`);
        headers.delete("chatgpt-account-id");

        if (credentials.accountId) headers.set("chatgpt-account-id", credentials.accountId);
        record.attempts = 2;
        record.error = "401 → refreshed";
        upstream = await send();
      }

      if (upstream.status >= 300 && upstream.status < 400) {
        await upstream.body?.cancel();
        throw new RelayError(502, "upstream_redirect");
      }

      record.status = upstream.status;

      // Retain enough lookahead to redact a token crossing the excerpt boundary.
      const errorLimit = 300 + Math.max(...[...secrets].map((secret) => secret.length));
      const responseHeaders = new Headers(upstream.headers);
      stripHopHeaders(responseHeaders);
      // fetch has already decoded the response body.
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      res.writeHead(upstream.status, Object.fromEntries(responseHeaders));
      let errorBody = "";
      const decoder = new TextDecoder();

      const forward = new TransformStream<Uint8Array, Uint8Array>({
        transform: async (chunk, stream) => {
          signal.throwIfAborted();

          if (!res.write(chunk)) await once(res, "drain", { signal });

          if (upstream.status >= 400)
            errorBody = (errorBody + decoder.decode(chunk, { stream: true })).slice(0, errorLimit);
          stream.enqueue(chunk);
        },
      });

      let completed = false;

      if (upstream.body) {
        const bodyStream = upstream.body.pipeThrough(forward, { signal });

        if (upstream.status < 400) {
          for await (const event of parseOpenAISSE(bodyStream)) {
            if (!isJsonObject(event) || !isJsonObject(event.response)) continue;

            if (event.type === "response.created")
              record.responseId = jsonString(event.response.id);

            if (event.type === "response.completed") {
              completed = true;
              record.usage = isJsonObject(event.response.usage) ? event.response.usage : null;
              record.model = jsonString(event.response.model);
            }
          }
        } else {
          await bodyStream.pipeTo(new WritableStream());
        }
      }

      signal.throwIfAborted();

      if (upstream.status >= 400) {
        // Never persist a credential echoed in an upstream error response.
        for (const secret of secrets) {
          if (secret) errorBody = errorBody.replaceAll(secret, "[redacted]");
        }

        record.error = `${record.attempts === 2 ? "401 → refreshed; " : ""}upstream_${upstream.status}: ${errorBody.slice(0, 300)}`;
      } else if (!completed) {
        throw new RelayError(502, "upstream_disconnected");
      }

      const sent = once(res, "finish", { signal });
      res.end();
      await sent;
    } catch (error) {
      const status = timedOut
        ? 429
        : signal.aborted
          ? 499
          : error instanceof RelayError
            ? error.status
            : 502;

      const code = timedOut
        ? "limit_exceeded"
        : signal.aborted
          ? "aborted"
          : error instanceof RelayError
            ? error.message
            : "upstream_disconnected";

      if (record) {
        record.status = status;
        record.error = `${record.attempts === 2 ? "401 → refreshed; " : ""}${code}`;
      }

      reply(res, status, code);
    } finally {
      clearTimeout(timer);
      controller.abort();
      res.off("close", disconnect);
      req.off("aborted", disconnect);

      if (reserved && count) count.pending--;

      if (turnId) {
        const controllers = this.turns.get(turnId);
        controllers?.delete(controller);

        if (!controllers?.size) this.turns.delete(turnId);
      }

      if (record) {
        record.ms = Date.now() - t0;

        try {
          await this.options.sessions.onCallEnd(record);
        } catch {
          logger.error("Failed to persist agents relay call result", { callId: record.callId });
        }
      }
    }
  }
}
