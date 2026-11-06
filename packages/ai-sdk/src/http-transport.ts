import {
  Agent,
  type Dispatcher,
  type Response as UndiciResponse,
  fetch as undiciFetch,
} from "undici";
import { z } from "zod";

import { type QgridSupportedModel } from "./index.types";

const DEFAULT_ANTHROPIC_TIMEOUT_MS = 240_000;
const TRANSPORT_RESPONSE_GRACE_MS = 60_000;

type TransportOperation = "query";

// Error-chain fields read from a thrown value. Node, undici, and AggregateError attach them as own
// properties; any non-null object is a link, and each field is decoded where it is used.
const errorChainLinkSchema = z.looseObject({
  cause: z.unknown().optional(),
  code: z.unknown().optional(),
  errors: z.unknown().optional(),
  message: z.unknown().optional(),
});

const nestedErrorsSchema = z.array(z.unknown());

// The JSON POST that qgridFetch sends. A dispatched request goes through undici's fetch, so it
// keeps to fields both fetch implementations accept unchanged.
export type QgridRequestInit = {
  method: "POST";
  body: string;
  signal?: AbortSignal;
} & (
  | { headers: Headers | Record<string, string>; dispatcher?: undefined }
  | { headers: Record<string, string>; dispatcher: Dispatcher }
);

export type QgridResponse = Response | UndiciResponse;

export type QgridRequestTransport = {
  dispatcher: Dispatcher;
  timeoutMs: number;
};

export type QgridTransportErrorContext = {
  operation: TransportOperation;
  serverUrl: string;
  transportTimeoutMs?: number;
};

export interface AnthropicTransportOptions {
  headersTimeout: number;
  bodyTimeout: number;
}

export function anthropicTransportOptions(timeoutMs?: number): AnthropicTransportOptions {
  const providerTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs !== undefined && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_ANTHROPIC_TIMEOUT_MS;

  const transportTimeoutMs = providerTimeoutMs + TRANSPORT_RESPONSE_GRACE_MS;

  return {
    headersTimeout: transportTimeoutMs,
    bodyTimeout: transportTimeoutMs,
  };
}

export function createQgridRequestTransport(
  modelId: QgridSupportedModel,
  timeoutMs?: number,
): QgridRequestTransport | undefined {
  if (!modelId.startsWith("anthropic/")) return undefined;

  const options = anthropicTransportOptions(timeoutMs);

  return {
    dispatcher: new Agent(options),
    timeoutMs: options.headersTimeout,
  };
}

export async function closeQgridRequestTransport(
  transport: QgridRequestTransport | undefined,
): Promise<void> {
  if (!transport) return;
  await transport.dispatcher.close().catch(() => undefined);
}

export async function qgridFetch(
  target: string | URL,
  init: QgridRequestInit,
  context: QgridTransportErrorContext,
): Promise<QgridResponse> {
  try {
    // qgrid query requests go only to the configured qgrid server, over HTTP or HTTPS.
    const url = new URL(target);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new TypeError(`qgrid server URL must use http or https, not ${url.protocol}`);
    }

    const href = url.href;

    // A dispatcher must run under the fetch from its own undici package. The built-in fetch
    // uses the undici bundled with Node, and Node 26 (undici 8) rejects undici 6 and 7
    // dispatchers with UND_ERR_INVALID_ARG ("invalid onError method"), while undici 8
    // dispatchers fail the same way under Node 22 and 24.
    if (init.dispatcher) return await undiciFetch(href, init);

    const { method, body, signal, headers } = init;

    return await fetch(href, { method, body, signal, headers });
  } catch (error) {
    throw toQgridTransportError(error, context);
  }
}

export function toQgridTransportError(cause: unknown, context: QgridTransportErrorContext): Error {
  if (isAbortError(cause)) return cause;

  const code = findErrorCode(cause);
  const prefix = `qgrid ${context.operation} transport failed`;

  if (code === "UND_ERR_HEADERS_TIMEOUT") {
    const budget = context.transportTimeoutMs ? ` after ${context.transportTimeoutMs}ms` : "";

    return new Error(`${prefix}: response headers timed out${budget} (${code})`, {
      cause,
    });
  }

  if (code === "UND_ERR_BODY_TIMEOUT") {
    const budget = context.transportTimeoutMs ? ` after ${context.transportTimeoutMs}ms` : "";

    return new Error(`${prefix}: response body timed out${budget} (${code})`, {
      cause,
    });
  }

  if (code === "ECONNREFUSED") {
    return new Error(
      `${prefix}: connection refused by ${serverOrigin(context.serverUrl)} (${code})`,
      { cause },
    );
  }

  const detail = findDeepestMessage(cause) ?? "unknown network error";

  return new Error(`${prefix}: ${detail}${code ? ` (${code})` : ""}`, {
    cause,
  });
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function findErrorCode(cause: unknown, seen = new Set<unknown>()): string | undefined {
  const link = errorChainLinkSchema.safeParse(cause);

  if (!link.success || seen.has(cause)) return undefined;
  seen.add(cause);
  const code = z.string().safeParse(link.data.code);

  if (code.success) return code.data;

  const causeCode = findErrorCode(link.data.cause, seen);

  if (causeCode) return causeCode;
  const nested = nestedErrorsSchema.safeParse(link.data.errors);

  if (nested.success) {
    for (const nestedError of nested.data) {
      const nestedCode = findErrorCode(nestedError, seen);

      if (nestedCode) return nestedCode;
    }
  }

  return undefined;
}

function findDeepestMessage(cause: unknown, seen = new Set<unknown>()): string | undefined {
  const link = errorChainLinkSchema.safeParse(cause);

  if (!link.success || seen.has(cause)) return undefined;
  seen.add(cause);

  const causeMessage = findDeepestMessage(link.data.cause, seen);

  if (causeMessage) return causeMessage;
  const nested = nestedErrorsSchema.safeParse(link.data.errors);

  if (nested.success) {
    for (const nestedError of nested.data) {
      const nestedMessage = findDeepestMessage(nestedError, seen);

      if (nestedMessage) return nestedMessage;
    }
  }

  return z.string().min(1).safeParse(link.data.message).data;
}

function serverOrigin(serverUrl: string): string {
  try {
    return new URL(serverUrl).origin;
  } catch {
    return serverUrl;
  }
}
