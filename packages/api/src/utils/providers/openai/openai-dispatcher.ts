import { getLogger } from "@logtape/logtape";
import { z } from "zod";

import {
  type ImageGenerationMetadata,
  QuotaThresholdExceededError,
} from "../../../application/qgrid/qgrid.types";
import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";
import { isOpenAICredentials } from "../common/credentials";
import { resolveOpenAIEffort } from "../common/effort";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type GeneratedImage,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { isJsonObject, jsonString } from "../common/provider-types";
import { SmoothWeightedRoundRobin } from "../common/smooth-weighted-round-robin";
import { ThinkingValidationError } from "../common/thinking";
import {
  imageMimeType,
  type JsonValue,
  type OpenAINormalizedEvent,
  type OpenAIResponseItem,
  type OpenAIResponsesOptions,
} from "./openai-backend-protocol";
import {
  OpenAIDirectClient,
  type OpenAIDirectClientOptions,
  type OpenAIDirectCredentials,
} from "./openai-direct-client";
import { readOpenAIQuotaUsage, type OpenAIRateLimitsWithMeta } from "./openai-quota";
import { handleChatgptAuthTokensRefresh } from "./openai-refresh";
import { type OpenAITransportKind, resolveOpenAITransportKind } from "./openai-transport-config";
import {
  isUnauthorizedRealtimeError,
  type OpenAISpeakRequest,
  type OpenAISpeechResult,
  type OpenAITranscribeRequest,
  type OpenAITranscription,
  OpenAIVoiceClient,
} from "./openai-voice-client";

const logger = getLogger(["qgrid", "openai-dispatcher"]);

// Verified with the subscription Responses backend; public API support is not sufficient.
const THINKING_OFF_MODELS = new Set([
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
]);

const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
const IMAGE_TOOL = "generate_image";

type ImageToolArguments = {
  prompt: string;
  transparent_background: boolean;
  num_last_images_to_include: number;
};

// Exactly these three keys; the backend rejects strict tools, so arguments are validated here.
const ImageToolArgumentsSchema = z.strictObject({
  prompt: z.string().refine((prompt) => prompt.trim().length > 0),
  transparent_background: z.boolean(),
  num_last_images_to_include: z.number().int().min(0).max(5),
});

function generatedImageFrom(
  event: Extract<OpenAINormalizedEvent, { type: "image" }>,
): GeneratedImage {
  const image: GeneratedImage = {
    data: event.base64,
    mediaType: event.mimeType,
    revisedPrompt: event.revisedPrompt ?? null,
  };

  if (event.generation) image.generation = event.generation;

  return image;
}

export type ImageFailureKind = "gate" | "not_called" | "incomplete";

export class ImageGenerationError extends Error {
  completedDriver?: GenerateResult;

  constructor(
    readonly kind: ImageFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ImageGenerationError";
  }
}

type TokenMetadata = {
  name: string;
  credentials: OpenAICredentials;
  quotaThreshold?: number | null;
  weight: number;
  active: boolean;
  generation: number;
};

type TokenSelection = { tokenId: number; metadata: TokenMetadata };

export type OpenAIDirectClientFactory = (
  options: OpenAIDirectClientOptions,
  tokenId: number,
) => Pick<OpenAIDirectClient, "responses"> & { close?: () => void };

type ClientEntry = {
  generation: number;
  client: Pick<OpenAIDirectClient, "responses"> & { close?: () => void };
  inFlight: number;
  retired: boolean;
};

export interface OpenAIDispatcherDependencies {
  clientFactory?: OpenAIDirectClientFactory;
  fetch?: typeof fetch;
  voiceClient?: OpenAIVoiceClient;
}

/** Realtime voice call with the media-endpoint token selection contract. */
export type OpenAIVoiceSelection = {
  preferredTokenId?: number;
  requirePreferredToken?: boolean;
};

