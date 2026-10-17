import {
  type LanguageModelV3,
  type LanguageModelV3CallOptions,
  type LanguageModelV3Content,
  type LanguageModelV3FilePart,
  type LanguageModelV3FinishReason,
  type LanguageModelV3FunctionTool,
  type LanguageModelV3GenerateResult,
  type LanguageModelV3Message,
  type LanguageModelV3StreamPart,
  type LanguageModelV3StreamResult,
  type JSONObject,
  type SharedV3ProviderMetadata,
  type SharedV3Warning,
} from "@ai-sdk/provider";
import { z } from "zod";

import { createEnvelopeStreamParser } from "./envelope-stream-parser";
import { mapXaiProviderOptions, type QgridGrokEffort } from "./grok-options";
import {
  closeQgridRequestTransport,
  createQgridRequestTransport,
  qgridFetch,
  type QgridRequestInit,
} from "./http-transport";
import { createQgridImage } from "./image-model";
import {
  queryOutputSchema,
  type QgridSupportedModel,
  type QueryOutput,
  type QgridAnthropicModel,
  type QgridAnthropicProviderConfig,
  type QgridGrokModel,
  type QgridInputPart,
  type QgridOpenAIModel,
  type QgridOpenAIProviderConfig,
  type QgridProviderConfig,
  type QgridResolvedProviderOptions,
  type QgridThreadCoord,
} from "./index.types";
import {
  DEFAULT_QGRID_EFFORT,
  DEFAULT_QGRID_SERVER_URL,
  PENDING_TOOL_RESULTS_WARNING,
  QGRID_PROVIDER_NAME,
  TEXT_STREAM_ID_PREFIX,
  THREAD_COORD_TTL_MS,
  TOP_LEVEL_SCHEMA_WARNING,
} from "./qgrid.constant";
import { createQgridSpeech } from "./speech-model";
import { createQgridTranscription } from "./transcription-model";
import {
  assertImageInputFitsJsonTransport,
  bytesToBase64,
  extractPromptAndHistory,
  extractToolResultsFromHistory,
  parseSSE,
  type PromptHistoryItem,
  type QgridToolDefinition,
  toQgridTool,
} from "./utils";
import { createQgridVideo } from "./video-model";

/** `qgrid()` config for Grok models; `defaultEffort` uses the Grok catalog effort vocabulary. */
export type QgridGrokProviderConfig = Omit<QgridOpenAIProviderConfig, "defaultEffort"> & {
  /** Omitted: the server applies the model's catalog default effort. */
  defaultEffort?: QgridGrokEffort;
};

// model-scoped opaque affinity → threadCoord. The key is derived independently of this map, so
// separate qgrid() instances and processes send the same cache affinity for the same session.
// 클라이언트가 전달한 providerOptions.qgrid.sessionKey의 좌표 발급/보관/회송을 여기서 처리한다
// 모듈 레벨이라 qgrid() 인스턴스를 매 호출 새로 만들어도 공유
const threadCoordStore = new Map<string, { coord: QgridThreadCoord; expiresAt: number }>();
const CACHE_AFFINITY_NAMESPACE = "qgrid-cache-affinity-v1";
const MAX_THREAD_COORDS = 1_000;

function warnDroppedImages(droppedImageCount: number): void {
  if (droppedImageCount <= 0) return;
  console.warn(
    `[qgrid] ${droppedImageCount} image message part(s) were ignored because qgrid language models do not support image input. For image generation or editing, use generateImage with qgrid.image().`,
  );
}

function isGrokModel(modelId: string): boolean {
  return modelId.startsWith("grok/");
}

const IMAGE_SIGNATURES: ReadonlyArray<{ mediaType: string; bytes: readonly number[] }> = [
  { mediaType: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mediaType: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mediaType: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
];

function sniffImageMediaType(bytes: Uint8Array): string | undefined {
  return IMAGE_SIGNATURES.find((signature) =>
    signature.bytes.every((byte, index) => bytes[index] === byte),
  )?.mediaType;
}

// Grok input image URL for an image file part: an https URL is passed through, bytes become a data
// URL. Returns undefined for non-image parts and for images the backend cannot fetch.
function grokImageUrl(part: LanguageModelV3FilePart): string | undefined {
  const mediaType = part.mediaType.toLowerCase();

  if (!mediaType.startsWith("image/")) return undefined;
  const { data } = part;

  if (data instanceof URL) {
    return data.protocol === "https:" || data.protocol === "data:" ? data.href : undefined;
  }

  if (data instanceof Uint8Array) {
    const resolved = mediaType === "image/*" ? sniffImageMediaType(data) : mediaType;

    return resolved ? `data:${resolved};base64,${bytesToBase64(data)}` : undefined;
  }

  if (/^(https:|data:)/i.test(data)) return data;

  if (mediaType === "image/*") return undefined;

  return `data:${mediaType};base64,${data}`;
}

type GrokUserPart = { type: "text"; text: string } | { type: "image"; url: string };

type UserMessage = Extract<LanguageModelV3Message, { role: "user" }>;

function grokUserParts(content: UserMessage["content"]): GrokUserPart[] {
  const parts: GrokUserPart[] = [];

  for (const part of content) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "file") {
      const url = grokImageUrl(part);

      if (url !== undefined) parts.push({ type: "image", url });
    }
  }

  return parts;
}

