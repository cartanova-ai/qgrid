import {
  type Experimental_RealtimeModelV4 as RealtimeModelV4,
  type Experimental_RealtimeModelV4ClientEvent as RealtimeClientEvent,
  type Experimental_RealtimeModelV4ServerEvent as RealtimeServerEvent,
  type Experimental_RealtimeModelV4SessionConfig as RealtimeSessionConfig,
  UnsupportedFunctionalityError,
} from "@ai-sdk/provider";
import { z } from "zod";

import { DEFAULT_QGRID_SERVER_URL, QGRID_PROVIDER_NAME } from "./qgrid.constant";

// This module is also the browser entry (`@cartanova/qgrid-ai-sdk/realtime`): it must not import
// the HTTP transport or anything else that pulls in undici.

/** GPT-Live on a ChatGPT subscription token (server 2.19.2+; `history` needs 2.19.3+). */
export type QgridRealtimeModel = "openai/gpt-live-1";

export type QgridRealtimeConfig = {
  /** Default: process.env.QGRID_URL, then http://localhost:44900. */
  serverUrl?: string;
  /** request_logs.project_name. Default: process.env.QGRID_PROJECT_NAME. */
  projectName?: string;
};

/**
 * `sessionConfig.providerOptions.qgrid`, read by `doCreateWebRTCSession` on the server. Build it
 * in your server route; do not forward the browser's object, which the user controls.
 */
export type QgridRealtimeProviderOptions = {
  /** Exact OpenAI token (`openai/<name>`); omitted, qgrid picks one by quota. */
  tokenName?: string;
  /** false writes no request log for the session. */
  logger?: boolean;
  /** Earlier conversation the session starts from: at most 128 items. */
  history?: Array<{ role: "user" | "assistant" | "developer"; text: string }>;
  /** What qgrid answers the voice's hand-offs with (default openai/gpt-6-luna, low effort). */
  delegation?: { model?: string; effort?: "low" | "medium" | "high"; webSearch?: boolean };
};

// Shape only; the server validates values (QGRID_MODELS, 128 history items, token prefix).
const qgridProviderOptionsSchema: z.ZodType<QgridRealtimeProviderOptions> = z.object({
  tokenName: z.string().optional(),
  logger: z.boolean().optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant", "developer"]), text: z.string() }))
    .optional(),
  delegation: z
    .object({
      model: z.string().optional(),
      effort: z.enum(["low", "medium", "high"]).optional(),
      webSearch: z.boolean().optional(),
    })
    .optional(),
});

type WebRTCSessionOptions = Parameters<NonNullable<RealtimeModelV4["doCreateWebRTCSession"]>>[0];

/** The AI SDK realtime model, with the SDP exchange always present and the request log ID typed. */
export type QgridLiveRealtimeModel = Omit<RealtimeModelV4, "doCreateWebRTCSession"> & {
  doCreateWebRTCSession(
    options: WebRTCSessionOptions,
  ): Promise<{ sessionId: string; sdp: string; requestLogId?: number }>;
};

const LABEL = "qgrid.realtime";

const env = (name: string): string | undefined =>
  typeof process === "undefined" ? undefined : process.env[name];

const liveCallOutputSchema = z.object({
  sdp: z.string().min(1),
  callId: z.string().min(1),
  requestLogId: z.number().optional(),
});

const usageSchema = z.object({ audio_duration_ms: z.number() });

const sessionStartedSchema = z.object({ session: z.object({ id: z.string() }) });

const sessionClosedSchema = z.object({
  reason: z.string().optional(),
  usage: usageSchema.optional(),
});

const usageUpdatedSchema = z.object({ usage: usageSchema });

// One spoken word or phrase, with the session time it was said at.
const transcriptAddedSchema = z.object({
  item: z.object({ text: z.string() }),
  start_ms: z.number(),
  end_ms: z.number(),
});

const delegationCreatedSchema = z.object({
  item: z.object({ id: z.string() }),
  offset_ms: z.number().optional(),
});

const errorSchema = z.object({
  error: z.object({ message: z.string(), code: z.string().nullish() }),
});

const envelopeSchema = z.object({ type: z.string() });

type LiveEventParser = ReturnType<NonNullable<RealtimeModelV4["createServerEventParser"]>>;

type InputText = { type: "input_text"; text: string };

/** The GPT-Live client events qgrid sends on the data channel. */
type LiveClientEvent =
  | { type: "session.close" }
  | { type: "session.context.append"; content: InputText[] }
  | { type: "delegation.context.append"; delegation_item_id: string; content: InputText[] };

/**
 * Maps GPT-Live data-channel events (the Codex frameless protocol, not the public API's `session.*`
 * names) to AI SDK events. Spoken text comes from `input_transcript.added` and
 * `output_transcript.added`: `turn.delta` leaves out each turn's first word, which only
 * `turn.created` carries (live session, 2026-11-10). One parser per connection, for the last usage.
 */