export interface OpenAIVoiceDispatchResult<T> {
  result: T;
  tokenId: number;
  tokenName: string;
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;

  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

function activeSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function quotaMessage(entries: Array<{ name: string; threshold: number }>): string {
  const detail = entries.map((e) => `${e.name} (threshold ${e.threshold}%)`).join(", ");

  return detail
    ? `All openai tokens exceeded quota threshold: ${detail}`
    : "All openai tokens exceeded quota threshold";
}

function inputItems(req: GenerateRequest): JsonValue[] {
  const history = req.coldHistory ?? [];

  const content: OpenAIResponseItem[] = req.coldInput.map((input) => {
    if (input.type === "text") return { type: "input_text", text: input.text };

    if (input.type === "image") return { type: "input_image", image_url: input.url };

    if (input.type === "localImage") return { type: "input_image", image_url: input.path };

    return { type: "input_text", text: `${input.name}: ${input.path}` };
  });

  return [...history, { type: "message", role: "user", content }];
}

function imageReferences(req: GenerateRequest): OpenAIResponseItem[] {
  return inputItems(req).flatMap((item) => {
    if (!isJsonObject(item)) return [];
    const result = jsonString(item.result);

    if (item.type === "image_generation_call" && result !== undefined) {
      return [
        {
          type: "input_image",
          image_url: `data:${imageMimeType(result, item.output_format)};base64,${result}`,
        },
      ];
    }

    if (!Array.isArray(item.content)) return [];

    return item.content
      .filter(isJsonObject)
      .filter((part) => part.type === "input_image" || part.type === "image_url");
  });
}

type OpenAIReasoning = NonNullable<OpenAIResponsesOptions["reasoning"]>;

function asReasoning(req: GenerateRequest): OpenAIReasoning | undefined {
  if (req.thinking === false) return { effort: "none" };

  const summary =
    req.reasoningSummary && req.reasoningSummary !== "none" ? req.reasoningSummary : undefined;

  const effort =
    resolveOpenAIEffort(req.model ?? "", req.effort) ?? (req.thinking === true ? "low" : undefined);

  if (!effort && !summary) return undefined;

  const reasoning: OpenAIReasoning = {};

  if (effort) reasoning.effort = effort;

  if (summary) reasoning.summary = summary;

  return reasoning;
}

const AUTO_IMAGE_INSTRUCTIONS =
  "Use generate_image when image generation or editing is needed; otherwise reply with text. Call it at most once per response. Supply a complete, self-contained prompt with all relevant conversation instructions. Set transparent_background to true only when a transparent background is requested. Set num_last_images_to_include to 0 for a new image without references. For editing or reference-based generation, choose the smallest number of recent conversation images that includes all needed references, at most 5. References retain their chronological order. Do not select images for an unrelated new request.";

const AUTO_IMAGE_TOOL: OpenAIResponseItem = {
  type: "function",
  name: IMAGE_TOOL,
  description:
    "Generate or edit an image, optionally with a transparent background or recent conversation images as references.",
  // Astra's subscription backend rejects strict tools; validate arguments locally.
  strict: false,
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        minLength: 1,
        description: "Complete, self-contained instructions for the image generation or edit.",
      },
      transparent_background: { type: "boolean" },
      num_last_images_to_include: { type: "integer", minimum: 0, maximum: 5 },
    },
    required: ["prompt", "transparent_background", "num_last_images_to_include"],
    additionalProperties: false,
  },
};

function requestOptions(req: GenerateRequest): OpenAIResponsesOptions {
  const { outputFormat, ...imageControls } = req.imageGenerationOptions ?? {};
  const auto = req.imageGeneration === "auto";

  if (auto && req.outputSchema) {
    throw new ImageGenerationError(
      "gate",
      "Automatic image generation does not support structured output or external tools",
    );
  }

  if (auto && outputFormat && outputFormat !== "png") {
    throw new ImageGenerationError("gate", "Automatic image generation only supports PNG output");
  }

  const options: OpenAIResponsesOptions = { model: req.model ?? "", history: inputItems(req) };

  if (req.systemPrompt) options.instructions = req.systemPrompt;

  if (auto) {
    options.instructions = [req.systemPrompt, AUTO_IMAGE_INSTRUCTIONS].filter(Boolean).join("\n\n");
    options.parallelToolCalls = false;
    options.tools = [AUTO_IMAGE_TOOL];
  }

  const reasoning = asReasoning(req);

  if (reasoning) options.reasoning = reasoning;

  if (req.verbosity) options.verbosity = req.verbosity;

  if (req.serviceTier) {
    options.serviceTier = req.serviceTier === "fast" ? "priority" : req.serviceTier;
  }

  if (req.promptCacheKey) options.promptCacheKey = req.promptCacheKey;

  if (req.outputSchema) options.outputSchema = { schema: req.outputSchema };

  if (req.imageGeneration && !auto) {
    if (req.imageGenerationOptions) {
      const controls: OpenAIResponseItem = { ...imageControls };

      if (outputFormat) controls.output_format = outputFormat;
      options.imageGeneration = controls;
    } else {
      options.imageGeneration = true;
    }
  }

  return options;
}

