import {
  classifyGrokHttpError,
  encodeGrokRequestBody,
  normalizeGrokSSE,
  readGrokResponseHeaders,
  type GrokHttpErrorClassification,
  type GrokNormalizedEvent,
  type GrokResponseHeaderInfo,
  type GrokResponsesRequest,
} from "./grok-backend-protocol";
import { GROK_CHAT_PROXY_URL } from "./grok-constants";

// HTTPS/SSE transport for the chat proxy. Headers are built by the caller (grok-headers.ts) so the
// fingerprint stays in one place; this module only moves bytes, classifies HTTP failures, and
// enforces abort and idle limits.

export const GROK_DEFAULT_IDLE_TIMEOUT_MS = 300_000;
export const GROK_PROXY_GET_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_LENGTH = 2_000;

/**
 * A non-2xx response or a transport failure before any response arrived (`status = 0`).
 * Media/voice ports should throw this class too, so the dispatcher can apply §5.4 handling.
 */
export class GrokHttpError extends Error {
  readonly classification: GrokHttpErrorClassification;
  readonly bodyText: string;
  readonly responseHeaders: GrokResponseHeaderInfo;

  constructor(
    classification: GrokHttpErrorClassification,
    bodyText: string,
    responseHeaders: GrokResponseHeaderInfo = {},
    options?: ErrorOptions,
  ) {
    const detail = classification.message ? `: ${classification.message}` : "";
    super(
      classification.status === 0
        ? `Grok request failed before a response${detail}`
        : `Grok HTTP ${classification.status} (${classification.kind})${detail}`,
      options,
    );
    this.name = "GrokHttpError";
    this.classification = classification;
    this.bodyText = bodyText.slice(0, MAX_ERROR_BODY_LENGTH);
    this.responseHeaders = responseHeaders;
  }

  get status(): number {
    return this.classification.status;
  }
}

/** The stream produced no bytes for `idleTimeoutMs`. Upstream may already be executing. */
export class GrokIdleTimeoutError extends Error {
  readonly idleTimeoutMs: number;

  constructor(idleTimeoutMs: number) {
    super(`Grok stream idle for ${idleTimeoutMs} ms`);
    this.name = "GrokIdleTimeoutError";
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;

  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

function connectError(error: unknown): GrokHttpError {
  const message = error instanceof Error ? error.message : String(error);

  return new GrokHttpError(
    { ...classifyGrokHttpError(0, "", {}), message },
    "",
    {},
    {
      cause: error,
    },
  );
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY_LENGTH);
  } catch {
    return "";
  }
}

export async function grokHttpErrorFromResponse(response: Response): Promise<GrokHttpError> {
  const bodyText = await readErrorBody(response);

  return new GrokHttpError(
    classifyGrokHttpError(response.status, bodyText, response.headers),
    bodyText,
    readGrokResponseHeaders(response.headers),
  );
}

/**
 * Yields from `source` but fails with GrokIdleTimeoutError when no item arrives within
 * `idleTimeoutMs`, and with the abort reason when `signal` aborts. `onStop` runs exactly once
 * when iteration ends for any reason, so the caller can cancel the underlying request.
 */
async function* guardStream<T>(
  source: AsyncIterable<T>,
  idleTimeoutMs: number,
  signal: AbortSignal | undefined,
  onStop: (reason: Error | undefined) => void,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let settledNormally = false;
  let pendingNext = false;
  let stopped = false;

  const stop = (reason: Error | undefined) => {
    if (stopped) return;
    stopped = true;
    onStop(reason);
  };

  try {
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      let timer: NodeJS.Timeout | undefined;
      let removeAbort: (() => void) | undefined;

      const interrupt = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GrokIdleTimeoutError(idleTimeoutMs)), idleTimeoutMs);

        if (signal) {
          const onAbort = () => reject(abortReason(signal));
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
        }
      });

      pendingNext = true;

      const next = iterator.next().finally(() => {
        pendingNext = false;
      });

      let result: IteratorResult<T>;

      try {
        result = await Promise.race([next, interrupt]);
      } finally {
        clearTimeout(timer);
        removeAbort?.();
      }

      if (result.done) {
        settledNormally = true;

        return;
      }

      yield result.value;
    }
  } catch (error) {
    stop(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    if (settledNormally) stop(undefined);
    else stop(new DOMException("Grok stream consumer stopped", "AbortError"));

    // A pending next() would block return(); the cancelled request settles it instead.
    if (!pendingNext) await iterator.return?.(undefined).catch(() => undefined);
  }
}