function createLiveEventParser(): LiveEventParser {
  let usageMs = 0;

  return (raw) => {
    const type = envelopeSchema.safeParse(raw).data?.type;
    const custom = (): RealtimeServerEvent => ({ type: "custom", rawType: type ?? "unknown", raw });

    switch (type) {
      case "session.started": {
        const event = sessionStartedSchema.safeParse(raw);

        // No delegationMode: the AI SDK runtime rejects "provider" (ai 7.0.148), and "client" would
        // tell the app to answer delegations that qgrid already answers on the server.
        return event.success
          ? { type: "session-started", sessionId: event.data.session.id, raw }
          : custom();
      }

      case "session.usage.updated": {
        const event = usageUpdatedSchema.safeParse(raw);

        if (!event.success) return custom();
        usageMs = event.data.usage.audio_duration_ms;

        return { type: "session-usage", usage: { seconds: usageMs / 1000 }, raw };
      }

      case "session.closed": {
        const event = sessionClosedSchema.safeParse(raw);
        const ms = (event.success ? event.data.usage?.audio_duration_ms : undefined) ?? usageMs;

        return {
          type: "session-closed",
          usage: { seconds: ms / 1000 },
          reason: (event.success ? event.data.reason : undefined) ?? "closed",
          raw,
        };
      }

      case "input_transcript.added":
      case "output_transcript.added": {
        const event = transcriptAddedSchema.safeParse(raw);

        return event.success
          ? {
              type: "transcript-fragment",
              speaker: type === "input_transcript.added" ? "user" : "assistant",
              delta: event.data.item.text,
              startMs: event.data.start_ms,
              endMs: event.data.end_ms,
              raw,
            }
          : custom();
      }

      case "delegation.created": {
        const event = delegationCreatedSchema.safeParse(raw);

        return event.success
          ? {
              type: "delegation-created",
              delegationId: event.data.item.id,
              target: "provider",
              offsetMs: event.data.offset_ms,
              raw,
            }
          : custom();
      }

      case "error": {
        const event = errorSchema.safeParse(raw);

        return event.success
          ? {
              type: "error",
              message: event.data.error.message,
              code: event.data.error.code ?? undefined,
              raw,
            }
          : { type: "error", message: "Invalid GPT-Live error event.", raw };
      }

      default:
        return custom();
    }
  };
}

function serializeLiveClientEvent(event: RealtimeClientEvent): LiveClientEvent {
  switch (event.type) {
    case "session-close":
      return { type: "session.close" };

    case "context-append": {
      const content: InputText[] = [{ type: "input_text", text: event.content }];

      return event.delegationId === null
        ? { type: "session.context.append", content }
        : { type: "delegation.context.append", delegation_item_id: event.delegationId, content };
    }

    default:
      throw new UnsupportedFunctionalityError({
        functionality: `${LABEL}: ${event.type}; GPT-Live through qgrid supports session-close and context-append`,
      });
  }
}

/**
 * GPT-Live as an AI SDK realtime model. The browser runtime (`experimental_useRealtime` with
 * `api: { session }`) owns the microphone, playback and the WebRTC peer; your server route calls
 * `doCreateWebRTCSession`, which exchanges the SDP through the qgrid server. qgrid answers the
 * voice's delegations itself and logs the transcript.
 */
export function createQgridRealtime(
  modelId: QgridRealtimeModel,
  config?: QgridRealtimeConfig,
): QgridLiveRealtimeModel {
  if (modelId !== "openai/gpt-live-1") {
    throw new Error(`${LABEL}: unsupported model ${String(modelId)}; expected openai/gpt-live-1`);
  }

  const parse = createLiveEventParser();

  return {
    specificationVersion: "v4",
    provider: QGRID_PROVIDER_NAME,
    modelId,
    capabilities: {
      conversation: "continuous",
      transports: ["webrtc"],
      connections: ["webrtc"],
      startup: "session-start",
      finalization: "session-close",
    },

    getWebRTCConfig: () => ({ dataChannelLabel: "oai-events" }),

    async doCreateWebRTCSession({ sdp, sessionConfig, abortSignal }) {
      const serverUrl = config?.serverUrl ?? env("QGRID_URL") ?? DEFAULT_QGRID_SERVER_URL;

      const options = qgridProviderOptionsSchema.safeParse(
        sessionConfig?.providerOptions?.qgrid ?? {},
      );

      if (!options.success) {
        throw new Error(
          `${LABEL}: providerOptions.qgrid: ${options.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
        );
      }

      const qgrid = options.data;

      const params = {
        model: modelId,
        sdp,
        voice: sessionConfig?.voice,
        instructions: sessionConfig?.instructions || undefined,
        history: qgrid.history,
        delegation: qgrid.delegation,
        tokenName: qgrid.tokenName,
        logger: qgrid.logger,
        projectName: config?.projectName ?? env("QGRID_PROJECT_NAME"),
      };

      const response = await fetch(`${serverUrl}/api/qgrid/liveCall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ params }),
        signal: abortSignal,
      });

      if (!response.ok) {
        throw new Error(
          `qgrid liveCall ${response.status}: ${(await response.text()).slice(0, 2_000)}`,
        );
      }

      const output = liveCallOutputSchema.parse(await response.json());

      // requestLogId rides along for server routes that log it; the browser runtime ignores it.
      return { sessionId: output.callId, sdp: output.sdp, requestLogId: output.requestLogId };
    },

    parseServerEvent: parse,
    createServerEventParser: createLiveEventParser,
    serializeClientEvent: serializeLiveClientEvent,
    buildSessionConfig: (sessionConfig: RealtimeSessionConfig) => ({
      instructions: sessionConfig.instructions,
      voice: sessionConfig.voice,
    }),
  };
}