// quota와 cache affinity로 토큰을 선택해 HTTPS/WS로 전송한다. 로컬 동시성 제한은 없다.
export class OpenAIDispatcher implements ProviderDispatcher {
  readonly tokenMetadata = new Map<number, TokenMetadata>();
  readonly transportKind: OpenAITransportKind;
  readonly rateLimitsCache = new Map<number, OpenAIRateLimitsWithMeta & { generation: number }>();
  readonly pendingRateLimits = new Map<
    number,
    { token: TokenMetadata; generation: number; promise: Promise<OpenAIRateLimitsWithMeta> }
  >();
  readonly clients = new Map<number, ClientEntry>();
  readonly retiredClients = new Set<ClientEntry>();
  static readonly RATE_LIMITS_CACHE_TTL = 60_000;

  readonly selector = new SmoothWeightedRoundRobin();
  readonly clientFactory: OpenAIDirectClientFactory;
  readonly fetchImpl: typeof fetch;
  readonly voiceClient: OpenAIVoiceClient;
  readonly quotaBlocked = new Set<number>();
  inFlight = 0;

  constructor(
    transportKind: OpenAITransportKind = resolveOpenAITransportKind(),
    dependencies: OpenAIDispatcherDependencies = {},
  ) {
    this.transportKind = transportKind;
    this.clientFactory =
      dependencies.clientFactory ?? ((options) => new OpenAIDirectClient(options));
    this.fetchImpl = dependencies.fetch ?? fetch;
    this.voiceClient = dependencies.voiceClient ?? new OpenAIVoiceClient({ fetch: this.fetchImpl });
  }

  // ---- Realtime voice (speech-to-text, text-to-speech) ----------------------

  async transcribe(
    request: OpenAITranscribeRequest & OpenAIVoiceSelection,
  ): Promise<OpenAIVoiceDispatchResult<OpenAITranscription>> {
    const { preferredTokenId, requirePreferredToken, ...voiceRequest } = request;

    return this.runVoice(
      { preferredTokenId, requirePreferredToken },
      request.signal,
      (credentials) => this.voiceClient.transcribe(credentials, voiceRequest),
    );
  }

  async speak(
    request: OpenAISpeakRequest & OpenAIVoiceSelection,
  ): Promise<OpenAIVoiceDispatchResult<OpenAISpeechResult>> {
    const { preferredTokenId, requirePreferredToken, ...voiceRequest } = request;

    return this.runVoice(
      { preferredTokenId, requirePreferredToken },
      request.signal,
      (credentials) => this.voiceClient.speak(credentials, voiceRequest),
    );
  }

  /**
   * Selects a token, runs the realtime call, and on one 401 refreshes that token's credentials and
   * retries once (as the Responses transports do). Any other failure propagates: a realtime
   * session that failed may already have consumed audio tokens.
   */
  async runVoice<T>(
    selection: OpenAIVoiceSelection,
    signal: AbortSignal | undefined,
    call: (credentials: OpenAIDirectCredentials) => Promise<T>,
  ): Promise<OpenAIVoiceDispatchResult<T>> {
    const active = signal ?? new AbortController().signal;

    const selected = await this.selectToken(
      selection.preferredTokenId,
      selection.requirePreferredToken ?? false,
      active,
    );

    const { tokenId, metadata } = selected;

    let credentials: OpenAIDirectCredentials = {
      accessToken: metadata.credentials.accessToken,
      accountId: metadata.credentials.accountId,
    };

    for (let attempt = 0; ; attempt++) {
      try {
        const result = await call(credentials);
        this.invalidateRateLimitsCache(tokenId);

        return { result, tokenId, tokenName: metadata.name };
      } catch (error) {
        if (attempt === 0 && error instanceof Error && isUnauthorizedRealtimeError(error)) {
          credentials = await this.refreshCredentials(tokenId);
          continue;
        }

        throw error;
      }
    }
  }

  async start(): Promise<void> {
    const { rows } = await TokenModel.findMany("A");

    for (const row of rows) {
      if (row.provider !== "openai") continue;

      if (!isOpenAICredentials(row.credentials)) {
        logger.warn(`skipping token ${row.name}: credentials are not OpenAI OAuth credentials`);
        continue;
      }

      this.setToken(row.id, row.name, row.credentials, row.quota_threshold, row.weight, row.active);
    }

    logger.info(`started direct OpenAI runtime with ${this.tokenMetadata.size} tokens`);
  }