type PreparedPrompt = {
  prompt: string;
  system: string | undefined;
  history: PromptHistoryItem[];
  input?: QgridInputPart[];
};

// Grok keeps user image parts: the current turn's images travel in `input`, earlier user turns
// carry Responses-style `input_image` parts in history. Other providers drop images with a warning.
function preparePrompt(modelId: string, messages: LanguageModelV3Message[]): PreparedPrompt {
  const extracted = extractPromptAndHistory(messages);

  if (!isGrokModel(modelId)) {
    warnDroppedImages(extracted.droppedImageCount);

    return extracted;
  }

  const userMessages = messages.filter(
    (message): message is UserMessage => message.role === "user",
  );

  const nonSystem = messages.filter((message) => message.role !== "system");
  const lastMessage = nonSystem.at(-1);
  const promptMessage = lastMessage?.role === "user" ? lastMessage : undefined;
  const historyUserMessages = promptMessage ? userMessages.slice(0, -1) : userMessages;

  let keptImageCount = 0;
  const imageUrls: string[] = [];

  const countImages = (parts: GrokUserPart[]) => {
    for (const part of parts) {
      if (part.type === "image") {
        keptImageCount++;
        imageUrls.push(part.url);
      }
    }
  };

  let historyUserIndex = 0;

  const history = extracted.history.map((item): PromptHistoryItem => {
    if (!isUserHistoryMessage(item)) return item;
    const source = historyUserMessages[historyUserIndex++];

    if (!source) return item;
    const parts = grokUserParts(source.content);

    if (!parts.some((part) => part.type === "image")) return item;
    countImages(parts);

    return {
      type: "message",
      role: "user",
      content: parts.map((part) =>
        part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.url },
      ),
    };
  });

  let input: QgridInputPart[] | undefined;

  if (promptMessage) {
    const parts = grokUserParts(promptMessage.content);

    if (parts.some((part) => part.type === "image")) {
      countImages(parts);
      input = parts.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text, text_elements: [] }
          : { type: "image", url: part.url },
      );
    }
  }

  assertImageInputFitsJsonTransport(imageUrls);
  warnDroppedImages(extracted.droppedImageCount - keptImageCount);

  const prepared: PreparedPrompt = { prompt: extracted.prompt, system: extracted.system, history };

  if (input) prepared.input = input;

  return prepared;
}

function isUserHistoryMessage(item: PromptHistoryItem): boolean {
  return item.type === "message" && item.role === "user";
}

type ResolvedXaiOptions = {
  warnings: SharedV3Warning[];
  effort?: QgridGrokEffort;
  promptCacheKey?: string;
};

type ToolResultPayload = { toolCallId: string; output: string; isError?: boolean };

/** `args` of `/api/qgrid/query` and `/api/qgrid/prepareStream`. */
interface QgridQueryArgs {
  prompt: string;
  model: string;
  system?: string;
  effort?: string;
  thinking?: boolean;
  input?: QgridInputPart[];
  verbosity?: string;
  reasoningSummary?: string;
  serviceTier?: string;
  timeout?: number;
  tools?: QgridToolDefinition[];
  jsonSchema?: string;
  history?: string;
  projectName?: string;
  cacheAffinityKey?: string;
  logger?: false;
  tokenName?: string;
  runContext?: NonNullable<QueryOutput["runContext"]>;
  toolResults?: ToolResultPayload[];
}

const prepareStreamOutputSchema = z.object({ streamId: z.string() });
const streamDeltaSchema = z.object({ text: z.string() });
const streamErrorSchema = z.object({ message: z.string() });