export interface GrokChatStreamRequest {
  body: GrokResponsesRequest;
  /** Complete header map from buildGrokChatHeaders (bearer included). */
  headers: Record<string, string>;
  signal?: AbortSignal;
  idleTimeoutMs?: number;
  /** Defaults to zstd, as the pinned grok-build sends. */
  encoding?: "zstd" | "plain";
}

export interface GrokChatStream {
  status: number;
  headers: GrokResponseHeaderInfo;
  events: AsyncGenerator<GrokNormalizedEvent>;
}

export interface GrokChatClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
}

export class GrokChatClient {
  readonly fetchImpl: typeof fetch;
  readonly baseUrl: string;

  constructor(options: GrokChatClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? GROK_CHAT_PROXY_URL;
  }

  /**
   * POST {proxy}/responses. Resolves once response headers arrive; rejects with GrokHttpError on
   * a non-2xx status or a transport failure, or with the abort reason when `signal` aborts.
   * The stream ends at the first terminal event; `[DONE]` is not required.
   */
  async stream(request: GrokChatStreamRequest): Promise<GrokChatStream> {
    request.signal?.throwIfAborted();

    const encoded =
      request.encoding === "plain"
        ? {
            bytes: new TextEncoder().encode(JSON.stringify(request.body)),
            contentEncoding: undefined,
          }
        : await encodeGrokRequestBody(request.body);

    const headers = { ...request.headers };

    if (encoded.contentEncoding) headers["content-encoding"] = encoded.contentEncoding;
    else delete headers["content-encoding"];

    const controller = new AbortController();

    const signal = request.signal
      ? AbortSignal.any([request.signal, controller.signal])
      : controller.signal;

    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}/responses`, {
        method: "POST",
        headers,
        body: new Uint8Array(encoded.bytes),
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw abortReason(request.signal);
      throw connectError(error);
    }

    if (!response.ok) throw await grokHttpErrorFromResponse(response);

    if (!response.body) {
      throw new GrokHttpError(
        { ...classifyGrokHttpError(502, "", response.headers), message: "empty body" },
        "",
        readGrokResponseHeaders(response.headers),
      );
    }

    const events = guardStream(
      normalizeGrokSSE(response.body),
      request.idleTimeoutMs ?? GROK_DEFAULT_IDLE_TIMEOUT_MS,
      request.signal,
      (reason) => {
        if (reason) controller.abort(reason);
      },
    );

    return {
      status: response.status,
      headers: readGrokResponseHeaders(response.headers),
      events,
    };
  }
}

export interface GrokProxyGetResult {
  status: number;
  headers: GrokResponseHeaderInfo;
  json: unknown;
}

/** GET {proxy}{path} returning parsed JSON; rejects with GrokHttpError on failure. */
export async function grokProxyGet(
  path: string,
  options: {
    headers: Record<string, string>;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    baseUrl?: string;
    timeoutMs?: number;
  },
): Promise<GrokProxyGetResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? GROK_PROXY_GET_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;

  try {
    response = await (options.fetch ?? fetch)(`${options.baseUrl ?? GROK_CHAT_PROXY_URL}${path}`, {
      method: "GET",
      headers: options.headers,
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw abortReason(options.signal);
    throw connectError(error);
  }

  if (!response.ok) throw await grokHttpErrorFromResponse(response);
  let json: unknown;

  try {
    json = await response.json();
  } catch (error) {
    throw new GrokHttpError(
      { ...classifyGrokHttpError(502, "", response.headers), message: "invalid JSON body" },
      "",
      readGrokResponseHeaders(response.headers),
      { cause: error },
    );
  }

  return { status: response.status, headers: readGrokResponseHeaders(response.headers), json };
}
