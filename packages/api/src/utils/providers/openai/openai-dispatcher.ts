import {
  type OpenAIDecisionRequest,
  type OpenAIDecisionResult,
} from "../../../application/qgrid/qgrid.types";
import { type OpenAICredentials } from "../../../application/token/token.types";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type MediaDispatchResult,
  type MediaTokenSelection,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { createOpenAIDecision } from "./openai-decisions";
import { OpenAIDirectClient } from "./openai-direct-client";
import { type OpenAIRateLimitsWithMeta } from "./openai-quota";
import { type OpenAIDirectClientFactory, OpenAIResponsesRuntime } from "./openai-responses-runtime";
import { OpenAITokenPool } from "./openai-token-pool";
import { type OpenAITransportKind, resolveOpenAITransportKind } from "./openai-transport-config";
import {
  type OpenAILiveCall,
  type OpenAILiveCallRequest,
  type OpenAISpeakRequest,
  type OpenAISpeechResult,
  type OpenAITranscribeRequest,
  type OpenAITranscription,
  OpenAIVoiceClient,
} from "./openai-voice-client";

export interface OpenAIDispatcherDependencies {
  clientFactory?: OpenAIDirectClientFactory;
  fetch?: typeof fetch;
  voiceClient?: OpenAIVoiceClient;
}

/**
 * The OpenAI provider surface: one token pool shared by Responses (`openai-responses-runtime.ts`),
 * realtime voice (`openai-voice-client.ts`), and Decisions (`openai-decisions.ts`).
 */
export class OpenAIDispatcher implements ProviderDispatcher {
  // Callers go through the methods below; the parts are not a second way in.
  private readonly pool: OpenAITokenPool;
  private readonly responses: OpenAIResponsesRuntime;
  readonly voiceClient: OpenAIVoiceClient;

  constructor(
    transportKind: OpenAITransportKind = resolveOpenAITransportKind(),
    dependencies: OpenAIDispatcherDependencies = {},
  ) {
    const fetchImpl = dependencies.fetch ?? fetch;
    this.voiceClient = dependencies.voiceClient ?? new OpenAIVoiceClient({ fetch: fetchImpl });
    this.pool = new OpenAITokenPool(fetchImpl);

    this.responses = new OpenAIResponsesRuntime(
      this.pool,
      transportKind,
      dependencies.clientFactory ?? ((options) => new OpenAIDirectClient(options)),
    );
  }

  // ---- Lifecycle and token pool ---------------------------------------------

  async start(): Promise<void> {
    await this.pool.load();
  }

  async stop(): Promise<void> {
    this.voiceClient.closeLiveSessions();
    this.responses.close();
    this.pool.clear();
  }

  async onTokenAdded(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): Promise<void> {
    return this.pool.onTokenAdded(id, name, credentials, quotaThreshold, weight);
  }

  async onTokenUpdated(
    id: number,
    name: string,
    credentials: OpenAICredentials,
    quotaThreshold?: number | null,
    weight = 1,
  ): Promise<void> {
    return this.pool.onTokenUpdated(id, name, credentials, quotaThreshold, weight);
  }

  async onTokenRemoved(id: number): Promise<void> {
    return this.pool.onTokenRemoved(id);
  }

  onTokenDeactivated(id: number): void {
    this.pool.onTokenDeactivated(id);
  }

  onTokenActivated(id: number): void {
    this.pool.onTokenActivated(id);
  }

  async replaceTokens(rows: Parameters<OpenAITokenPool["replaceTokens"]>[0]): Promise<void> {
    return this.pool.replaceTokens(rows);
  }

  async getRateLimitsByTokenId(
    tokenId: number,
    signal?: AbortSignal,
  ): Promise<OpenAIRateLimitsWithMeta> {
    return this.pool.getRateLimitsByTokenId(tokenId, signal);
  }

  countActiveTokens(): number {
    return this.pool.countActiveTokens();
  }

  getQuotaSnapshot(): ReturnType<OpenAITokenPool["getQuotaSnapshot"]> {
    return this.pool.getQuotaSnapshot();
  }

  // ---- Responses (text, tools, chat images) -----------------------------------

  /** Responses requests in flight; monitoring reads it. */
  get inFlight(): number {
    return this.responses.inFlight;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.responses.run(req);
  }

  async generateStream(req: GenerateRequest, cb: GenerateStreamCallbacks): Promise<void> {
    return this.responses.generateStream(req, cb);
  }

  // ---- Realtime voice (speech-to-text, text-to-speech) ----------------------

  async transcribe(
    request: OpenAITranscribeRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<OpenAITranscription>> {
    const { preferredTokenId, requirePreferredToken, ...voiceRequest } = request;

    return this.pool.runWithToken(
      { preferredTokenId, requirePreferredToken },
      request.signal,
      (credentials) => this.voiceClient.transcribe(credentials, voiceRequest),
    );
  }

  async speak(
    request: OpenAISpeakRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<OpenAISpeechResult>> {
    const { preferredTokenId, requirePreferredToken, ...voiceRequest } = request;

    return this.pool.runWithToken(
      { preferredTokenId, requirePreferredToken },
      request.signal,
      (credentials) => this.voiceClient.speak(credentials, voiceRequest),
    );
  }

  async startLive(
    request: OpenAILiveCallRequest & MediaTokenSelection,
  ): Promise<MediaDispatchResult<OpenAILiveCall>> {
    const { preferredTokenId, requirePreferredToken, ...liveRequest } = request;

    return this.pool.runWithToken(
      { preferredTokenId, requirePreferredToken },
      request.signal,
      (credentials) => this.voiceClient.createLiveCall(credentials, liveRequest),
    );
  }

  // ---- Native Decisions ----------------------------------------------------

  async decide(
    request: OpenAIDecisionRequest & MediaTokenSelection & { signal?: AbortSignal },
  ): Promise<MediaDispatchResult<OpenAIDecisionResult>> {
    const { preferredTokenId, requirePreferredToken, signal, ...decision } = request;

    return this.pool.runWithToken(
      { preferredTokenId, requirePreferredToken },
      signal,
      (credentials) => createOpenAIDecision(credentials, decision, signal, this.pool.fetchImpl),
    );
  }
}