function resolveXaiOptions(
  modelId: string,
  options: LanguageModelV3CallOptions,
): ResolvedXaiOptions {
  const raw = options.providerOptions?.xai;

  if (!isGrokModel(modelId)) {
    return raw === undefined
      ? { warnings: [] }
      : {
          warnings: [
            {
              type: "unsupported",
              feature: "providerOptions.xai",
              details: `providerOptions.xai applies only to grok/ models and was ignored for ${modelId}.`,
            },
          ],
        };
  }

  const mapped = mapXaiProviderOptions(raw, modelId);
  const { effort, promptCacheKey } = mapped.request;

  const resolved: ResolvedXaiOptions = {
    warnings: mapped.warnings.map((warning) => ({
      type: "unsupported",
      feature: `providerOptions.xai.${warning.key}`,
      details: warning.reason,
    })),
  };

  if (effort !== undefined) resolved.effort = effort;

  if (promptCacheKey !== undefined) resolved.promptCacheKey = promptCacheKey;

  return resolved;
}

const xaiResponseMetadataSchema = z.object({
  providerMetadata: z.object({
    xai: z.object({
      costInUsdTicks: z.number().optional(),
      contextWindow: z.number().optional(),
    }),
  }),
});

function serializeObjectResponseFormat(
  responseFormat: LanguageModelV3CallOptions["responseFormat"],
): string | undefined {
  const rawSchema = responseFormat?.type === "json" ? responseFormat.schema : undefined;

  if (rawSchema === undefined) return undefined;

  const schemaType = rawSchema.type;

  if (schemaType !== "object") {
    console.warn(
      `[qgrid] responseFormat.schema top-level type is "${Array.isArray(schemaType) ? schemaType.join(",") : (schemaType ?? "unknown")}". ${TOP_LEVEL_SCHEMA_WARNING}`,
    );

    return undefined;
  }

  return JSON.stringify(rawSchema);
}

function getThreadCoord(sessionKey: string): QgridThreadCoord | undefined {
  const entry = threadCoordStore.get(sessionKey);

  if (!entry) return undefined;

  if (entry.expiresAt <= Date.now()) {
    threadCoordStore.delete(sessionKey);

    return undefined;
  }

  return entry.coord;
}

function setThreadCoord(sessionKey: string, coord: QgridThreadCoord): void {
  const now = Date.now();

  for (const [key, entry] of threadCoordStore) {
    if (entry.expiresAt <= now) threadCoordStore.delete(key);
  }

  // Keep the most recently issued coordinates; the full history still works after eviction.
  threadCoordStore.delete(sessionKey);
  threadCoordStore.set(sessionKey, { coord, expiresAt: now + THREAD_COORD_TTL_MS });

  if (threadCoordStore.size > MAX_THREAD_COORDS) {
    threadCoordStore.delete(threadCoordStore.keys().next().value!);
  }
}

function providerWarnings(
  options: QgridResolvedProviderOptions,
  xaiWarnings: SharedV3Warning[] = [],
): LanguageModelV3GenerateResult["warnings"] {
  const warnings: SharedV3Warning[] =
    options.fallbackModels === undefined
      ? []
      : [
          {
            type: "unsupported",
            feature: "providerOptions.qgrid.fallbackModels",
            details:
              "fallbackModels is deprecated and ignored; qgrid does not implement model fallback routing.",
          },
        ];

  return [...warnings, ...xaiWarnings];
}