  async stop(): Promise<void> {
    this.clients.forEach(({ client }) => client.close?.());
    this.clients.clear();
    this.retiredClients.forEach((entry) => entry.client.close?.());
    this.retiredClients.clear();
    this.tokenMetadata.clear();
    this.rateLimitsCache.clear();
    this.quotaBlocked.clear();
    this.selector.resetScores();
  }

  async onTokenAdded(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): Promise<void> {
    this.setToken(id, name, credentials, quotaThreshold, weight, true);
  }

  async onTokenUpdated(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): Promise<void> {
    const old = this.tokenMetadata.get(id);
    this.setToken(id, name, credentials, quotaThreshold, weight, old?.active ?? true);
  }

  async onTokenRemoved(id: number): Promise<void> {
    this.retireClient(id);
    this.tokenMetadata.delete(id);
    this.selector.removeToken(id);
    this.invalidateRateLimitsCache(id);
    this.quotaBlocked.delete(id);
  }

  onTokenDeactivated(id: number): void {
    const token = this.tokenMetadata.get(id);

    if (token) token.active = false;
    this.selector.resetScores();
  }

  onTokenActivated(id: number): void {
    const token = this.tokenMetadata.get(id);

    if (token) token.active = true;
    this.selector.resetScores();
  }

  async replaceTokens(
    rows: Array<{
      id: number;
      name: string;
      credentials: OpenAICredentials;
      quotaThreshold?: number | null;
      weight: number;
    }>,
  ): Promise<void> {
    const ids = new Set(rows.map((r) => r.id));

    for (const id of this.tokenMetadata.keys()) if (!ids.has(id)) await this.onTokenRemoved(id);

    for (const row of rows)
      await this.onTokenUpdated(row.id, row.name, row.credentials, row.quotaThreshold, row.weight);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.run(req);
  }

