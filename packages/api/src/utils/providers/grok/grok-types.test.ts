import { describe, expect, it } from "vitest";

import { GROK_OAUTH_CLIENT_ID, GROK_OAUTH_SCOPES } from "./grok-constants";
import {
  GrokApiImageModelCatalog,
  GrokApiLanguageModelCatalog,
  GrokBillingConfig,
  GrokCredentials,
  GrokImageResponse,
  GrokModelsResponse,
  GrokSettings,
  GrokSttResponse,
  GrokTtsRequest,
  GrokUserSubscription,
  GrokVideoStatus,
  decodeGrokJwt,
  grokCatalogModels,
  grokVideoUrl,
  isGrokAccessToken,
} from "./grok-types";

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function fakeJwt(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${segment(header)}.${segment(payload)}.c2lnbmF0dXJl`;
}

const validJwt = fakeJwt(
  { alg: "RS256", typ: "at+jwt" },
  { iss: "https://auth.x.ai", sub: "user", exp: 2_000_000_000 },
);

const credentials = {
  authMode: "oauth",
  accessToken: validJwt,
  refreshToken: "refresh",
  expiresAt: "2026-10-16T09:00:00Z",
  issuer: "https://auth.x.ai",
  clientId: GROK_OAUTH_CLIENT_ID,
  scopes: [...GROK_OAUTH_SCOPES],
  userId: "19bfa1b2-a163-9e0c-8de1-832a73e2695e",
  sessionId: "22222222-2222-4222-8222-222222222222",
  agentId: "33333333-3333-4333-8333-333333333333",
  subscriptionTier: "SuperGrokPlus",
};

describe("GrokCredentials", () => {
  it("accepts a fabricated at+jwt from auth.x.ai", () => {
    expect(GrokCredentials.parse(credentials)).toEqual(credentials);
    expect(decodeGrokJwt(validJwt)?.payload.iss).toBe("https://auth.x.ai");
  });

  it("rejects an API key", () => {
    expect(isGrokAccessToken("xai-0123456789abcdefghijklmnop")).toBe(false);
    expect(GrokCredentials.safeParse({ ...credentials, accessToken: "xai-abc" }).success).toBe(
      false,
    );
  });

  it("rejects a JWT from another issuer or of another type", () => {
    const foreign = fakeJwt({ alg: "RS256", typ: "at+jwt" }, { iss: "https://accounts.example" });
    const idToken = fakeJwt({ alg: "RS256", typ: "JWT" }, { iss: "https://auth.x.ai" });
    expect(GrokCredentials.safeParse({ ...credentials, accessToken: foreign }).success).toBe(false);
    expect(GrokCredentials.safeParse({ ...credentials, accessToken: idToken }).success).toBe(false);
  });

  it("rejects malformed JWT segments", () => {
    expect(isGrokAccessToken("a.b")).toBe(false);
    expect(isGrokAccessToken("!!!.???.sig")).toBe(false);
    expect(isGrokAccessToken(`${segment("x")}.${segment("y")}.sig`)).toBe(false);
  });

  it("requires userId, an RFC 3339 expiry and the auth.x.ai issuer", () => {
    const { userId: _userId, ...withoutUser } = credentials;
    expect(GrokCredentials.safeParse(withoutUser).success).toBe(false);
    expect(GrokCredentials.safeParse({ ...credentials, expiresAt: "tomorrow" }).success).toBe(
      false,
    );
    expect(GrokCredentials.safeParse({ ...credentials, expiresAt: 1_800_000_000 }).success).toBe(
      false,
    );
    expect(
      GrokCredentials.safeParse({ ...credentials, issuer: "https://auth.example" }).success,
    ).toBe(false);
    expect(GrokCredentials.safeParse({ ...credentials, authMode: "api_key" }).success).toBe(false);
  });
});

describe("Grok proxy response schemas (U0 shapes, redacted)", () => {
  it("parses /billing?format=credits", () => {
    const billing = GrokBillingConfig.parse({
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-10-12T00:00:00Z",
          end: "2026-10-19T00:00:00Z",
        },
        creditUsagePercent: 1,
        productUsage: [{ product: "GrokBot", usagePercent: 1 }],
        isUnifiedBillingUser: true,
        prepaidBalance: { val: 0 },
        topUpMethod: "TOP_UP_METHOD_UNSPECIFIED",
        billingPeriodStart: "2026-10-12T00:00:00Z",
        billingPeriodEnd: "2026-10-19T00:00:00Z",
      },
    });
    expect(billing.config.creditUsagePercent).toBe(1);
    expect(billing.config).not.toHaveProperty("onDemandEnabled");
    expect(billing.config.topUpMethod).toBe("TOP_UP_METHOD_UNSPECIFIED");
    expect(GrokBillingConfig.safeParse({ config: { credit_usage_percent: 1 } }).success).toBe(
      false,
    );
  });

  it("parses /settings with on_demand_enabled null", () => {
    const settings = GrokSettings.parse({
      min_client_version: "1.0.13",
      force_update: true,
      default_model: "grok-4.7",
      subscription_tier_display: "SuperGrok Plus",
      on_demand_enabled: null,
      image_gen_enabled: true,
      video_gen_enabled: true,
      voice_mode_enabled: true,
      accept_request_encodings: ["zstd"],
      tips: ["passthrough"],
    });
    expect(settings.on_demand_enabled).toBeNull();
    expect(settings.tips).toEqual(["passthrough"]);
    expect(GrokSettings.safeParse({ on_demand_enabled: "yes" }).success).toBe(false);
  });

  it("parses /user?include=subscription", () => {
    const user = GrokUserSubscription.parse({
      userId: "19bfa1b2-a163-9e0c-8de1-832a73e2695e",
      email: "user@example.com",
      subscriptionTier: "SuperGrokPlus",
      hasGrokCodeAccess: true,
      teamId: null,
    });
    expect(user.subscriptionTier).toBe("SuperGrokPlus");
    expect(user.codingDataRetentionOptOut).toBeUndefined();
    expect(
      GrokUserSubscription.parse({ userId: user.userId, codingDataRetentionOptOut: true })
        .codingDataRetentionOptOut,
    ).toBe(true);
    expect(
      GrokUserSubscription.safeParse({ userId: user.userId, codingDataRetentionOptOut: "yes" })
        .success,
    ).toBe(false);
    expect(GrokUserSubscription.safeParse({ subscriptionTier: "x" }).success).toBe(false);
  });

  it("parses proxy /models", () => {
    const efforts = ["xhigh", "high", "medium", "low"].map((id) => ({
      id,
      value: id,
      label: id,
      description: id,
      default: id === "high",
    }));
    const models = GrokModelsResponse.parse({
      object: "list",
      data: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"].map((id) => ({
        id,
        object: "model",
        context_window: 256000,
        context_windows: [256000, 500000],
        api_backend: "responses",
        reasoning_effort: "high",
        supports_reasoning_effort: true,
        reasoning_efforts: efforts,
      })),
    });
    expect(models.data.map((model) => model.id)).toEqual([
      "grok-4.7",
      "grok-4.7-build-fast",
      "grok-4.6",
      "grok-4.5",
    ]);
  });
});

describe("api.x.ai schemas", () => {
  it("parses the language-model price catalog under either envelope", () => {
    const model = {
      id: "grok-4.7",
      aliases: ["grok-4.7-latest"],
      prompt_text_token_price: 20000,
      cached_prompt_text_token_price: 5000,
      completion_text_token_price: 60000,
      prompt_image_token_price: 20000,
      prompt_text_token_price_long_context: 40000,
      long_context_threshold: 200000,
    };
    for (const envelope of [{ models: [model] }, { data: [model], object: "list" }]) {
      const catalog = GrokApiLanguageModelCatalog.parse(envelope);
      expect(grokCatalogModels(catalog)[0]?.prompt_text_token_price).toBe(20000);
    }
  });

  it("parses the image-model price catalog", () => {
    const catalog = GrokApiImageModelCatalog.parse({
      models: [
        {
          id: "grok-imagine-image-2.0",
          image_price: 400000000,
          pricing: [{ quality: "low", resolution: "1k", price_per_image: 400000000 }],
        },
      ],
    });
    expect(grokCatalogModels(catalog)[0]?.pricing?.[0]?.price_per_image).toBe(400000000);
  });

  it("parses image, video, STT and TTS shapes", () => {
    expect(
      GrokImageResponse.parse({
        data: [{ b64_json: "AAAA", mime_type: "image/jpeg" }],
        usage: { cost_in_usd_ticks: 500000000 },
      }).usage?.cost_in_usd_ticks,
    ).toBe(500000000);
    expect(GrokImageResponse.safeParse({ data: [] }).success).toBe(false);
    expect(
      grokVideoUrl(GrokVideoStatus.parse({ status: "done", video: { url: "https://v/1.mp4" } })),
    ).toBe("https://v/1.mp4");
    expect(
      grokVideoUrl(
        GrokVideoStatus.parse({
          status: "done",
          video: { url: null, file_output: { public_url: "https://v/2.mp4" } },
        }),
      ),
    ).toBe("https://v/2.mp4");
    // @ai-sdk/xai never reads a top-level file_output.
    expect(
      grokVideoUrl(
        GrokVideoStatus.parse({ status: "done", file_output: { public_url: "https://v/3.mp4" } }),
      ),
    ).toBeUndefined();
    expect(grokVideoUrl(GrokVideoStatus.parse({ status: "pending" }))).toBeUndefined();
    expect(GrokSttResponse.parse({ text: "", language: "", duration: 1 }).duration).toBe(1);
    expect(
      GrokTtsRequest.safeParse({ text: "hi", voice: "ara", language: "en", format: "mp3" })
        .success,
    ).toBe(true);
    expect(GrokTtsRequest.safeParse({ text: "hi", voice: "ara", format: "mp3" }).success).toBe(
      false,
    );
  });
});
