import { randomUUID } from "node:crypto";

import { QuotaThresholdExceededError } from "../../../application/qgrid/qgrid.types";
import { deactivateAuthDeadToken } from "../../../application/qgrid/token-death";
import { TokenModel } from "../../../application/token/token.model";
import { AntigravityCredentials } from "../../../application/token/token.types";
import { resolveAntigravityEffort } from "../common/effort";
import {
  type GenerateRequest,
  type GenerateResult,
  type GenerateStreamCallbacks,
  type ProviderDispatcher,
} from "../common/provider-dispatcher";
import { SmoothWeightedRoundRobin } from "../common/smooth-weighted-round-robin";
import {
  assertSupportedAntigravityModel,
  assertSupportedAntigravityEffortForModel,
} from "./antigravity-constants";
import {
  AntigravityHttpError,
  antigravityControl,
  generateAntigravityHttp,
  record,
} from "./antigravity-http";
import { refreshAntigravityCredentials } from "./antigravity-oauth";
import { parseAntigravityQuotaSummary, type AntigravityQuotaWindows } from "./antigravity-quota";

export interface AntigravityRegistration {
  id: number;
  name: string;
  credentials: AntigravityCredentials;
  quotaThreshold?: number | null;
  weight?: number;
}

export class AntigravityDispatcher implements ProviderDispatcher {
  private readonly tokens = new Map<number, AntigravityRegistration>();
  private readonly selector = new SmoothWeightedRoundRobin();
  private readonly refreshing = new Map<number, Promise<AntigravityCredentials>>();
  private readonly catalogs = new Map<
    number,
    { accessToken: string; at: number; models: Record<string, unknown> }
  >();
  private readonly quotaWindows = new Map<
    number,
    { accessToken: string; at: number; windows: AntigravityQuotaWindows }
  >();
  private running = 0;

  async start(): Promise<void> {
    this.replaceTokens(
      (await TokenModel.findActiveByProvider("A", "antigravity")).map((t) => ({
        id: t.id,
        name: t.name,
        credentials: t.credentials as AntigravityCredentials,
        quotaThreshold: t.quota_threshold,
        weight: t.weight,
      })),
    );
  }
  async stop(): Promise<void> {
    for (const id of this.tokens.keys()) this.selector.removeToken(id);
    this.tokens.clear();
    this.catalogs.clear();
    this.quotaWindows.clear();
  }
  get tokenCount(): number {
    return this.tokens.size;
  }
  get inFlight(): number {
    return this.running;
  }
  get tokenNames(): string[] {
    return [...this.tokens.values()].map((t) => t.name).toSorted();
  }

  replaceTokens(rows: AntigravityRegistration[]): void {
    const ids = new Set(rows.map((t) => t.id));
    for (const id of this.tokens.keys()) if (!ids.has(id)) this.onTokenRemoved(id);
    for (const row of rows) this.onTokenUpdated(row);
  }
  onTokenAdded(row: AntigravityRegistration): void {
    this.onTokenUpdated(row);
  }
  onTokenUpdated(row: AntigravityRegistration): void {
    // Legacy keychain registrations must reconnect through OAuth on this branch.
    if (!AntigravityCredentials.safeParse(row.credentials).success) {
      this.onTokenRemoved(row.id);
      return;
    }
    if (this.tokens.get(row.id)?.credentials.accessToken !== row.credentials.accessToken)
      this.catalogs.delete(row.id);
    this.tokens.set(row.id, row);
    this.selector.setToken(row.id, row.weight ?? 1);
  }
  onTokenRemoved(id: number): void {
    this.tokens.delete(id);
    this.selector.removeToken(id);
    this.catalogs.delete(id);
    this.quotaWindows.delete(id);
  }
  onTokenDeactivated(id: number): void {
    this.onTokenRemoved(id);
  }

  private async credentials(
    row: AntigravityRegistration,
    force = false,
  ): Promise<AntigravityCredentials> {
    if (!force && row.credentials.expiresAt > Date.now() + 60_000) return row.credentials;
    const pending = this.refreshing.get(row.id);
    if (pending) {
      row.credentials = await pending;
      return row.credentials;
    }
    const refresh = (async () => {
      const stored = await TokenModel.findOne("A", { id: row.id });
      if (!stored || !stored.active || stored.reauth_required)
        throw new Error("Antigravity account is inactive or needs login");
      const current = AntigravityCredentials.parse(stored.credentials);
      if (
        current.accessToken !== row.credentials.accessToken ||
        (!force && current.expiresAt > Date.now() + 60_000)
      ) {
        row.credentials = current;
        return current;
      }
      try {
        const next = await refreshAntigravityCredentials(current);
        const saved = await TokenModel.updateCredentialsIfCurrent(row.id, current, next);
        if (!saved)
          throw new Error("Antigravity credentials changed during refresh; retry the request");
        row.credentials = next;
        this.catalogs.delete(row.id);
        return next;
      } catch (error) {
        if (error instanceof AntigravityHttpError && error.code === "invalid_grant") {
          await deactivateAuthDeadToken(
            { id: row.id, name: row.name, provider: "antigravity", credentials: current },
            "antigravity:invalid_grant",
          );
          this.onTokenRemoved(row.id);
        }
        throw error;
      }
    })();
    this.refreshing.set(row.id, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshing.delete(row.id);
    }
  }

