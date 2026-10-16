import { randomBytes } from "node:crypto";

import {
  GROK_BUILD_VERSION,
  GROK_CLIENT_IDENTIFIER,
  GROK_CLIENT_MODE,
  GROK_COMPACTION_AT,
  GROK_COMPACTIONS_REMAINING_DEFAULT,
  GROK_DOOM_LOOP_CHECK,
  GROK_EXACT_REPETITION_CHECK,
} from "./grok-constants";

// Builders return plain lowercase-key records whose insertion order is the wire order the
// pinned grok-build emits. `host`, `content-length` and `accept-encoding` are left to the
// transport. The three header families (chat proxy, proxy GET, api.x.ai) are never merged.

export interface GrokPlatform {
  os: "macos" | "windows" | "linux";
  arch: "aarch64" | "x86_64";
}

/** Maps Node platform/arch to the Rust `std::env::consts` names grok-build reports. */
export function grokPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): GrokPlatform {
  // grok-build ships only these targets; anything else is reported as the nearest shipped one
  // so the User-Agent never carries a value the real binary cannot emit.
  const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : "linux";

  return { os, arch: arch === "arm64" ? "aarch64" : "x86_64" };
}

/** `grok-shell/<ver> (<os>; <arch>)` (grok-build 1.0.45 xai-grok-sampler/src/client.rs:457-463). */
export function grokShellUserAgent(platform: GrokPlatform = grokPlatform()): string {
  return `grok-shell/${GROK_BUILD_VERSION} (${platform.os}; ${platform.arch})`;
}

/** `xai-grok-build/<ver>` (grok-build 1.0.45 media_tool_config.rs:104). */
export function grokMediaUserAgent(): string {
  return `xai-grok-build/${GROK_BUILD_VERSION}`;
}

const TRACEPARENT_PATTERN = /^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-01$/;

/** W3C trace context `00-<trace-id>-<parent-id>-01` with non-zero random ids. */
export function generateTraceparent(): string {
  for (;;) {
    const traceparent = `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`;

    if (TRACEPARENT_PATTERN.test(traceparent)) return traceparent;
  }
}

function bearerValue(bearer: string): string {
  if (!bearer || /\s/.test(bearer)) throw new TypeError("Grok bearer token must be non-empty");

  return `Bearer ${bearer}`;
}