  async generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void> {
    if (req.imageGeneration)
      throw new ImageGenerationError(
        "gate",
        "image generation is not supported on the streaming path",
      );

    try {
      cb.onComplete(await this.run(req, cb.onDelta));
    } catch (error) {
      cb.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async run(req: GenerateRequest, onDelta?: (text: string) => void): Promise<GenerateResult> {
    if (req.thinking === false) {
      const model = req.model ?? "";

      if (!THINKING_OFF_MODELS.has(model)) {
        const reason =
          model === "gpt-6-astra" || model === "gpt-6.1-sol"
            ? "the subscription backend requires thinking"
            : "thinking-off support has not been verified on the subscription backend";

        throw new ThinkingValidationError(
          `thinking:false is unavailable for OpenAI model ${model || "<default>"}: ${reason}`,
        );
      }
    }

    const signal = activeSignal(req.abortSignal, req.timeoutMs);

    if (signal.aborted) throw abortError(signal);

    const selection = await this.selectToken(
      req.preferredTokenId,
      req.requirePreferredToken ?? false,
      signal,
    );

    this.inFlight++;

    try {
      if (signal.aborted) throw abortError(signal);

      return await this.runDirect(selection, { ...req, abortSignal: signal }, onDelta);
    } finally {
      this.inFlight--;
    }
  }

  async runDirect(
    selection: TokenSelection,
    req: GenerateRequest,
    onDelta?: (text: string) => void,
  ): Promise<GenerateResult> {
    const startedAt = Date.now();
    let firstDeltaAt: number | undefined;
    let text = "";
    req.onProgress?.({ tokenName: selection.metadata.name });

    const markFirstDelta = () => {
      if (firstDeltaAt !== undefined) return;
      firstDeltaAt = Date.now();
      req.onProgress?.({ ttftMs: firstDeltaAt - startedAt });
    };

    let outputMessageAccepted = false;
    const messagePhases = new Map<string, string>();
    const streamedMessageIds = new Set<string>();

    let usage = {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningOutputTokens: 0,
    };

    const images: GeneratedImage[] = [];
    let imageAttempted = false;
    const auto = req.imageGeneration === "auto";
    const imageCalls = new Map<string, ImageToolArguments>();
    const imageCallIds = new Set<JsonValue | undefined>();
    let imageToolAttempted = false;
    let driverCompleted = false;
    let servingModel = req.model ?? "";
    const metadata = selection.metadata;

    const driverResult = (): GenerateResult => {
      const result: GenerateResult = {
        text,
        tokenName: metadata.name,
        usage,
        durationMs: Date.now() - startedAt,
        ttftMs: firstDeltaAt === undefined ? null : firstDeltaAt - startedAt,
        model: servingModel,
        threadCoord: {
          workerId: selection.tokenId,
          threadId: req.promptCacheKey ?? "",
          epoch: -1,
        },
      };

      if (servingModel !== req.model) result.requestedModel = req.model;

      return result;
    };

    const clientEntry = this.acquireClient(selection);

    try {
      for await (const event of clientEntry.client.responses(
        requestOptions(req),
        req.abortSignal,
      )) {
        const itemId = event.type === "output-item" ? jsonString(event.item.id) : undefined;
        const itemPhase = event.type === "output-item" ? jsonString(event.item.phase) : undefined;

        if (
          req.stopAfterOutputMessage &&
          event.type === "output-item" &&
          event.item.type === "message" &&
          itemId !== undefined &&
          itemPhase !== undefined
        ) {
          messagePhases.set(itemId, itemPhase);
        }

        if (event.type === "text-delta") {
          if (outputMessageAccepted) continue;

          if (req.stopAfterOutputMessage && event.itemId) {
            // Buffer commentary/unclassified messages until their completed item.
            // Known final answers retain incremental streaming.
            if (messagePhases.get(event.itemId) !== "final_answer") continue;
            streamedMessageIds.add(event.itemId);
          }

          markFirstDelta();
          text += event.text;
          onDelta?.(event.text);
        } else if (
          event.type === "output-item" &&
          event.completed &&
          event.item.type === "message" &&
          !outputMessageAccepted &&
          req.stopAfterOutputMessage &&
          Array.isArray(event.item.content)
        ) {
          const messageText = event.item.content
            .flatMap((part) => {
              const partText =
                isJsonObject(part) && part.type === "output_text"
                  ? jsonString(part.text)
                  : undefined;

              return partText === undefined ? [] : [partText];
            })
            .join("");

          // A valid client tool request ends this application turn. Later answers cannot
          // know its result yet. Never split/repair malformed JSON within a message.
          const phase = itemPhase;

          if (messageText) outputMessageAccepted = req.stopAfterOutputMessage(messageText, phase);

          if (
            itemId !== undefined &&
            !streamedMessageIds.has(itemId) &&
            (phase !== "commentary" || outputMessageAccepted) &&
            messageText
          ) {
            markFirstDelta();
            text += messageText;
            onDelta?.(messageText);
            streamedMessageIds.add(itemId);
          }
        } else if (event.type === "image") {
          if (auto)
            throw new ImageGenerationError("incomplete", "Unexpected hosted image generation");
          imageAttempted = true;
          images.push(generatedImageFrom(event));
        } else if (event.type === "output-item" && event.item.type === "image_generation_call") {
          if (auto)
            throw new ImageGenerationError("incomplete", "Unexpected hosted image generation");
          imageAttempted = true;
        } else if (auto && event.type === "output-item" && event.item.type === "function_call") {
          if (event.item.name !== IMAGE_TOOL) {
            throw new ImageGenerationError("incomplete", "Unexpected automatic image tool call");
          }

          imageToolAttempted = true;
          imageCallIds.add(event.item.call_id);

          if (!event.completed) continue;
          const id = jsonString(event.item.call_id);
          const rawArguments = jsonString(event.item.arguments);
          let decoded: JsonValue;

          try {
            if (rawArguments === undefined) throw new Error("missing arguments");
            // JSON.parse without a reviver yields only JSON values.
            decoded = JSON.parse(rawArguments);
          } catch {
            throw new ImageGenerationError("incomplete", "Invalid image tool arguments");
          }

          const parsedArgs = ImageToolArgumentsSchema.safeParse(decoded);

          if (!id || !parsedArgs.success) {
            throw new ImageGenerationError("incomplete", "Invalid image tool arguments");
          }

          const args = parsedArgs.data;

          const previous = imageCalls.get(id);

          if (
            previous &&
            (previous.prompt !== args.prompt ||
              previous.transparent_background !== args.transparent_background ||
              previous.num_last_images_to_include !== args.num_last_images_to_include)
          ) {
            throw new ImageGenerationError("incomplete", "Conflicting image tool calls");
          }

          imageCalls.set(id, {
            prompt: args.prompt,
            transparent_background: args.transparent_background,
            num_last_images_to_include: args.num_last_images_to_include,
          });
        } else if (event.type === "completed") {
          const imageUsage = event.imageGeneration?.usage;

          // The backend also reports all-zero image usage for text-only responses.
          if (
            auto &&
            imageUsage &&
            (imageUsage.input_tokens > 0 ||
              imageUsage.output_tokens > 0 ||
              imageUsage.total_tokens > 0)
          )
            throw new ImageGenerationError("incomplete", "Unexpected hosted image generation");
          driverCompleted = true;
          servingModel = event.model ?? servingModel;

          if (event.usage) {
            usage = {
              totalTokens: event.usage.totalTokens,
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              cachedInputTokens: event.usage.cachedInputTokens,
              reasoningOutputTokens: event.usage.reasoningTokens,
            };
          }

          if (event.imageGeneration) {
            const hostedImages = images.filter(
              (image) => image.generation?.route === "codex-responses",
            );

            for (const [index, image] of hostedImages.entries()) {
              const generation: ImageGenerationMetadata = {
                route: "codex-responses",
                ...image.generation,
              };

              // The image's own model wins; the response-level model only fills a gap.
              if (generation.model === undefined && event.imageGeneration.model) {
                generation.model = event.imageGeneration.model;
              }

              // Tool usage covers the whole response, not each returned image.
              if (index === 0 && event.imageGeneration.usage) {
                generation.usage = event.imageGeneration.usage;
              }

              image.generation = generation;
            }
          }
        } else if (event.type === "error") {
          if (req.imageGeneration)
            throw new ImageGenerationError("incomplete", event.error.message);
          throw event.error;
        }
      }

      if (auto && imageToolAttempted) {
        if (!driverCompleted || imageCalls.size !== 1 || imageCallIds.size !== 1) {
          throw new ImageGenerationError("incomplete", "Expected one completed image tool call");
        }

        if (req.abortSignal?.aborted) throw abortError(req.abortSignal);
        const args = [...imageCalls.values()][0]!;
        const referenceCount = args.num_last_images_to_include;
        const references = referenceCount ? imageReferences(req) : [];

        if (referenceCount > references.length) {
          throw new ImageGenerationError(
            "incomplete",
            "Requested image references are unavailable",
          );
        }

        let imageCompleted = false;

        for await (const event of clientEntry.client.responses(
          {
            model: "gpt-image-2",
            history: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: args.prompt },
                  ...(referenceCount ? references.slice(-referenceCount) : []),
                ],
              },
            ],
            imageGeneration: {
              quality: req.imageGenerationOptions?.quality,
              size: req.imageGenerationOptions?.size,
              output_format: "png",
              background: args.transparent_background ? "transparent" : "opaque",
            },
          },
          req.abortSignal,
        )) {
          if (event.type === "image") images.push(generatedImageFrom(event));
          else if (event.type === "completed") imageCompleted = true;
          else if (event.type === "error")
            throw new ImageGenerationError("incomplete", event.error.message, {
              cause: event.error,
            });
        }

        imageAttempted = true;

        if (!imageCompleted)
          throw new ImageGenerationError("incomplete", "Image generation did not complete");
      }

