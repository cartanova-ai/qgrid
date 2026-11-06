import { describe, expect, it } from "vitest";

import { readGrokBilling, readGrokSettings, readGrokSubscription } from "./grok-quota";

const credentials = {
  accessToken: "header.payload.sig",
  userId: "19bfa1b2-a163-9e0c-8de1-832a73e2695e",
};

function fetchReturning(
  body: unknown,
  status = 200,
  seen?: Array<{ url: string; headers: Headers }>,
): typeof fetch {
  return async (input, init) => {
    seen?.push({ url: String(input), headers: new Headers(init?.headers) });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}

describe("readGrokBilling", () => {
  it("maps the camelCase credits schema to the shared quota shape", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const result = await readGrokBilling(credentials, {
      fetch: fetchReturning(
        {
          config: {
            currentPeriod: {
              type: "USAGE_PERIOD_TYPE_WEEKLY",
              start: "2026-10-12T00:00:00Z",
              end: "2026-10-19T00:00:00Z",
            },
            creditUsagePercent: 42,
            productUsage: [{ product: "GrokBot", usagePercent: 42 }],
            isUnifiedBillingUser: true,
            prepaidBalance: { val: "0" },
          },
        },
        200,
        seen,
      ),
    });
    expect(seen[0]?.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    expect(seen[0]?.headers.get("x-userid")).toBe(credentials.userId);
    expect(seen[0]?.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(result).toMatchObject({
      kind: "ok",
      utilizationPct: 42,
      windowDurationMins: 7 * 24 * 60,
      resetsAt: Date.parse("2026-10-19T00:00:00Z") / 1000,
      limitId: "USAGE_PERIOD_TYPE_WEEKLY",
      periodType: "USAGE_PERIOD_TYPE_WEEKLY",
      periodEnd: "2026-10-19T00:00:00Z",
      periodEndMs: Date.parse("2026-10-19T00:00:00Z"),
      prepaidBalance: 0,
    });
  });

  it("reads an omitted creditUsagePercent as 0% for a period without usage", async () => {
    const result = await readGrokBilling(credentials, {
      fetch: fetchReturning({
        config: {
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-10-15T00:00:00+00:00",
            end: "2026-10-22T00:00:00+00:00",
          },
          onDemandCap: { val: 0 },
          isUnifiedBillingUser: true,
          prepaidBalance: { val: 0 },
        },
      }),
    });
    expect(result).toMatchObject({ kind: "ok", utilizationPct: 0, periodType: "USAGE_PERIOD_TYPE_WEEKLY" });
  });

  it("returns lookup_failed on HTTP errors and unexpected shapes", async () => {
    expect(await readGrokBilling(credentials, { fetch: fetchReturning("nope", 500) })).toMatchObject({
      kind: "lookup_failed",
    });
    expect(
      await readGrokBilling(credentials, { fetch: fetchReturning({ credit_usage_percent: 3 }) }),
    ).toMatchObject({ kind: "lookup_failed" });
    expect(
      await readGrokBilling(credentials, {
        fetch: async () => {
          throw new TypeError("offline");
        },
      }),
    ).toMatchObject({ kind: "lookup_failed" });
  });
});

describe("readGrokSettings", () => {
  it("reads on_demand_enabled and the gate fields", async () => {
    const result = await readGrokSettings(credentials, {
      fetch: fetchReturning({
        min_client_version: "1.0.13",
        force_update: true,
        default_model: "grok-4.7",
        subscription_tier_display: "SuperGrok Plus",
        on_demand_enabled: null,
        image_gen_enabled: true,
        video_gen_enabled: true,
        voice_mode_enabled: true,
      }),
    });
    expect(result).toEqual({
      kind: "ok",
      onDemandEnabled: null,
      minClientVersion: "1.0.13",
      defaultModel: "grok-4.7",
      subscriptionTierDisplay: "SuperGrok Plus",
      imageGenEnabled: true,
      videoGenEnabled: true,
      voiceModeEnabled: true,
    });
  });

  it("treats an absent on_demand_enabled as null and true as true", async () => {
    expect(await readGrokSettings(credentials, { fetch: fetchReturning({}) })).toMatchObject({
      onDemandEnabled: null,
    });
    expect(
      await readGrokSettings(credentials, { fetch: fetchReturning({ on_demand_enabled: true }) }),
    ).toMatchObject({ onDemandEnabled: true });
  });
});

describe("readGrokSubscription", () => {
  it("returns the tier", async () => {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const result = await readGrokSubscription(credentials, {
      fetch: fetchReturning(
        { userId: credentials.userId, subscriptionTier: "SuperGrokPlus", hasGrokCodeAccess: true },
        200,
        seen,
      ),
    });
    expect(seen[0]?.url).toBe("https://cli-chat-proxy.grok.com/v1/user?include=subscription");
    expect(result).toEqual({
      kind: "ok",
      userId: credentials.userId,
      tier: "SuperGrokPlus",
      hasGrokCodeAccess: true,
      dataRetentionOptOut: null,
    });
  });

  it("returns codingDataRetentionOptOut", async () => {
    const result = await readGrokSubscription(credentials, {
      fetch: fetchReturning({ userId: credentials.userId, codingDataRetentionOptOut: true }),
    });
    expect(result).toMatchObject({ kind: "ok", dataRetentionOptOut: true });
    const off = await readGrokSubscription(credentials, {
      fetch: fetchReturning({ userId: credentials.userId, codingDataRetentionOptOut: false }),
    });
    expect(off).toMatchObject({ kind: "ok", dataRetentionOptOut: false });
  });
});
