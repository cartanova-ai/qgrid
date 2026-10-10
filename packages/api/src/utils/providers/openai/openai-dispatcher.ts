import { getLogger } from "@logtape/logtape";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { TokenModel } from "../../../application/token/token.model";
import { type OpenAICredentials } from "../../../application/token/token.types";
import { resolveOpenAIEffort } from "../common/effort";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type GeneratedImage,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { SmoothWeightedRoundRobin } from "../common/smooth-weighted-round-robin";
import { ThinkingValidationError } from "../common/thinking";
import {
  type JsonValue,
  type OpenAIResponseItem,
  type OpenAIResponsesOptions,
} from "./openai-backend-protocol";
import { OpenAIDirectClient, type OpenAIDirectClientOptions } from "./openai-direct-client";
import { readOpenAIQuotaUsage, type OpenAIRateLimitsWithMeta } from "./openai-quota";
import { handleChatgptAuthTokensRefresh } from "./openai-refresh";
import { type OpenAITransportKind, resolveOpenAITransportKind } from "./openai-transport-config";

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
const TRANSPARENT_IMAGE_TOOL = "generate_transparent_image";

export type ImageFailureKind = "gate" | "not_called" | "incomplete";

export class ImageGenerationError extends Error {
  constructor(
    readonly kind: ImageFailureKind,
    message: string,
  ) {
    super(message);
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

function inputItems(req: GenerateRequest): OpenAIResponseItem[] {
  const history = (req.coldHistory ?? []) as OpenAIResponseItem[];
  const content: OpenAIResponseItem[] = req.coldInput.map((input) => {
    if (input.type === "text") return { type: "input_text", text: input.text };
    if (input.type === "image") return { type: "input_image", image_url: input.url };
    if (input.type === "localImage") return { type: "input_image", image_url: input.path };
    return { type: "input_text", text: `${input.name}: ${input.path}` };
  });
  return [...history, { type: "message", role: "user", content }];
}

function asReasoning(req: GenerateRequest): OpenAIResponsesOptions["reasoning"] | undefined {
  if (req.thinking === false) return { effort: "none" };
  const summary =
    req.reasoningSummary && req.reasoningSummary !== "none" ? req.reasoningSummary : undefined;
  const effort =
    resolveOpenAIEffort(req.model ?? "", req.effort) ?? (req.thinking === true ? "low" : undefined);
  if (!effort && !summary) return undefined;
  return {
    ...(effort ? { effort } : {}),
    ...(summary
      ? {
          summary: summary as NonNullable<OpenAIResponsesOptions["reasoning"]>["summary"],
        }
      : {}),
  };
}

function requestOptions(req: GenerateRequest): OpenAIResponsesOptions {
  const { outputFormat, ...imageControls } = req.imageGenerationOptions ?? {};
  const auto = req.imageGeneration === "auto";
  if (auto && req.outputSchema) {
    throw new ImageGenerationError(
      "gate",
      "Automatic image generation does not support structured output or external tools",
    );
  }
  return {
    model: req.model ?? "",
    ...(req.systemPrompt ? { instructions: req.systemPrompt } : {}),
    ...(auto
      ? {
          instructions: [
            req.systemPrompt,
            "Use image_generation for ordinary image generation or editing. Use generate_transparent_image only when a transparent background is requested. Text replies are allowed when no image is needed. Use only one kind of image tool per response, and at most one generate_transparent_image call.",
          ]
            .filter(Boolean)
            .join("\n\n"),
          parallelToolCalls: false,
          tools: [
            {
              type: "function",
              name: TRANSPARENT_IMAGE_TOOL,
              description:
                "Generate or edit an image with a transparent background using the conversation's reference images.",
              strict: true,
              parameters: {
                type: "object",
                properties: {
                  prompt: {
                    type: "string",
                    description:
                      "Complete instructions for the transparent image generation or edit.",
                  },
                },
                required: ["prompt"],
                additionalProperties: false,
              },
            },
          ],
        }
      : {}),
    history: inputItems(req),
    ...(asReasoning(req) ? { reasoning: asReasoning(req) } : {}),
    ...(req.verbosity ? { verbosity: req.verbosity as OpenAIResponsesOptions["verbosity"] } : {}),
    ...(req.serviceTier
      ? { serviceTier: req.serviceTier === "fast" ? "priority" : req.serviceTier }
      : {}),
    ...(req.promptCacheKey ? { promptCacheKey: req.promptCacheKey } : {}),
    ...(req.outputSchema ? { outputSchema: { schema: req.outputSchema as JsonValue } } : {}),
    ...(req.imageGeneration
      ? {
          imageGeneration: req.imageGenerationOptions
            ? {
                ...imageControls,
                ...(auto ? { background: "auto" } : {}),
                ...(outputFormat ? { output_format: outputFormat } : {}),
              }
            : true,
        }
      : {}),
  };
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
  }

  async start(): Promise<void> {
    const { rows } = await TokenModel.findMany("A");
    rows
      .filter((row) => row.provider === "openai")
      .forEach((row) => {
        this.setToken(
          row.id,
          row.name,
          row.credentials as OpenAICredentials,
          row.quota_threshold,
          row.weight,
          row.active,
        );
      });
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
      cb.onError(error as Error);
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
    const transparentCalls = new Map<string, string>();
    const transparentCallIds = new Set<unknown>();
    let transparentAttempted = false;
    let driverCompleted = false;
    let servingModel = req.model ?? "";
    const metadata = selection.metadata;
    const clientEntry = this.acquireClient(selection);
    try {
      for await (const event of clientEntry.client.responses(
        requestOptions(req),
        req.abortSignal,
      )) {
        if (
          req.stopAfterOutputMessage &&
          event.type === "output-item" &&
          event.item.type === "message" &&
          typeof event.item.id === "string" &&
          typeof event.item.phase === "string"
        ) {
          messagePhases.set(event.item.id, event.item.phase);
        }
        if (event.type === "text-delta") {
          if (outputMessageAccepted) continue;
          if (req.stopAfterOutputMessage && event.itemId) {
            // Buffer commentary/unclassified messages until their completed item.
            // Known final answers retain incremental streaming.
            if (messagePhases.get(event.itemId) !== "final_answer") continue;
            streamedMessageIds.add(event.itemId);
          }
          firstDeltaAt ??= Date.now();
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
            .filter((part) => part?.type === "output_text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("");
          // A valid client tool request ends this application turn. Later answers cannot
          // know its result yet. Never split/repair malformed JSON within a message.
          const phase = typeof event.item.phase === "string" ? event.item.phase : undefined;
          if (messageText) outputMessageAccepted = req.stopAfterOutputMessage(messageText, phase);
          if (
            typeof event.item.id === "string" &&
            !streamedMessageIds.has(event.item.id) &&
            (phase !== "commentary" || outputMessageAccepted) &&
            messageText
          ) {
            firstDeltaAt ??= Date.now();
            text += messageText;
            onDelta?.(messageText);
            streamedMessageIds.add(event.item.id);
          }
        } else if (event.type === "image") {
          imageAttempted = true;
          images.push({
            data: event.base64,
            mediaType: event.mimeType,
            revisedPrompt: event.revisedPrompt ?? null,
            ...(event.generation ? { generation: event.generation } : {}),
          });
        } else if (event.type === "output-item" && event.item.type === "image_generation_call") {
          imageAttempted = true;
        } else if (auto && event.type === "output-item" && event.item.type === "function_call") {
          if (event.item.name !== TRANSPARENT_IMAGE_TOOL) {
            throw new ImageGenerationError("incomplete", "Unexpected automatic image tool call");
          }
          transparentAttempted = true;
          transparentCallIds.add(event.item.call_id);
          if (!event.completed) continue;
          const id = event.item.call_id;
          let args: unknown;
          try {
            args = JSON.parse(String(event.item.arguments));
          } catch {
            throw new ImageGenerationError("incomplete", "Invalid transparent image arguments");
          }
          if (
            typeof id !== "string" ||
            !id ||
            !args ||
            typeof args !== "object" ||
            Array.isArray(args) ||
            Object.keys(args).length !== 1 ||
            !("prompt" in args) ||
            typeof args.prompt !== "string" ||
            !args.prompt.trim()
          ) {
            throw new ImageGenerationError("incomplete", "Invalid transparent image arguments");
          }
          if (transparentCalls.has(id) && transparentCalls.get(id) !== args.prompt) {
            throw new ImageGenerationError(
              "incomplete",
              "Conflicting transparent image tool calls",
            );
          }
          transparentCalls.set(id, args.prompt);
        } else if (event.type === "completed" && event.usage) {
          driverCompleted = true;
          servingModel = event.model ?? servingModel;
          usage = {
            totalTokens: event.usage.totalTokens,
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cachedInputTokens: event.usage.cachedInputTokens,
            reasoningOutputTokens: event.usage.reasoningTokens,
          };
        } else if (event.type === "completed") {
          driverCompleted = true;
          servingModel = event.model ?? servingModel;
        } else if (event.type === "error") {
          if (req.imageGeneration)
            throw new ImageGenerationError("incomplete", event.error.message);
          throw event.error;
        }
      }
      if (auto && transparentAttempted) {
        if (
          !driverCompleted ||
          transparentCalls.size !== 1 ||
          transparentCallIds.size !== 1 ||
          imageAttempted
        ) {
          throw new ImageGenerationError(
            "incomplete",
            "Expected one completed transparent image call without another image tool",
          );
        }
        if (req.abortSignal?.aborted) throw abortError(req.abortSignal);
        const prompt = [...transparentCalls.values()][0]!;
        let imageCompleted = false;
        for await (const event of clientEntry.client.responses(
          {
            model: req.model ?? "",
            ...(req.systemPrompt ? { instructions: req.systemPrompt } : {}),
            history: [
              ...inputItems(req),
              { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
            ],
            imageGeneration: {
              quality: req.imageGenerationOptions?.quality,
              size: req.imageGenerationOptions?.size,
              output_format: "png",
              background: "transparent",
            },
          },
          req.abortSignal,
        )) {
          if (event.type === "image")
            images.push({
              data: event.base64,
              mediaType: event.mimeType,
              revisedPrompt: event.revisedPrompt ?? null,
              ...(event.generation ? { generation: event.generation } : {}),
            });
          else if (event.type === "completed") imageCompleted = true;
          else if (event.type === "error")
            throw new ImageGenerationError("incomplete", event.error.message);
        }
        imageAttempted = true;
        if (!imageCompleted)
          throw new ImageGenerationError(
            "incomplete",
            "Transparent image generation did not complete",
          );
      }
      if (auto && imageAttempted && !driverCompleted)
        throw new ImageGenerationError("incomplete", "Image generation response did not complete");
      if (req.abortSignal?.aborted) throw abortError(req.abortSignal);
    } finally {
      this.releaseClient(clientEntry);
    }
    if ((req.imageGeneration === true || (auto && imageAttempted)) && images.length === 0) {
      throw new ImageGenerationError(
        imageAttempted ? "incomplete" : "not_called",
        imageAttempted
          ? "image generation did not complete"
          : "model did not call image generation",
      );
    }
    return {
      text,
      tokenName: metadata.name,
      usage,
      durationMs: Date.now() - startedAt,
      ttftMs: firstDeltaAt === undefined ? null : firstDeltaAt - startedAt,
      model: servingModel,
      ...(servingModel !== req.model ? { requestedModel: req.model } : {}),
      threadCoord: { workerId: selection.tokenId, threadId: req.promptCacheKey ?? "", epoch: -1 },
      ...(images.length ? { images } : {}),
    };
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
    const checks = await Promise.all(
      [...this.tokenMetadata.entries()]
        .filter(([, token]) => token.active)
        .map(async ([id, token]) => ({
          id,
          token,
          eligible: await this.isQuotaEligible(id, token, signal),
        })),
    );
    const eligible = new Set(checks.filter((c) => c.eligible).map((c) => c.id));
    if (eligible.size === 0) {
      const over = checks
        .filter(
          (c) =>
            !c.eligible && c.token.quotaThreshold !== null && c.token.quotaThreshold !== undefined,
        )
        .map((c) => ({ name: c.token.name, threshold: c.token.quotaThreshold as number }));
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
        ...(signal ? { signal } : {}),
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
