import { type PiCredentialStore } from "@ai-sdk/harness-pi";
import { getJwtExpiresAt } from "@ai-sdk/harness/utils";

import { type OpenAIDispatcher } from "../providers/openai/openai-dispatcher";

/** Pi provider id whose credentials come from the qgrid OpenAI token pool. */
export const PI_CODEX_PROVIDER = "openai-codex";

/** Pi refreshes OAuth tokens with less than five minutes left; stay ahead of that window. */
const REFRESH_WINDOW_MS = 5 * 60_000;

export type AgentTokenErrorCode = "token_unavailable" | "quota_exceeded";

/** Thrown from the store so the runner can map a model-auth failure to a turn error code. */
export class AgentTokenError extends Error {
  constructor(
    readonly code: AgentTokenErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

/** Pi wraps store failures in ModelsError; walk the cause chain to recover the qgrid code. */
export function findAgentTokenError(error: Error): AgentTokenError | undefined {
  let current: Error | undefined = error;

  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (current instanceof AgentTokenError) return current;
    current = current.cause instanceof Error ? current.cause : undefined;
  }

  return undefined;
}

type Dispatcher = Pick<
  OpenAIDispatcher,
  "tokenMetadata" | "refreshCredentials" | "isQuotaEligible"
>;

type OAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

/**
 * One Pi `CredentialStore` per pool token, shared by every session on that token (D26).
 * Pi serializes `modify` per store instance, so sharing keeps two sessions on the same token
 * from refreshing concurrently and invalidating each other's rotated refresh token.
 */
export class AgentCredentialStores {
  private readonly stores = new Map<number, PiCredentialStore>();

  constructor(private readonly dispatcher: Dispatcher) {}

  get(tokenId: number): PiCredentialStore {
    let store = this.stores.get(tokenId);

    if (!store) {
      store = this.createStore(tokenId);
      this.stores.set(tokenId, store);
    }

    return store;
  }

  private async current(tokenId: number, signal?: AbortSignal): Promise<OAuthCredential> {
    const metadata = this.dispatcher.tokenMetadata.get(tokenId);

    if (!metadata?.active) throw new AgentTokenError("token_unavailable");

    if (!(await this.dispatcher.isQuotaEligible(tokenId, metadata, signal)))
      throw new AgentTokenError("quota_exceeded");

    const { accessToken, refreshToken, accessTokenExpiresAt, accountId } = metadata.credentials;
    // The metadata row may lag a refresh; the JWT itself is the authoritative expiry.
    const expires = (await getJwtExpiresAt({ token: accessToken })) ?? accessTokenExpiresAt;

    return { type: "oauth", access: accessToken, refresh: refreshToken, expires, accountId };
  }

  private createStore(tokenId: number): PiCredentialStore {
    // Serialize writes per token across every session (Pi only serializes per store instance).
    let chain: Promise<unknown> = Promise.resolve();

    const store: PiCredentialStore = {
      read: async (providerId, options) => {
        if (providerId !== PI_CODEX_PROVIDER) return undefined;

        return this.current(tokenId, options?.signal);
      },

      list: async () => {
        const metadata = this.dispatcher.tokenMetadata.get(tokenId);

        return metadata?.active ? [{ providerId: PI_CODEX_PROVIDER, type: "oauth" }] : [];
      },

      // Pi calls modify() to refresh an expiring token. qgrid owns refresh (dedupe, DB write,
      // NOTIFY), so the Pi-supplied mutation is not run; the pool token is refreshed instead.
      modify: async (providerId, _mutation, options) => {
        if (providerId !== PI_CODEX_PROVIDER) return undefined;

        const run = async () => {
          const before = await this.current(tokenId, options?.signal);

          // Double-check: another session or the dispatcher may have refreshed already.
          if (before.expires - Date.now() > REFRESH_WINDOW_MS) return before;

          try {
            await this.dispatcher.refreshCredentials(tokenId);
          } catch (error) {
            throw new AgentTokenError("token_unavailable", { cause: error });
          }

          return this.current(tokenId, options?.signal);
        };

        const result = chain.then(run, run);
        chain = result.catch(() => undefined);

        return result;
      },

      delete: async () => {},
    };

    return store;
  }
}