async function deriveCacheAffinityKey(
  modelId: QgridSupportedModel,
  sessionKey?: string,
): Promise<string | undefined> {
  if (!sessionKey || modelId.startsWith("anthropic/")) return undefined;
  const bytes = new TextEncoder().encode(`${CACHE_AFFINITY_NAMESPACE}\0${modelId}\0${sessionKey}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function qgridProviderMetadata(data: QueryOutput): SharedV3ProviderMetadata {
  const xai = xaiResponseMetadataSchema.safeParse(data);
  const metadata: SharedV3ProviderMetadata = {};

  if (xai.success) {
    const { costInUsdTicks, contextWindow } = xai.data.providerMetadata.xai;
    const xaiMetadata: JSONObject = {};

    if (costInUsdTicks !== undefined) xaiMetadata.costInUsdTicks = costInUsdTicks;

    if (contextWindow !== undefined) xaiMetadata.contextWindow = contextWindow;

    if (Object.keys(xaiMetadata).length > 0) metadata.xai = xaiMetadata;
  }

  const qgridMetadata: JSONObject = {};

  if (data.requestLogId !== undefined) qgridMetadata.requestLogId = data.requestLogId;
  qgridMetadata.model = data.model;
  qgridMetadata.requestedModel = data.requestedModel ?? data.model;
  qgridMetadata.modelFallbacks = data.modelFallbacks ?? [];
  qgridMetadata.tokenName = data.tokenName ?? null;
  qgridMetadata.durationMs = data.durationMs;
  qgridMetadata.costUsd = data.costUsd;
  qgridMetadata.costSource = data.costSource;
  qgridMetadata.cacheCreation5mInputTokens = data.usage.cache_creation_5m_input_tokens ?? null;
  qgridMetadata.cacheCreation1hInputTokens = data.usage.cache_creation_1h_input_tokens ?? null;
  metadata.qgrid = qgridMetadata;

  return metadata;
}

/** JSON callers often pass null for "unset"; these options treated null as absent before. */
function nullAsUnset<T extends z.ZodType>(schema: T) {
  return schema.nullish().transform((value) => value ?? undefined);
}

const qgridProviderOptionsSchema: z.ZodType<QgridResolvedProviderOptions> = z.looseObject({
  thinking: z.boolean().optional(),
  tokenName: z.string().optional(),
  logger: nullAsUnset(z.boolean()),
  fallbackModels: nullAsUnset(z.array(z.string())),
  sessionKey: nullAsUnset(z.string()),
  effort: nullAsUnset(z.string()),
  verbosity: nullAsUnset(z.enum(["low", "medium", "high"])),
  reasoningSummary: nullAsUnset(z.enum(["auto", "concise", "detailed", "none"])),
  serviceTier: nullAsUnset(z.string()),
  timeoutMs: z.number().optional(),
});

function getQgridProviderOptions(
  options: LanguageModelV3CallOptions,
): QgridResolvedProviderOptions {
  const raw = options.providerOptions?.qgrid ?? {};

  if ("imageGeneration" in raw || "imageGenerationOptions" in raw) {
    throw new Error(
      "qgrid: imageGeneration and imageGenerationOptions were removed from language-model options. Use generateImage with qgrid.image().",
    );
  }

  const parsed = qgridProviderOptionsSchema.safeParse(raw);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
      .join("; ");

    throw new Error(`qgrid: invalid providerOptions.qgrid: ${issues}`);
  }

  const qgridOptions = parsed.data;

  if (qgridOptions.tokenName !== undefined && qgridOptions.tokenName.trim() === "") {
    throw new Error("qgrid: tokenName must not be empty");
  }

  return qgridOptions;
}

function toAiSdkUsage(usage: QueryOutput["usage"]) {
  const cacheRead = usage.cache_read_input_tokens;
  const cacheWrite = usage.cache_creation_input_tokens;
  const reasoning = usage.reasoning_tokens ?? 0;

  return {
    inputTokens: {
      total: usage.input_tokens,
      noCache: Math.max(usage.input_tokens - cacheRead - cacheWrite, 0),
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: usage.output_tokens,
      text: Math.max(usage.output_tokens - reasoning, 0),
      reasoning,
    },
  };
}

// 모델 ID prefix 로 오버로드해 `defaultEffort` 가 provider 어휘로 타입 검사되게 한다.
// providerOptions 는 AI SDK 가 모델과 연결해 주지 않으므로 여기가 유일한 타입 수준 강제 지점이다.
export function qgrid(
  modelId: QgridOpenAIModel,
  config?: QgridOpenAIProviderConfig,
): LanguageModelV3;
export function qgrid(
  modelId: QgridAnthropicModel,
  config?: QgridAnthropicProviderConfig,
): LanguageModelV3;
export function qgrid(modelId: QgridGrokModel, config?: QgridGrokProviderConfig): LanguageModelV3;
export function qgrid(
  modelId: QgridSupportedModel,
  config?: QgridProviderConfig | QgridGrokProviderConfig,
): LanguageModelV3 {
  const serverUrl = config?.serverUrl ?? process.env.QGRID_URL ?? DEFAULT_QGRID_SERVER_URL;

  // Grok keeps the catalog default effort unless the caller chooses one.
  const effort: string | undefined =
    config?.defaultEffort ?? (isGrokModel(modelId) ? undefined : DEFAULT_QGRID_EFFORT);

  const projectName = config?.projectName ?? process.env.QGRID_PROJECT_NAME;

  type ClientRunContext = NonNullable<QueryOutput["runContext"]>;

  type ClientRunState = {
    runContext?: ClientRunContext;
    pendingToolCallIds: Set<string>;
  };

  type MatchedClientRun = {
    key: string;
    runContext?: ClientRunContext;
    toolResultsPayload: Array<{ toolCallId: string; output: string; isError?: boolean }>;
  };

  const clientRuns = new Map<string, ClientRunState>();
  let anonymousClientRunId = 0;

  function clientRunKey(runContext?: ClientRunContext): string {
    if (runContext?.requestLogId !== undefined) return `request:${runContext.requestLogId}`;

    if (runContext?.threadCoord) {
      const { workerId, epoch, threadId } = runContext.threadCoord;

      return `thread:${workerId}:${epoch}:${threadId}`;
    }

    anonymousClientRunId++;

    return `anonymous:${anonymousClientRunId}`;
  }

  function rememberClientRun(runContext: ClientRunContext | undefined, toolCallIds: string[]) {
    if (toolCallIds.length === 0) return;
    clientRuns.set(clientRunKey(runContext), {
      runContext,
      pendingToolCallIds: new Set(toolCallIds),
    });
  }

  function matchClientRun(messages: LanguageModelV3CallOptions["prompt"]): MatchedClientRun | null {
    const toolResults = extractToolResultsFromHistory(messages);

    if (toolResults.length === 0) return null;

    const resultIds = new Set(toolResults.map((r) => r.callId));

    for (const [key, run] of clientRuns) {
      if (
        run.pendingToolCallIds.size > 0 &&
        [...run.pendingToolCallIds].every((id) => resultIds.has(id))
      ) {
        return {
          key,
          runContext: run.runContext,
          toolResultsPayload: toolResults
            .filter((r) => run.pendingToolCallIds.has(r.callId))
            .map((r) => ({ toolCallId: r.callId, output: r.result })),
        };
      }
    }

    if (clientRuns.size > 0) console.warn(PENDING_TOOL_RESULTS_WARNING);

    return null;
  }

  return {
    specificationVersion: "v3",
    provider: QGRID_PROVIDER_NAME,
    modelId,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
      const tools = options.tools?.filter(
        (t): t is LanguageModelV3FunctionTool => t.type === "function",
      );

      const hasTools = tools && tools.length > 0;
      const qgridOptions = getQgridProviderOptions(options);
      const xaiOptions = resolveXaiOptions(modelId, options);
      const { prompt, system, history, input } = preparePrompt(modelId, options.prompt);

      const effectiveEffort =
        qgridOptions.thinking === false
          ? undefined
          : (qgridOptions.effort ?? xaiOptions.effort ?? effort);

      const verbosity = qgridOptions.verbosity;
      const reasoningSummary = qgridOptions.reasoningSummary;
      const serviceTier = qgridOptions.serviceTier;
      const timeoutMs = qgridOptions.timeoutMs;
      const logger = qgridOptions.logger;
      const tokenName = qgridOptions.tokenName;
      // 멀티턴 대화 식별자. 호출자가 자기 도메인 ID(예: 게임 세션 ID)만 넘기면,
      // thread 좌표 보관/회송은 threadCoordStore 가 내부에서 처리한다 → 클라이언트 무부담.
      // Grok: providerOptions.xai.promptCacheKey is the same affinity handle.
      const sessionKey = qgridOptions.sessionKey ?? xaiOptions.promptCacheKey;
      const cacheAffinityKey = await deriveCacheAffinityKey(modelId, sessionKey);

      // qgrid server는 object root schema만 받는다. tools 유무와 무관하게 같은 계약을 적용한다.
      const jsonSchema = serializeObjectResponseFormat(options.responseFormat);

      // follow-up 판단 + toolResults 구성
      let runContext: ClientRunContext | undefined;

      let toolResultsPayload:
        | Array<{ toolCallId: string; output: string; isError?: boolean }>
        | undefined;

      const matchedClientRun = matchClientRun(options.prompt);

      if (matchedClientRun) {
        // follow-up (tool-call 루프)
        runContext = matchedClientRun.runContext;
        toolResultsPayload = matchedClientRun.toolResultsPayload;
      }

      // 비-tool 멀티턴: sessionKey 로 저장된 좌표를 회송.
      // locally matched tool-result follow-up에는 stale session 좌표를 새로 섞지 않는다.
      const storedCoord = cacheAffinityKey ? getThreadCoord(cacheAffinityKey) : undefined;

      if (!matchedClientRun && storedCoord) {
        runContext = { threadCoord: storedCoord };
      }

      const transport = createQgridRequestTransport(modelId, timeoutMs);

      const args: QgridQueryArgs = {
        prompt,
        model: modelId,
        system,
        effort: effectiveEffort,
        thinking: qgridOptions.thinking,
      };

      if (input) args.input = input;

      if (verbosity) args.verbosity = verbosity;

      if (reasoningSummary) args.reasoningSummary = reasoningSummary;

      if (serviceTier) args.serviceTier = serviceTier;

      if (timeoutMs !== undefined) args.timeout = timeoutMs;

      if (hasTools) args.tools = tools.map(toQgridTool);

      if (jsonSchema) args.jsonSchema = jsonSchema;

      if (history.length > 0) args.history = JSON.stringify(history);

      if (projectName) args.projectName = projectName;

      if (cacheAffinityKey) args.cacheAffinityKey = cacheAffinityKey;

      if (logger === false) args.logger = false;

      if (tokenName) args.tokenName = tokenName;

      if (runContext) args.runContext = runContext;

      if (toolResultsPayload) args.toolResults = toolResultsPayload;

      const init: QgridRequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
        signal: options.abortSignal,
      };

      if (transport) init.dispatcher = transport.dispatcher;

      const data = await qgridFetch(`${serverUrl}/api/qgrid/query`, init, {
        operation: "query",
        serverUrl,
        transportTimeoutMs: transport?.timeoutMs,
      })
        .then(async (res) => {
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`qgrid ${res.status}: ${text}`);
          }

          return queryOutputSchema.parse(await res.json());
        })
        .finally(() => closeQgridRequestTransport(transport));

      // 응답 변환
      const content: LanguageModelV3Content[] = [];
      let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" };

      if (data.content) {
        for (const item of data.content) {
          // 명시 분기: 미지의 variant 를 tool-call 로 오인하지 않는다.
          if (item.type === "text") {
            content.push({ type: "text", text: item.text });
          } else if (item.type === "tool-call") {
            content.push({
              type: "tool-call",
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              input: item.input,
            });
          }
        }

        if (data.finishReason === "tool-calls")
          finishReason = { unified: "tool-calls", raw: "tool_call" };
      } else {
        content.push({ type: "text", text: data.text });
      }

      // client run state 업데이트
      if (matchedClientRun) clientRuns.delete(matchedClientRun.key);

      if (finishReason.unified === "tool-calls") {
        rememberClientRun(
          data.runContext,
          content.flatMap((c) => (c.type === "tool-call" ? [c.toolCallId] : [])),
        );
      }

      // sessionKey 가 있으면 발급된 좌표를 저장 → 다음 호출에 자동 회송 (thread 재사용).
      if (cacheAffinityKey && data.runContext?.threadCoord) {
        setThreadCoord(cacheAffinityKey, data.runContext.threadCoord);
      }

      return {
        content,
        finishReason,
        usage: toAiSdkUsage(data.usage),
        warnings: providerWarnings(qgridOptions, xaiOptions.warnings),
        providerMetadata: qgridProviderMetadata(data),
        response: { modelId: data.model },
      };
    },

    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const tools = options.tools?.filter(
        (t): t is LanguageModelV3FunctionTool => t.type === "function",
      );

      const hasTools = tools && tools.length > 0;
      const qgridOptions = getQgridProviderOptions(options);
      const xaiOptions = resolveXaiOptions(modelId, options);

      const effectiveEffort =
        qgridOptions.thinking === false
          ? undefined
          : (qgridOptions.effort ?? xaiOptions.effort ?? effort);

      const verbosity = qgridOptions.verbosity;
      const reasoningSummary = qgridOptions.reasoningSummary;
      const serviceTier = qgridOptions.serviceTier;
      const timeoutMs = qgridOptions.timeoutMs;
      const logger = qgridOptions.logger;
      const tokenName = qgridOptions.tokenName;
      const { prompt, system, history, input } = preparePrompt(modelId, options.prompt);
      const sessionKey = qgridOptions.sessionKey ?? xaiOptions.promptCacheKey;
      const cacheAffinityKey = await deriveCacheAffinityKey(modelId, sessionKey);

      const jsonSchema = serializeObjectResponseFormat(options.responseFormat);

      // follow-up 판단
      let runContext: ClientRunContext | undefined;

      let toolResultsPayload:
        | Array<{ toolCallId: string; output: string; isError?: boolean }>
        | undefined;

      const matchedClientRun = matchClientRun(options.prompt);

      if (matchedClientRun) {
        runContext = matchedClientRun.runContext;
        toolResultsPayload = matchedClientRun.toolResultsPayload;
      }

      // 비-tool 멀티턴: sessionKey 로 저장된 좌표를 회송. locally matched tool
      // follow-up에는 stale session 좌표를 새로 섞지 않는다.
      const storedCoord = cacheAffinityKey ? getThreadCoord(cacheAffinityKey) : undefined;

      if (!matchedClientRun && storedCoord) {
        runContext = { threadCoord: storedCoord };
      }

      const abortController = new AbortController();

      const signal = options.abortSignal
        ? AbortSignal.any([options.abortSignal, abortController.signal])
        : abortController.signal;

      const args: QgridQueryArgs = {
        prompt,
        model: modelId,
        system,
        effort: effectiveEffort,
        thinking: qgridOptions.thinking,
      };

      if (input) args.input = input;

      if (verbosity) args.verbosity = verbosity;

      if (reasoningSummary) args.reasoningSummary = reasoningSummary;

      if (serviceTier) args.serviceTier = serviceTier;

      if (timeoutMs !== undefined) args.timeout = timeoutMs;

      if (hasTools) args.tools = tools.map(toQgridTool);

      if (jsonSchema) args.jsonSchema = jsonSchema;

      if (history.length > 0) args.history = JSON.stringify(history);

      if (projectName) args.projectName = projectName;

      if (cacheAffinityKey) args.cacheAffinityKey = cacheAffinityKey;

      if (logger === false) args.logger = false;

      if (tokenName) args.tokenName = tokenName;

      if (runContext) args.runContext = runContext;

      if (toolResultsPayload) args.toolResults = toolResultsPayload;

      const prepRes = await fetch(`${serverUrl}/api/qgrid/prepareStream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
        signal,
      });

      if (!prepRes.ok) {
        const text = await prepRes.text().catch(() => "");
        throw new Error(`qgrid prepareStream ${prepRes.status}: ${text}`);
      }

      const { streamId } = prepareStreamOutputSchema.parse(await prepRes.json());

      const streamRes = await fetch(`${serverUrl}/api/qgrid/queryStream?streamId=${streamId}`, {
        signal,
      });

      if (!streamRes.ok || !streamRes.body) {
        const text = await streamRes.text().catch(() => "");
        throw new Error(`qgrid stream ${streamRes.status}: ${text}`);
      }

      const textId = `${TEXT_STREAM_ID_PREFIX}_${Math.random().toString(36).slice(2, 10)}`;
      let textStarted = false;
      let deltaTextEmitted = false;

      // 툴이 있으면 델타는 봉투 JSON 원문이다. 증분 파싱해 action:"answer" 로
      // 판명되는 순간부터 answer 값만 재방출한다 (SON-527). tool_call 이거나
      // 미판명 구간이면 파서가 "" 를 돌려줘 기존처럼 보류된다.
      const envelopeParser = hasTools
        ? createEnvelopeStreamParser(jsonSchema ? "json" : "text")
        : undefined;

      let cancelled = false;
      let processing: Promise<void>;

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          processing = processEvents(controller);
        },
        async cancel(reason) {
          cancelled = true;
          abortController.abort(reason);
          await processing;
        },
      });

      async function processEvents(
        controller: ReadableStreamDefaultController<LanguageModelV3StreamPart>,
      ) {
        try {
          controller.enqueue({
            type: "stream-start",
            warnings: providerWarnings(qgridOptions, xaiOptions.warnings),
          });
          let streamCompleted = false;

          for await (const event of parseSSE(streamRes.body!, signal)) {
            if (cancelled) return;
            signal.throwIfAborted();

            if (event.type === "delta") {
              const raw = streamDeltaSchema.parse(event.data).text;
              const text = envelopeParser ? envelopeParser.push(raw) : raw;

              if (text !== "") {
                if (!textStarted) {
                  controller.enqueue({ type: "text-start", id: textId });
                  textStarted = true;
                }

                controller.enqueue({
                  type: "text-delta",
                  id: textId,
                  delta: text,
                });
                deltaTextEmitted = true;
              }
            } else if (event.type === "done") {
              if (textStarted) {
                controller.enqueue({ type: "text-end", id: textId });
                textStarted = false;
              }

              const done = queryOutputSchema.parse(event.data);

              // client run state 업데이트
              if (matchedClientRun) clientRuns.delete(matchedClientRun.key);

              if (done.finishReason === "tool-calls") {
                rememberClientRun(
                  done.runContext,
                  (done.content ?? [])
                    .filter(
                      (
                        c,
                      ): c is Extract<
                        NonNullable<QueryOutput["content"]>[number],
                        { type: "tool-call" }
                      > => c.type === "tool-call",
                    )
                    .map((c) => c.toolCallId),
                );
              }

              // sessionKey 가 있으면 발급된 좌표를 저장 → 다음 호출에 자동 회송 (thread 재사용).
              if (cacheAffinityKey && done.runContext?.threadCoord) {
                setThreadCoord(cacheAffinityKey, done.runContext.threadCoord);
              }

              // AI SDK stream parts
              if (done.content) {
                for (const item of done.content) {
                  if (item.type === "text" && !deltaTextEmitted) {
                    const tid = `${TEXT_STREAM_ID_PREFIX}_${Math.random()
                      .toString(36)
                      .slice(2, 10)}`;

                    controller.enqueue({ type: "text-start", id: tid });
                    controller.enqueue({ type: "text-delta", id: tid, delta: item.text });
                    controller.enqueue({ type: "text-end", id: tid });
                  } else if (item.type === "tool-call") {
                    controller.enqueue({
                      type: "tool-input-start",
                      id: item.toolCallId,
                      toolName: item.toolName,
                    });
                    controller.enqueue({
                      type: "tool-input-delta",
                      id: item.toolCallId,
                      delta: item.input,
                    });
                    controller.enqueue({ type: "tool-input-end", id: item.toolCallId });
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: item.toolCallId,
                      toolName: item.toolName,
                      input: item.input,
                    });
                  }
                }
              }

              controller.enqueue({
                type: "response-metadata",
                modelId: done.model,
              });
              controller.enqueue({
                type: "finish",
                finishReason:
                  done.finishReason === "tool-calls"
                    ? { unified: "tool-calls", raw: "tool_call" }
                    : { unified: "stop", raw: "stop" },
                usage: toAiSdkUsage(done.usage),
                providerMetadata: qgridProviderMetadata(done),
              });
              streamCompleted = true;
              controller.close();

              return;
            } else if (event.type === "error") {
              streamCompleted = true;
              const streamError = streamErrorSchema.safeParse(event.data);

              controller.error(
                new Error(
                  streamError.success ? streamError.data.message : JSON.stringify(event.data),
                ),
              );

              return;
            }
          }

          if (!streamCompleted && !cancelled) {
            signal.throwIfAborted();
            controller.error(new Error("qgrid stream ended unexpectedly"));
          }
        } catch (e) {
          if (!cancelled) controller.error(e);
        }
      }

      return { stream };
    },
  };
}