      if (auto && imageAttempted && !driverCompleted)
        throw new ImageGenerationError("incomplete", "Image generation response did not complete");

      if (req.abortSignal?.aborted) throw abortError(req.abortSignal);

      if ((req.imageGeneration === true || (auto && imageAttempted)) && images.length === 0) {
        throw new ImageGenerationError(
          imageAttempted ? "incomplete" : "not_called",
          imageAttempted
            ? "image generation did not complete"
            : "model did not call image generation",
        );
      }
    } catch (error) {
      if (auto && driverCompleted && imageToolAttempted) {
        const failure =
          error instanceof ImageGenerationError
            ? error
            : new ImageGenerationError(
                "incomplete",
                error instanceof Error ? error.message : String(error),
                { cause: error },
              );

        if (error instanceof Error) failure.name = error.name;
        // Only the completed chat stage is chargeable here; discard partial image output.
        failure.completedDriver = driverResult();
        throw failure;
      }

      throw error;
    } finally {
      this.releaseClient(clientEntry);
    }

    const result = driverResult();

    if (images.length) result.images = images;

    return result;
  }

  /** 세대가 바뀐 client 는 사용 중인 요청이 끝난 뒤에 닫는다. */
  acquireClient(selection: TokenSelection): ClientEntry {
    const metadata = selection.metadata;
    let entry = this.clients.get(selection.tokenId);

    if (entry && entry.generation !== metadata.generation) {
      this.retireClient(selection.tokenId);
      entry = undefined;
    }

    if (!entry) {
      const client = this.clientFactory(
        {
          credentials: {
            accessToken: metadata.credentials.accessToken,
            accountId: metadata.credentials.accountId,
          },
          transportKind: this.transportKind,
          fetch: this.fetchImpl,
          refreshCredentials: () => this.refreshCredentials(selection.tokenId),
        },
        selection.tokenId,
      );

      entry = { generation: metadata.generation, client, inFlight: 0, retired: false };
      this.clients.set(selection.tokenId, entry);
    }

    entry.inFlight++;

    return entry;
  }

  releaseClient(entry: ClientEntry): void {
    entry.inFlight = Math.max(0, entry.inFlight - 1);

    if (entry.retired && entry.inFlight === 0) {
      this.retiredClients.delete(entry);
      entry.client.close?.();
    }
  }

  retireClient(tokenId: number): void {
    const entry = this.clients.get(tokenId);

    if (!entry) return;
    this.clients.delete(tokenId);
    entry.retired = true;

    if (entry.inFlight === 0) entry.client.close?.();
    else this.retiredClients.add(entry);
  }

  // 선호 토큰이 quota를 통과하면 다른 토큰 조회와 weighted 상태 변경을 생략한다.
  async selectToken(
    preferredTokenId: number | undefined,
    requirePreferredToken: boolean,
    signal: AbortSignal,
  ): Promise<TokenSelection> {
    if (preferredTokenId !== undefined) {
      const preferred = this.tokenMetadata.get(preferredTokenId);

      if (preferred?.active && (await this.isQuotaEligible(preferredTokenId, preferred, signal))) {
        return { tokenId: preferredTokenId, metadata: preferred };
      }

      if (requirePreferredToken) {
        if (!preferred?.active) {
          throw new Error(`Preferred openai token ${preferredTokenId} is not available`);
        }

        const threshold = preferred.quotaThreshold;

        if (threshold !== null && threshold !== undefined) {
          throw new QuotaThresholdExceededError(
            quotaMessage([{ name: preferred.name, threshold }]),
          );
        }
      }
    }

    // 콜드 캐시에서 토큰 수만큼 조회 지연이 쌓이지 않도록 병렬 판정한다.
    const activeTokens = [...this.tokenMetadata.entries()].filter(([, token]) => token.active);

    const checks = await Promise.all(
      activeTokens.map(async ([id, token]) => ({
        id,
        token,
        eligible: await this.isQuotaEligible(id, token, signal),
      })),
    );

    const eligible = new Set(checks.filter((c) => c.eligible).map((c) => c.id));

    if (eligible.size === 0) {
      const over = checks.flatMap((c) => {
        const threshold = c.token.quotaThreshold;

        return c.eligible || threshold === null || threshold === undefined
          ? []
          : [{ name: c.token.name, threshold }];
      });

      if (over.length) {
        logger.warn("quota_threshold gate: all_exceeded", {
          provider: "openai",
          overThresholdTokens: over,
        });
        throw new QuotaThresholdExceededError(quotaMessage(over));
      }

      throw new Error("NO_OPENAI_WORKERS");
    }

    const selected = this.selector.select(eligible);
    const metadata = selected !== null ? this.tokenMetadata.get(selected) : undefined;

    if (selected === null || !metadata) throw new Error("NO_OPENAI_WORKERS");

    return { tokenId: selected, metadata };
  }

  setToken(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold: number | null | undefined,
    weight: number,
    active: boolean,
  ): void {
    const old = this.tokenMetadata.get(id);

    if (old) {
      Object.assign(old, {
        name,
        credentials,
        quotaThreshold,
        weight,
        active,
        generation: old.generation + 1,
      });
    } else {
      this.tokenMetadata.set(id, {
        name,
        credentials,
        quotaThreshold,
        weight,
        active,
        generation: 1,
      });
    }

    this.selector.setToken(id, weight);
    this.invalidateRateLimitsCache(id);
    this.quotaBlocked.delete(id);
  }

  async getRateLimitsByTokenId(
    tokenId: number,
    signal?: AbortSignal,
  ): Promise<OpenAIRateLimitsWithMeta> {
    const token = this.tokenMetadata.get(tokenId);

    if (!token) throw new Error(`openai token ${tokenId} not found`);
    const generation = token.generation;
    const cached = this.rateLimitsCache.get(tokenId);

    if (
      cached &&
      cached.generation === token.generation &&
      Date.now() - cached.cachedAt < OpenAIDispatcher.RATE_LIMITS_CACHE_TTL
    )
      return cached;

    // TTL 만료 시 조회를 공유한다. 최초 호출자의 abort로 실패해도 isQuotaEligible은 fail-open한다.
    const pending = this.pendingRateLimits.get(tokenId);

    if (pending?.token === token && pending.generation === generation) return pending.promise;

    const fetchPromise = (async () => {
      const result = await readOpenAIQuotaUsage({
        credentials: token.credentials,
        refreshCredentials: () => this.refreshCredentials(tokenId),
        fetch: this.fetchImpl,
        signal,
      });

      if (result.kind === "lookup_failed") throw new Error(result.reason);

      if (!result.raw) throw new Error("OpenAI quota response missing raw rate limits");
      const entry = { data: result.raw, cachedAt: Date.now(), generation };

      if (this.tokenMetadata.get(tokenId) === token && token.generation === generation) {
        this.rateLimitsCache.set(tokenId, entry);
      }

      return entry;
    })().finally(() => {
      if (this.pendingRateLimits.get(tokenId)?.promise === fetchPromise) {
        this.pendingRateLimits.delete(tokenId);
      }
    });

    this.pendingRateLimits.set(tokenId, { token, generation, promise: fetchPromise });

    return fetchPromise;
  }

  async refreshCredentials(tokenId: number) {
    const previous = this.tokenMetadata.get(tokenId);
    const generation = previous?.generation;
    const refreshed = await handleChatgptAuthTokensRefresh(tokenId);

    const credentials = {
      accessToken: refreshed.accessToken,
      accountId: refreshed.chatgptAccountId,
    };

    const current = this.tokenMetadata.get(tokenId);

    if (!current?.active) throw new Error(`openai token ${tokenId} is no longer active`);

    // A subscriber update may already contain newer credentials. Never overwrite it
    // with the result of a refresh that started against an older generation.
    if (current === previous && current.generation === generation) {
      current.credentials = { ...current.credentials, ...credentials };
      this.retireClient(tokenId);
      this.invalidateRateLimitsCache(tokenId);
    }

    return {
      accessToken: current.credentials.accessToken,
      accountId: current.credentials.accountId,
    };
  }

  async isQuotaEligible(id: number, token: TokenMetadata, signal?: AbortSignal): Promise<boolean> {
    if (token.quotaThreshold === null || token.quotaThreshold === undefined) return true;
    const generation = token.generation;
    const result = await readOpenAIQuotaUsage(async () => this.getRateLimitsByTokenId(id, signal));

    if (this.tokenMetadata.get(id) !== token || token.generation !== generation) return false;

    if (result.kind === "lookup_failed") {
      this.quotaBlocked.delete(id);
      logger.warn("quota_threshold gate: lookup_fail_open", {
        tokenId: id,
        tokenName: token.name,
        lookupReason: result.reason,
      });

      return true;
    }

    if (result.utilizationPct >= token.quotaThreshold) {
      if (!this.quotaBlocked.has(id))
        logger.info(
          `quota_threshold gate: over_threshold ${token.name}[${id}] (${result.utilizationPct}% >= ${token.quotaThreshold}%)`,
        );
      this.quotaBlocked.add(id);

      return false;
    }

    if (this.quotaBlocked.delete(id))
      logger.info(
        `quota_threshold gate: recovered ${token.name}[${id}] (${result.utilizationPct}% < ${token.quotaThreshold}%)`,
      );

    return true;
  }

  invalidateRateLimitsCache(id: number): void {
    this.rateLimitsCache.delete(id);
  }

  countActiveTokens(): number {
    return [...this.tokenMetadata.values()].filter((t) => t.active).length;
  }

  // 모니터링 폴링은 TTL 내 캐시만 읽고 fetch하지 않는다. 미조회 토큰은 usedPercent가 null이다.
  getQuotaSnapshot(): Array<{
    name: string;
    usedPercent: number | null;
    threshold: number | null;
    blocked: boolean;
    resetsAt: number | null;
  }> {
    const now = Date.now();

    return [...this.tokenMetadata.entries()]
      .map(([id, t]) => {
        const cached = this.rateLimitsCache.get(id);

        const fresh =
          cached !== undefined &&
          cached.generation === t.generation &&
          now - cached.cachedAt < OpenAIDispatcher.RATE_LIMITS_CACHE_TTL;

        const primary = fresh ? cached.data.rateLimits?.primary : undefined;

        return {
          name: t.name,
          usedPercent: primary?.usedPercent ?? null,
          threshold: t.quotaThreshold ?? null,
          blocked: this.quotaBlocked.has(id),
          // wham의 Unix 초를 epoch ms로 변환한다.
          resetsAt:
            primary?.resetsAt !== null && primary?.resetsAt !== undefined
              ? primary.resetsAt * 1000
              : null,
        };
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));
  }
}