  private async readControl(
    row: AntigravityRegistration,
    method: "fetchAvailableModels" | "retrieveUserQuotaSummary",
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const read = () =>
      antigravityControl(
        method,
        row.credentials.accessToken,
        { project: row.credentials.projectId },
        signal,
      );
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof AntigravityHttpError) || error.status !== 401) throw error;
      row.credentials = await this.credentials(row, true);
      return read();
    }
  }

  private async catalog(
    row: AntigravityRegistration,
    signal = AbortSignal.timeout(30_000),
  ): Promise<Record<string, unknown>> {
    const credentials = await this.credentials(row);
    const cached = this.catalogs.get(row.id);
    if (cached && cached.accessToken === credentials.accessToken && Date.now() - cached.at < 60_000)
      return cached.models;
    const data = await this.readControl(row, "fetchAvailableModels", signal);
    const models = record(data.models);
    this.catalogs.set(row.id, { accessToken: row.credentials.accessToken, at: Date.now(), models });
    return models;
  }

  async usageForToken(id: number): Promise<AntigravityQuotaWindows | null> {
    const row = this.tokens.get(id);
    if (!row) return null;
    const credentials = await this.credentials(row);
    const cached = this.quotaWindows.get(id);
    if (cached && cached.accessToken === credentials.accessToken && Date.now() - cached.at < 60_000)
      return cached.windows;
    const summary = await this.readControl(
      row,
      "retrieveUserQuotaSummary",
      AbortSignal.timeout(30_000),
    );
    const windows = parseAntigravityQuotaSummary(summary);
    this.quotaWindows.set(id, {
      accessToken: row.credentials.accessToken,
      at: Date.now(),
      windows,
    });
    return windows;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.run(req);
  }
  async generateStream(req: GenerateRequest, callbacks: GenerateStreamCallbacks): Promise<void> {
    try {
      callbacks.onComplete(await this.run(req, callbacks.onDelta));
    } catch (error) {
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async run(
    req: GenerateRequest,
    onDelta?: (text: string) => void,
  ): Promise<GenerateResult> {
    if (req.imageGeneration)
      throw new Error("image generation is not supported on the antigravity route");
    const model = assertSupportedAntigravityModel(req.model);
    const effort = resolveAntigravityEffort(req.effort);
    assertSupportedAntigravityEffortForModel(model, effort);
    const controller = AbortSignal.any([
      AbortSignal.timeout(req.timeoutMs ?? 240_000),
      ...(req.abortSignal ? [req.abortSignal] : []),
    ]);
    controller.throwIfAborted();
    const candidates = [...this.tokens.values()].filter(
      (t) => req.preferredTokenId === undefined || t.id === req.preferredTokenId,
    );
    if (!candidates.length) throw new Error("No active Antigravity OAuth accounts available");
    this.running++;
    try {
      const eligible = new Map<number, { row: AntigravityRegistration; wireModel: string }>();
      let lastError: unknown;
      let quotaBlocked = false;
      await Promise.all(
        candidates.map(async (row) => {
          try {
            const models = await this.catalog(row, controller);
            const wireModel = [`${model}-${effort}`, model, `${model}-tiered`].find((name) =>
              Object.hasOwn(models, name),
            );
            if (!wireModel)
              throw new Error(`Antigravity account does not advertise ${model} (${effort})`);
            const quota = record(record(models[wireModel]).quotaInfo);
            if (
              row.quotaThreshold !== null &&
              row.quotaThreshold !== undefined &&
              typeof quota.remainingFraction === "number" &&
              (1 - quota.remainingFraction) * 100 >= row.quotaThreshold
            ) {
              quotaBlocked = true;
              return;
            }
            // NOTIFY can replace an object during a successful refresh or weight edit.
            // Identity comes from credentials, not JavaScript object identity.
            const current = this.tokens.get(row.id);
            if (
              current &&
              current.credentials.accountId === row.credentials.accountId &&
              current.credentials.projectId === row.credentials.projectId &&
              current.credentials.accessToken === row.credentials.accessToken
            )
              eligible.set(row.id, { row: current, wireModel });
          } catch (error) {
            lastError = error;
          }
        }),
      );
      controller.throwIfAborted();
      const selected =
        req.preferredTokenId !== undefined
          ? eligible.has(req.preferredTokenId)
            ? req.preferredTokenId
            : null
          : this.selector.select(new Set(eligible.keys()));
      if (selected === null) {
        if (lastError) throw lastError;
        if (quotaBlocked)
          throw new QuotaThresholdExceededError(
            "All antigravity accounts exceeded quota threshold",
          );
        throw new Error("No eligible Antigravity OAuth account available");
      }
      const { row, wireModel } = eligible.get(selected)!;
      let emitted = false;
      const delta = onDelta
        ? (text: string) => {
            emitted = true;
            onDelta(text);
          }
        : undefined;
      const execute = () =>
        generateAntigravityHttp(
          { ...req, effort, abortSignal: controller },
          row.credentials,
          wireModel,
          delta,
        );
      let result;
      try {
        result = await execute();
      } catch (error) {
        if (!(error instanceof AntigravityHttpError) || error.status !== 401 || emitted)
          throw error;
        row.credentials = await this.credentials(row, true);
        result = await execute();
      }
      return {
        ...result,
        model: result.model ?? model,
        requestedModel: model,
        tokenName: row.name,
        threadCoord: { workerId: row.id, threadId: randomUUID(), epoch: 0 },
      };
    } finally {
      this.running--;
    }
  }
}