qgrid.image = createQgridImage;

qgrid.video = createQgridVideo;

qgrid.transcription = createQgridTranscription;

qgrid.speech = createQgridSpeech;

export {
  QGRID_MAX_REQUEST_BODY_BYTES,
  QgridMediaHttpError,
  type QgridGrokMediaProviderOptions,
  type QgridMediaProviderConfig,
  type QgridOpenAIMediaProviderOptions,
  type QgridXaiImageProviderOptions,
} from "./image-model";

export {
  QgridVideoGenerationError,
  QgridVideoTimeoutError,
  resumeQgridVideo,
  type QgridVideoPollOptions,
  type QgridVideoResult,
  type QgridXaiVideoProviderOptions,
} from "./video-model";

export {
  type QgridOpenAITranscriptionProviderOptions,
  type QgridXaiTranscriptionProviderOptions,
} from "./transcription-model";

export { type QgridOpenAISpeechProviderOptions } from "./speech-model";

export { createQgridLogger } from "./logger";

export { QgridXaiOptionsError, type QgridGrokEffort } from "./grok-options";

export type {
  QgridImageGenerationMetadata,
  QgridImageModel,
  QgridImageProviderConfig,
  QgridImageProviderOptions,
  QgridAnthropicEffort,
  QgridAnthropicModel,
  QgridAnthropicProviderConfig,
  QgridAnthropicProviderOptions,
  QgridGrokModel,
  QgridGrokSpeechModel,
  QgridGrokTranscriptionModel,
  QgridLoggerConfig,
  QgridOpenAIEffort,
  QgridOpenAIModel,
  QgridOpenAIProviderConfig,
  QgridOpenAIProviderOptions,
  QgridOpenAISpeechModel,
  QgridOpenAITranscriptionModel,
  QgridProviderConfig,
  QgridProviderOptions,
  QgridSpeechModel,
  QgridSupportedModel,
  QgridTranscriptionModel,
  QgridVideoModel,
  QgridXaiProviderOptions,
} from "./index.types";

export default qgrid;