function nonNegativeInteger(name: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${name} must be a non-negative integer`);

  return String(value);
}

function requiredValue(name: string, value: string): string {
  if (!value || /[\r\n]/.test(value))
    throw new TypeError(`${name} must be a non-empty header value`);

  return value;
}

export interface GrokChatHeaderOptions {
  bearer: string;
  model: string;
  convId: string;
  reqId: string;
  sessionId: string;
  agentId: string;
  userId: string;
  convGroupId: string;
  turnIdx: number;
  traceparent?: string;
  transientRetry?: number;
  compactionsRemaining?: number;
  zstd: boolean;
  platform?: GrokPlatform;
}

/** Headers for `POST {proxy}/responses`, in the order of the 1.0.60 golden capture. */
export function buildGrokChatHeaders(options: GrokChatHeaderOptions): Record<string, string> {
  const traceparent = options.traceparent ?? generateTraceparent();

  if (!TRACEPARENT_PATTERN.test(traceparent))
    throw new TypeError("traceparent must be a W3C 00-<32hex>-<16hex>-01 value");

  // A Map keeps insertion order, which is the wire order of the golden capture.
  const headers = new Map(
    Object.entries({
      "content-type": "application/json",
      "user-agent": grokShellUserAgent(options.platform),
      "x-grok-client-mode": GROK_CLIENT_MODE,
      "x-xai-token-auth": "xai-grok-cli",
      "x-authenticateresponse": "authenticate-response",
      "x-compactions-remaining": nonNegativeInteger(
        "compactionsRemaining",
        options.compactionsRemaining ?? GROK_COMPACTIONS_REMAINING_DEFAULT,
      ),
      "x-compaction-at": String(GROK_COMPACTION_AT),
      "x-grok-client-version": GROK_BUILD_VERSION,
      "x-grok-user-id": requiredValue("userId", options.userId),
      "x-grok-conv-group-id": requiredValue("convGroupId", options.convGroupId),
      "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
      authorization: bearerValue(options.bearer),
      traceparent,
      "x-grok-conv-id": requiredValue("convId", options.convId),
      "x-grok-req-id": requiredValue("reqId", options.reqId),
      "x-grok-model-override": requiredValue("model", options.model),
      "x-grok-session-id": requiredValue("sessionId", options.sessionId),
      "x-grok-agent-id": requiredValue("agentId", options.agentId),
      "x-grok-turn-idx": nonNegativeInteger("turnIdx", options.turnIdx),
    }),
  );

  // Not present in the capture; grok-build 1.0.45 client.rs:560-605 sends it with the turn
  // index group on retries only.
  if (options.transientRetry !== undefined)
    headers.set(
      "x-grok-transient-retry",
      nonNegativeInteger("transientRetry", options.transientRetry),
    );
  headers.set("accept", "text/event-stream");
  headers.set("x-grok-doom-loop-check", String(GROK_DOOM_LOOP_CHECK));
  headers.set("x-grok-exact-repetition-check", String(GROK_EXACT_REPETITION_CHECK));

  if (options.zstd) headers.set("content-encoding", "zstd");

  return Object.fromEntries(headers);
}

export interface GrokProxyGetHeaderOptions {
  bearer: string;
  userId: string;
  email?: string;
  platform?: GrokPlatform;
}

/**
 * Headers for proxy GETs (`/settings`, `/models`, `/billing`, `/user`). Order follows the
 * 1.0.60 capture of `GET /settings`.
 */
export function buildGrokProxyGetHeaders(
  options: GrokProxyGetHeaderOptions,
): Record<string, string> {
  const headers = new Map([
    ["authorization", bearerValue(options.bearer)],
    ["x-xai-token-auth", "xai-grok-cli"],
    ["x-userid", requiredValue("userId", options.userId)],
    ["x-grok-client-version", GROK_BUILD_VERSION],
  ]);

  if (options.email !== undefined) headers.set("x-email", requiredValue("email", options.email));
  headers.set("x-grok-client-identifier", GROK_CLIENT_IDENTIFIER);
  headers.set("x-grok-client-mode", GROK_CLIENT_MODE);
  headers.set("accept", "*/*");
  headers.set("user-agent", grokShellUserAgent(options.platform));

  return Object.fromEntries(headers);
}

/**
 * Headers for `api.x.ai` image/video calls. The proxy auth trio is never attached.
 * `x-grok-session-id` is attached per request right after the bearer (grok-build xai-grok-tools
 * image_gen/mod.rs:199-213, video_gen/mod.rs:258-270).
 */
export function buildGrokMediaHeaders(options: { bearer: string; sessionId: string }) {
  return {
    "user-agent": grokMediaUserAgent(),
    authorization: bearerValue(options.bearer),
    "x-grok-session-id": requiredValue("sessionId", options.sessionId),
    "x-grok-client-version": GROK_BUILD_VERSION,
    "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
  };
}

/**
 * Headers for `api.x.ai` STT/TTS calls (grok-build 1.0.45 xai-grok-pager client_identity.rs).
 * No session id: the voice client sends none (xai-grok-voice stt/streaming.rs:42-57).
 */
export function buildGrokVoiceHeaders(options: { bearer: string; platform?: GrokPlatform }) {
  return {
    "user-agent": grokShellUserAgent(options.platform),
    authorization: bearerValue(options.bearer),
    "x-grok-client-version": GROK_BUILD_VERSION,
    "x-grok-client-identifier": GROK_CLIENT_IDENTIFIER,
  };
}
