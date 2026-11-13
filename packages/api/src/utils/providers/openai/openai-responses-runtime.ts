import { z } from "zod";

import { resolveOpenAIEffort } from "../common/effort";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type GeneratedImage,
} from "../common/provider-dispatcher";
import { isJsonObject, jsonString } from "../common/provider-types";
import { ThinkingValidationError } from "../common/thinking";
import {
  imageMimeType,
  type JsonValue,
  type OpenAINormalizedEvent,
  type OpenAIResponseItem,
  type OpenAIResponsesOptions,
} from "./openai-backend-protocol";
import { type OpenAIDirectClient, type OpenAIDirectClientOptions } from "./openai-direct-client";
import { type OpenAITokenPool, type TokenSelection } from "./openai-token-pool";
import { type OpenAITransportKind } from "./openai-transport-config";

// Verified with the subscription Responses backend; public API support is not sufficient.
const THINKING_OFF_MODELS = new Set([
  "gpt-6.1-terra",
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

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;

  return reason instanceof Error ? reason : new DOMException("Aborted", "AbortError");
}

function activeSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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

  // ultra is a Codex client mode (sub-agent delegation), not a wire value; the backend accepts up to max.
  if (effort) reasoning.effort = effort === "ultra" ? "max" : effort;

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

/**
 * Hosted web search as Codex sends it (tools/src/tool_spec.rs); `external_web_access` asks for
 * live search rather than the cached index. Answered on the subscription route (2026-11-10).
 */
const WEB_SEARCH_TOOL: OpenAIResponseItem = { type: "web_search", external_web_access: true };

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

  // Function tools reach OpenAI through qgrid's tool emulation; only hosted search goes native.
  if (req.tools?.some((tool) => tool.type === "web_search")) {
    options.tools = [...(options.tools ?? []), WEB_SEARCH_TOOL];
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

/**
 * Codex Responses on the shared token pool: text, tool emulation, and chat-driven images. Keeps
 * one direct client per token and retires it when the pool invalidates that token.
 */
export class OpenAIResponsesRuntime {
  readonly clients = new Map<number, ClientEntry>();
  readonly retiredClients = new Set<ClientEntry>();
  inFlight = 0;

  constructor(
    readonly pool: OpenAITokenPool,
    readonly transportKind: OpenAITransportKind,
    readonly clientFactory: OpenAIDirectClientFactory,
  ) {
    // A token whose credentials were refreshed or removed must not keep its client.
    pool.onTokenInvalidated((tokenId) => this.retireClient(tokenId));
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

    const selection = await this.pool.selectToken(
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
          if (auto) throw new ImageGenerationError("incomplete", "Unexpected image output");
          imageAttempted = true;
          images.push(generatedImageFrom(event));
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
          fetch: this.pool.fetchImpl,
          refreshCredentials: () => this.pool.refreshCredentials(selection.tokenId),
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

  /** Closes every client, including retired ones still serving a request. */
  close(): void {
    this.clients.forEach(({ client }) => client.close?.());
    this.clients.clear();
    this.retiredClients.forEach((entry) => entry.client.close?.());
    this.retiredClients.clear();
  }
}
