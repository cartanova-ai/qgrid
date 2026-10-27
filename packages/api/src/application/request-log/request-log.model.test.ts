import { randomUUID } from "node:crypto";

import { Client, type ClientConfig } from "pg";
import { Sonamu } from "sonamu";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { providerOfModelName, RequestLogModel, UNKNOWN_MEDIA_COST_PREDICATE } from "./request-log.model";

describe("request-log provider inference", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["grok/grok-4.7", "grok"],
    ["grok/grok-imagine-image-quality", "grok"],
    ["openai/gpt-6-sol", "openai"],
    ["anthropic/claude-opus-5-5", "anthropic"],
    ["gpt-5.4", "unknown"],
    ["xai/grok-4.7", "unknown"],
    [null, "unknown"],
  ] as const)("%s -> %s", (model, provider) => {
    expect(providerOfModelName(model)).toBe(provider);
  });

  it("groups grok rows under their own provider in recent stats", async () => {
    const rows = [
      { requested_model_name: "grok/grok-4.7", status: "succeeded", input_tokens: 10, cache_read_tokens: 4 },
      { requested_model_name: "grok/grok-imagine-image-quality", status: "error", input_tokens: 0, cache_read_tokens: 0 },
      { requested_model_name: "openai/gpt-6-sol", status: "succeeded", input_tokens: 5, cache_read_tokens: 0 },
    ];
    const chain = { select: vi.fn(() => chain), where: vi.fn(async () => rows) };
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { from: () => typeof chain } },
      "getPuri",
    ).mockReturnValue({ from: () => chain });

    await expect(RequestLogModel.providerStatsSince(new Date(0))).resolves.toEqual([
      { provider: "grok", requests: 2, errors: 1, inputTokens: 10, cacheReadTokens: 4 },
      { provider: "openai", requests: 1, errors: 0, inputTokens: 5, cacheReadTokens: 0 },
    ]);
  });
});

function mockQueryBuilder(rows: unknown[]) {
  const chain = {
    select: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    first: vi.fn(async () => rows[0]),
  };
  return chain;
}

function mockTransactionalWritePuri(transactionPuri: unknown) {
  const transaction = vi.fn(
    async (callback: (trx: unknown) => Promise<unknown>) => callback({}),
  );
  const rootPuri = { knex: { transaction } };
  vi.spyOn(
    RequestLogModel as unknown as { getPuri: (preset: "w") => unknown },
    "getPuri",
  )
    .mockReturnValueOnce(rootPuri)
    .mockReturnValue(transactionPuri);
  return transaction;
}

function mockToolsViewQuery(row: { tools: unknown } | undefined) {
  const chain = mockQueryBuilder(row === undefined ? [] : [row]);
  const from = vi.fn(() => chain);
  vi.spyOn(
    RequestLogModel as unknown as { getPuri: () => { from: typeof from } },
    "getPuri",
  ).mockReturnValue({ from });
  return { chain, from };
}

describe("RequestLogModel TTFT", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the first non-null generate-step ttft", async () => {
    const chain = mockQueryBuilder([{ ttft_ms: 42 }]);
    const from = vi.fn(() => chain);
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { from: typeof from } },
      "getPuri",
    ).mockReturnValue({ from });

    await expect(RequestLogModel.firstGenerateStepTtft(7)).resolves.toBe(42);

    expect(from).toHaveBeenCalledWith("request_log_steps");
    expect(chain.where).toHaveBeenCalledWith("request_log_id", 7);
    expect(chain.where).toHaveBeenCalledWith("type", "generate");
    expect(chain.where).toHaveBeenCalledWith("ttft_ms", "!=", null);
    expect(chain.orderBy).toHaveBeenNthCalledWith(1, "step_index", "asc");
    expect(chain.orderBy).toHaveBeenNthCalledWith(2, "id", "asc");
  });

  it("returns null when no generate step has ttft", async () => {
    const from = vi.fn(() => mockQueryBuilder([]));
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { from: typeof from } },
      "getPuri",
    ).mockReturnValue({ from });

    await expect(RequestLogModel.firstGenerateStepTtft(7)).resolves.toBeNull();
  });

  it("stores server-derived ttft_ms during finishRun", async () => {
    const ubRegister = vi.fn();
    const transaction = vi.fn(async (cb: (trx: { ubUpsert: () => Promise<number[]> }) => void) =>
      cb({ ubUpsert: vi.fn(async () => [7]) }),
    );
    vi.spyOn(RequestLogModel, "firstGenerateStepTtft").mockResolvedValue(55);
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { ubRegister: typeof ubRegister; transaction: typeof transaction } },
      "getPuri",
    ).mockReturnValue({ ubRegister, transaction });

    await RequestLogModel.finishRun(7, { status: "error", error_message: "boom" });

    expect(ubRegister).toHaveBeenCalledWith(
      "request_logs",
      expect.objectContaining({
        id: 7,
        status: "error",
        error_message: "boom",
        ttft_ms: 55,
      }),
    );
  });

  it("stores zero during finishRun when no generate step has ttft", async () => {
    const ubRegister = vi.fn();
    const transaction = vi.fn(async (cb: (trx: { ubUpsert: () => Promise<number[]> }) => void) =>
      cb({ ubUpsert: vi.fn(async () => [7]) }),
    );
    vi.spyOn(RequestLogModel, "firstGenerateStepTtft").mockResolvedValue(null);
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { ubRegister: typeof ubRegister; transaction: typeof transaction } },
      "getPuri",
    ).mockReturnValue({ ubRegister, transaction });

    await RequestLogModel.finishRun(7, { status: "error", error_message: "boom" });

    expect(ubRegister).toHaveBeenCalledWith(
      "request_logs",
      expect.objectContaining({
        id: 7,
        ttft_ms: 0,
      }),
    );
  });
});

describe("RequestLogModel toolsView", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a display-ready required-first contract from the decoded JSONB value", async () => {
    const tools = [
      {
        name: "search",
        description: "Search indexed records",
        inputSchema: {
          type: "object",
          properties: {
            optionalEmpty: { type: "string", default: "" },
            requiredEnum: {
              enum: ["one", "two", "three", "four", "five", "six", "seven", "eight"],
              description: "Search mode",
            },
            requiredFalse: { type: "boolean", default: false },
            requiredZero: { type: "integer", default: 0 },
            optionalNull: { type: ["string", "null"], default: null, description: 42 },
            optionalAbsent: { type: "string", description: "Optional note" },
          },
          required: ["requiredEnum", "requiredFalse", "requiredZero"],
        },
      },
      {
        name: "ping",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    ];
    const { chain, from } = mockToolsViewQuery({ tools });

    await expect(RequestLogModel.toolsView(7)).resolves.toEqual([
      {
        name: "search",
        description: "Search indexed records",
        parameterCount: 6,
        inputZod: [
          "z.object({",
          '  requiredEnum: z.enum(["one", "two", "three", "four", "five", "six" /* +2 */]),',
          "  requiredFalse: z.boolean(), // default=false",
          "  requiredZero: z.number(), // default=0",
          '  optionalEmpty: z.string().optional(), // default=""',
          "  optionalNull: z.union([z.string(), z.null()]).optional(), // default=null",
          "  optionalAbsent: z.string().optional(),",
          "})",
        ].join("\n"),
        fullInputZod: [
          "z.object({",
          '  requiredEnum: z.enum(["one", "two", "three", "four", "five", "six", "seven", "eight"]),',
          "  requiredFalse: z.boolean(), // default=false",
          "  requiredZero: z.number(), // default=0",
          '  optionalEmpty: z.string().optional(), // default=""',
          "  optionalNull: z.union([z.string(), z.null()]).optional(), // default=null",
          "  optionalAbsent: z.string().optional(),",
          "})",
        ].join("\n"),
      },
      {
        name: "ping",
        parameterCount: 1,
        inputZod: ["z.object({", "  message: z.string(),", "})"].join("\n"),
      },
    ]);

    expect(from).toHaveBeenCalledWith("request_logs");
    expect(chain.select).toHaveBeenCalledWith({ tools: "request_logs.tools" });
    expect(chain.where).toHaveBeenCalledWith("request_logs.id", 7);
    expect(chain.first).toHaveBeenCalledTimes(1);
  });

  it("defensively decodes string storage without changing the view contract", async () => {
    mockToolsViewQuery({
      tools: JSON.stringify([
        {
          name: "lookup",
          description: "Look up one record",
          inputSchema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ]),
    });

    await expect(RequestLogModel.toolsView(11)).resolves.toEqual([
      {
        name: "lookup",
        description: "Look up one record",
        parameterCount: 1,
        inputZod: ["z.object({", "  id: z.string(),", "})"].join("\n"),
      },
    ]);
  });

  // inputSchema 는 QgridTool 상 z.unknown() 이라 키 누락·null 도 wire 검증을 통과한다.
  // 하나가 터지면 map 전체가 죽어 그 요청의 tool 계약이 통째로 사라지므로 개별 정규화한다.
  it("renders unusable input schemas without failing the entire tool contract", async () => {
    mockToolsViewQuery({
      tools: [
        { name: "unknown_input", inputSchema: {} },
        { name: "empty_object_input", inputSchema: { type: "object" } },
        { name: "string_input", inputSchema: { type: "string" } },
        { name: "null_input", inputSchema: null },
        { name: "absent_input" },
      ],
    });

    await expect(RequestLogModel.toolsView(13)).resolves.toEqual([
      {
        name: "unknown_input",
        parameterCount: 0,
        inputZod: "z.unknown()",
      },
      {
        name: "empty_object_input",
        parameterCount: 0,
        inputZod: "z.object({})",
      },
      {
        name: "string_input",
        parameterCount: 0,
        inputZod: "z.string()",
      },
      {
        name: "null_input",
        parameterCount: 0,
        inputZod: "z.unknown()",
      },
      {
        name: "absent_input",
        parameterCount: 0,
        inputZod: "z.unknown()",
      },
    ]);
  });

  it.each([
    ["a missing row", undefined],
    ["null tools", { tools: null }],
    ["an empty decoded array", { tools: [] }],
    ["empty stored text", { tools: "" }],
    ["invalid stored JSON", { tools: "{broken" }],
  ])("returns an empty view for %s", async (_label, row) => {
    mockToolsViewQuery(row);

    await expect(RequestLogModel.toolsView(12)).resolves.toEqual([]);
  });
});

describe("RequestLogModel run lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps legacy external runs unstructured when metadata is omitted", async () => {
    const ubRegister = vi.fn();
    const transaction = vi.fn(
      async (cb: (trx: { ubUpsert: () => Promise<number[]> }) => Promise<number>) =>
        cb({ ubUpsert: vi.fn(async () => [16]) }),
    );
    vi.spyOn(
      RequestLogModel as unknown as {
        getPuri: () => { ubRegister: typeof ubRegister; transaction: typeof transaction };
      },
      "getPuri",
    ).mockReturnValue({ ubRegister, transaction });

    await RequestLogModel.createRun({ user_prompt: "plain text" });

    expect(ubRegister).toHaveBeenCalledWith(
      "request_logs",
      expect.objectContaining({ is_structured: false, json_schema: null }),
    );
  });

  it("stores the requested model and attached tools but no serving model when a run starts", async () => {
    const ubRegister = vi.fn();
    const transaction = vi.fn(
      async (cb: (trx: { ubUpsert: () => Promise<number[]> }) => Promise<number>) =>
        cb({ ubUpsert: vi.fn(async () => [17]) }),
    );
    vi.spyOn(
      RequestLogModel as unknown as {
        getPuri: () => { ubRegister: typeof ubRegister; transaction: typeof transaction };
      },
      "getPuri",
    ).mockReturnValue({ ubRegister, transaction });

    await expect(
      RequestLogModel.createRun({
        user_prompt: "hi",
        requested_model_name: "openai/gpt-5-codex",
        is_structured: true,
        json_schema: '{"type":"object"}',
        tools: [{ name: "getWeather", description: "Get weather", inputSchema: { type: "object" } }],
      }),
    ).resolves.toBe(17);

    expect(ubRegister).toHaveBeenCalledWith(
      "request_logs",
      expect.objectContaining({
        status: "running",
        requested_model_name: "openai/gpt-5-codex",
        model_name: null,
        is_structured: true,
        json_schema: '{"type":"object"}',
        tools: [{ name: "getWeather", description: "Get weather", inputSchema: { type: "object" } }],
      }),
    );
  });

  it("finds only stale unresolved tool-wait candidates through Puri", async () => {
    const candidateChain = {
      distinct: vi.fn(),
      join: vi.fn(),
      select: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(async () => [{ id: 7 }]),
    };
    candidateChain.distinct.mockReturnValue(candidateChain);
    candidateChain.join.mockReturnValue(candidateChain);
    candidateChain.select.mockReturnValue(candidateChain);
    candidateChain.where.mockReturnValue(candidateChain);
    const from = vi.fn(() => candidateChain);
    vi.spyOn(
      RequestLogModel as unknown as { getPuri: () => { from: typeof from } },
      "getPuri",
    ).mockReturnValue({ from });

    const threshold = new Date("2026-07-23T00:00:00.000Z");
    await expect(
      RequestLogModel.findStaleToolWaitingRunCandidates(threshold, 10),
    ).resolves.toEqual([7]);

    expect(candidateChain.distinct).toHaveBeenCalledWith("request_logs.id");
    expect(candidateChain.join).toHaveBeenCalledWith(
      "request_log_steps",
      "request_logs.id",
      "request_log_steps.request_log_id",
    );
    expect(candidateChain.where).toHaveBeenCalledWith("request_logs.status", "running");
    expect(candidateChain.where).toHaveBeenCalledWith("request_log_steps.type", "tool_call");
    expect(candidateChain.where).toHaveBeenCalledWith(
      "request_log_steps.created_at",
      "<",
      threshold,
    );
    expect(candidateChain.where).toHaveBeenCalledWith("request_log_steps.tool_result", null);
    expect(candidateChain.where).toHaveBeenCalledWith("request_log_steps.error", null);
  });

  it("expires stale candidates independently", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-23T01:00:00.000Z").getTime());
    const findCandidates = vi
      .spyOn(RequestLogModel, "findStaleToolWaitingRunCandidates")
      .mockResolvedValue([7, 8]);
    const tryExpire = vi
      .spyOn(RequestLogModel, "tryExpireStaleToolWaitingRun")
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      RequestLogModel.expireStaleToolWaitingRuns(60_000, "stale tool run"),
    ).resolves.toEqual([7]);

    const threshold = new Date("2026-07-23T00:59:00.000Z");
    expect(findCandidates).toHaveBeenCalledWith(threshold, 10);
    expect(tryExpire).toHaveBeenNthCalledWith(1, 7, threshold, "stale tool run");
    expect(tryExpire).toHaveBeenNthCalledWith(2, 8, threshold, "stale tool run");
  });

  it("expires one stale run only after locking and rechecking its unresolved tool call", async () => {
    const unresolvedChain = {
      select: vi.fn(),
      where: vi.fn(),
      first: vi.fn(async () => ({ id: 101 })),
    };
    unresolvedChain.select.mockReturnValue(unresolvedChain);
    unresolvedChain.where.mockReturnValue(unresolvedChain);

    const aggregateChain = {
      select: vi.fn(),
      where: vi.fn(),
    };
    aggregateChain.select.mockReturnValue(aggregateChain);
    aggregateChain.where
      .mockReturnValueOnce(aggregateChain)
      .mockResolvedValueOnce([
        {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_tokens: 3,
          cache_creation_tokens: 4,
          cache_creation_5m_tokens: 1,
          cache_creation_1h_tokens: 3,
          duration_ms: 90,
          fallback_count: 1,
          cost_usd: 250,
          cost_source: "provider",
        },
      ]);

    const ttftChain = {
      select: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      first: vi.fn(async () => ({ ttft_ms: 15 })),
    };
    ttftChain.select.mockReturnValue(ttftChain);
    ttftChain.where.mockReturnValue(ttftChain);
    ttftChain.orderBy.mockReturnValue(ttftChain);

    const updateChain = {
      where: vi.fn(),
      update: vi.fn(async () => 1),
    };
    updateChain.where.mockReturnValue(updateChain);

    const from = vi
      .fn()
      .mockReturnValueOnce(unresolvedChain)
      .mockReturnValueOnce(aggregateChain)
      .mockReturnValueOnce(ttftChain)
      .mockReturnValueOnce(updateChain);
    const raw = vi.fn(async () => ({ rows: [{ acquired: true }] }));
    const transaction = mockTransactionalWritePuri({ knex: { raw }, from });

    await expect(
      RequestLogModel.tryExpireStaleToolWaitingRun(
        7,
        new Date("2026-07-23T00:00:00.000Z"),
        "stale tool run",
      ),
    ).resolves.toBe(true);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledWith("SELECT pg_try_advisory_xact_lock(?, ?) AS acquired", [
      718,
      7,
    ]);
    expect(raw.mock.invocationCallOrder[0]).toBeLessThan(
      unresolvedChain.first.mock.invocationCallOrder[0]!,
    );
    expect(unresolvedChain.where).toHaveBeenCalledWith("tool_result", null);
    expect(unresolvedChain.where).toHaveBeenCalledWith("error", null);
    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "error",
        error_message: "stale tool run",
        input_tokens: 10,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_creation_tokens: 4,
        duration_ms: 90,
        fallback_count: 1,
        cost_usd: 250,
        cost_source: "provider",
        ttft_ms: 15,
      }),
    );
  });

  it("skips a stale candidate when a follow-up already holds its lock", async () => {
    const from = vi.fn();
    const raw = vi.fn(async () => ({ rows: [{ acquired: false }] }));
    const transaction = mockTransactionalWritePuri({ knex: { raw }, from });

    await expect(
      RequestLogModel.tryExpireStaleToolWaitingRun(
        7,
        new Date("2026-07-23T00:00:00.000Z"),
        "stale tool run",
      ),
    ).resolves.toBe(false);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(from).not.toHaveBeenCalled();
  });

  it("serializes a tool follow-up with stale cleanup in one transaction", async () => {
    const runChain = {
      select: vi.fn(),
      where: vi.fn(),
      first: vi.fn(async () => ({ status: "running" })),
    };
    runChain.select.mockReturnValue(runChain);
    runChain.where.mockReturnValue(runChain);

    const toolChain = {
      where: vi.fn(),
      update: vi.fn(async () => 1),
    };
    toolChain.where.mockReturnValue(toolChain);

    const maxChain = {
      select: vi.fn(),
      where: vi.fn(),
      first: vi.fn(async () => ({ max_step: 4 })),
    };
    maxChain.select.mockReturnValue(maxChain);
    maxChain.where.mockReturnValue(maxChain);

    const from = vi
      .fn()
      .mockReturnValueOnce(runChain)
      .mockReturnValueOnce(toolChain)
      .mockReturnValueOnce(toolChain)
      .mockReturnValueOnce(maxChain);
    const raw = vi.fn(async () => undefined);
    const transaction = mockTransactionalWritePuri({ knex: { raw }, from });

    await expect(
      RequestLogModel.continueToolRun(7, [
        { toolCallId: "call-1", output: "sunny" },
        { toolCallId: "call-2", output: "failed", isError: true },
      ]),
    ).resolves.toBe(5);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledWith("SELECT pg_advisory_xact_lock(?, ?)", [718, 7]);
    expect(raw.mock.invocationCallOrder[0]).toBeLessThan(runChain.first.mock.invocationCallOrder[0]!);
    expect(toolChain.update).toHaveBeenNthCalledWith(1, { tool_result: "sunny" });
    expect(toolChain.update).toHaveBeenNthCalledWith(2, { error: "failed" });
  });

});

describe("RequestLogModel cost provenance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * totalCost 는 확정 비용(SQL SUM)과 legacy 재계산(JS) 두 쿼리로 나뉜다.
   * @param confirmedTotal SUM 쿼리가 돌려줄 micro-USD 합계
   * @param legacyRows 재계산 대상 row 들
   */
  function mockTotalCostQueries(
    confirmedTotal: number,
    legacyRows: unknown[],
    unknownImageCostCount = 0,
    unknownCostCount = 0,
  ) {
    // subset qb 는 SELECT 를 비우고(clear) 집계/축소된 컬럼만 다시 얹는다 — 구현과 같은 체인.
    const sumChain = {
      where: vi.fn(),
      whereIn: vi.fn(),
      whereRaw: vi.fn(),
      clear: vi.fn(),
      select: vi.fn(),
      first: vi.fn(async () => ({ total: confirmedTotal, unknownImageCostCount, unknownCostCount })),
    };
    sumChain.where.mockReturnValue(sumChain);
    sumChain.whereIn.mockReturnValue(sumChain);
    sumChain.whereRaw.mockReturnValue(sumChain);
    sumChain.clear.mockReturnValue(sumChain);
    sumChain.select.mockReturnValue(sumChain);

    const legacyChain = {
      where: vi.fn(),
      whereIn: vi.fn(),
      whereRaw: vi.fn(),
      clear: vi.fn(),
      select: vi.fn(async () => legacyRows),
    };
    legacyChain.where.mockReturnValue(legacyChain);
    legacyChain.whereIn.mockReturnValue(legacyChain);
    legacyChain.whereRaw.mockReturnValue(legacyChain);
    legacyChain.clear.mockReturnValue(legacyChain);

    const getSubsetQueries = vi
      .fn()
      .mockReturnValueOnce({ qb: sumChain })
      .mockReturnValueOnce({ qb: legacyChain });
    vi.spyOn(
      RequestLogModel as unknown as { getSubsetQueries: typeof getSubsetQueries },
      "getSubsetQueries",
    ).mockImplementation(getSubsetQueries);
    return { sumChain, legacyChain };
  }

  it("uses exact stored cost for rows with a cost source", async () => {
    mockTotalCostQueries(3_000, []);

    await expect(RequestLogModel.totalCost()).resolves.toEqual({
      usd: 0.003,
      unknownImageCostCount: 0,
      unknownCostCount: 0,
    });
  });

  it("counts unpriced non-token media rows separately from unknown image costs", async () => {
    const { sumChain } = mockTotalCostQueries(3_000, [], 2, 3);

    await expect(RequestLogModel.totalCost()).resolves.toEqual({
      usd: 0.003,
      unknownImageCostCount: 2,
      unknownCostCount: 3,
    });
    const selected = sumChain.select.mock.calls[0]?.[0];
    expect(selected).toHaveProperty("unknownCostCount");
  });

  it("limits the unknown media predicate to succeeded, unpriced, zero-token non-image rows", () => {
    for (const clause of [
      "request_logs.status = 'succeeded'",
      "request_logs.cost_usd IS NULL",
      "request_logs.cost_source IS NULL",
      "request_logs.is_image_generation = false",
      "request_logs.input_tokens = 0",
      "request_logs.output_tokens = 0",
    ]) {
      expect(UNKNOWN_MEDIA_COST_PREDICATE).toContain(clause);
    }
  });

  it("sums every row in SQL without a cost_source predicate", async () => {
    const { sumChain, legacyChain } = mockTotalCostQueries(3_000, []);

    await RequestLogModel.totalCost();

    expect(sumChain.select).toHaveBeenCalledTimes(1);
    // source 없는 행도 저장된 이미지 비용을 포함하고 driver 차액만 별도로 보정한다.
    expect(sumChain.whereRaw).not.toHaveBeenCalled();
    expect(legacyChain.whereRaw).toHaveBeenCalledWith(
      "request_logs.cost_source IS NULL OR request_logs.cost_usd IS NULL",
    );
  });

  it("keeps TTL-aware price-table recomputation for legacy rows", async () => {
    mockTotalCostQueries(0, [
      {
        model_name: "claude-sonnet-4-6",
        input_tokens: 100_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 80_000,
        cache_creation_5m_tokens: 30_000,
        cache_creation_1h_tokens: 50_000,
        cost_usd: null,
        cost_source: null,
      },
    ]);

    await expect(RequestLogModel.totalCost().then((result) => result.usd)).resolves.toBeCloseTo(0.4725, 10);
  });

  it("adds only the delta for legacy rows already counted in the SQL sum", async () => {
    // 전체 SUM 이 저장값 0.2 를 이미 포함하므로, 재계산값 0.4725 와의 차액만 더해야 한다.
    mockTotalCostQueries(200_000, [
      {
        model_name: "claude-sonnet-4-6",
        input_tokens: 100_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 80_000,
        cache_creation_5m_tokens: 30_000,
        cache_creation_1h_tokens: 50_000,
        cost_usd: 200_000,
        cost_source: null,
      },
    ]);

    await expect(RequestLogModel.totalCost().then((result) => result.usd)).resolves.toBeCloseTo(0.4725, 10);
  });

  it("leaves the stored value untouched for legacy rows without a model name", async () => {
    // 모델을 모르면 재계산할 수 없다. 저장값이 SUM 에 이미 들어갔으므로 보정하지 않는다.
    mockTotalCostQueries(5_000, [
      {
        model_name: null,
        input_tokens: 100,
        output_tokens: 100,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cache_creation_5m_tokens: null,
        cache_creation_1h_tokens: null,
        cost_usd: 5_000,
        cost_source: null,
      },
    ]);

    await expect(RequestLogModel.totalCost().then((result) => result.usd)).resolves.toBeCloseTo(0.005, 10);
  });

  it("applies list filters to both cost queries so totals match the filtered list", async () => {
    const { sumChain, legacyChain } = mockTotalCostQueries(0, []);

    await RequestLogModel.totalCost({
      num: 0,
      page: 1,
      project_name: "deti",
      token_name: "openai/yds",
      model_name: "openai/gpt-5.5",
    });

    for (const chain of [sumChain, legacyChain]) {
      expect(chain.where).toHaveBeenCalledWith("request_logs.project_name", "deti");
      expect(chain.where).toHaveBeenCalledWith("request_logs.token_name", "openai/yds");
      expect(chain.where).toHaveBeenCalledWith("request_logs.model_name", "openai/gpt-5.5");
    }
  });

  it("applies the unassigned-project filter to both cost queries", async () => {
    const { sumChain, legacyChain } = mockTotalCostQueries(0, []);

    await RequestLogModel.totalCost({ num: 0, page: 1, project_name_is_null: true });

    for (const chain of [sumChain, legacyChain]) {
      expect(chain.where).toHaveBeenCalledWith("request_logs.project_name", null);
    }
  });

  it("combines the SQL-summed total with the legacy recomputation delta", async () => {
    mockTotalCostQueries(3_000, [
      {
        model_name: "claude-sonnet-4-6",
        input_tokens: 100_000,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 80_000,
        cache_creation_5m_tokens: 30_000,
        cache_creation_1h_tokens: 50_000,
        cost_usd: null,
        cost_source: null,
      },
    ]);

    await expect(RequestLogModel.totalCost().then((result) => result.usd)).resolves.toBeCloseTo(0.4755, 10);
  });
});

describe("RequestLogModel PostgreSQL", () => {
  beforeAll(async () => {
    await Sonamu.initForTesting();
  });

  it("includes image costs once and filters both stored totals and legacy adjustments", async () => {
    const projectName = `cost-${randomUUID()}`;
    const ids: number[] = [];
    try {
      for (const [index, costs] of [
        { cost_usd: 5_000, image_cost_usd: 10_000, cost_source: "provider" },
        { cost_usd: 1_000, image_cost_usd: 20_000, cost_source: null },
        { cost_usd: 900_000, image_cost_usd: 700_000, cost_source: null },
        { cost_usd: 1_000, image_cost_usd: null, cost_source: "provider", is_image_generation: true },
        { cost_usd: 2_000, image_cost_usd: null, cost_source: "provider", is_image_generation: false },
        { cost_usd: 500_000, image_cost_usd: null, cost_source: "provider", is_image_generation: true },
      ].entries()) {
        const id = await RequestLogModel.createRun({
          user_prompt: "cost regression",
          project_name: index === 2 || index === 5 ? `${projectName}-other` : projectName,
        });
        ids.push(id);
        await RequestLogModel.getPuri("w").table("request_logs").where("id", id).update({
          ...costs,
          model_name: "anthropic/claude-sonnet-4-6",
          token_name: "anthropic/test",
          input_tokens: 1_000,
        });
      }

      const params = { sonamuFilter: { project_name: projectName }, num: 0, page: 1 };
      const { rows } = await RequestLogModel.findMany("C", params);
      expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining([ids[0], ids[1], ids[3], ids[4]]));
      expect(rows).toHaveLength(4);
      // .038 known images + .001 hosted driver + .002 text; other project excluded.
      const total = await RequestLogModel.totalCost(params);
      expect(total.usd).toBeCloseTo(0.041, 10);
      expect(total.unknownImageCostCount).toBe(1);
    } finally {
      await RequestLogModel.del(ids);
    }
  });

  it("counts succeeded unpriced zero-token media rows as unknown cost", async () => {
    const projectName = `unknown-cost-${randomUUID()}`;
    const ids: number[] = [];
    try {
      for (const fields of [
        // counted: Grok TTS/STT without provider cost
        { status: "succeeded", cost_usd: null, cost_source: null, input_tokens: 0, output_tokens: 0 },
        // excluded: failed run, priced media, token-bearing legacy row, unknown image
        { status: "error", cost_usd: null, cost_source: null, input_tokens: 0, output_tokens: 0 },
        { status: "succeeded", cost_usd: 7_000, cost_source: "provider", input_tokens: 0, output_tokens: 0 },
        { status: "succeeded", cost_usd: null, cost_source: null, input_tokens: 10, output_tokens: 0 },
        {
          status: "succeeded",
          cost_usd: 0,
          cost_source: null,
          input_tokens: 0,
          output_tokens: 0,
          is_image_generation: true,
          image_cost_usd: null,
        },
      ] as const) {
        const id = await RequestLogModel.createRun({ user_prompt: "unknown cost", project_name: projectName });
        ids.push(id);
        await RequestLogModel.getPuri("w")
          .table("request_logs")
          .where("id", id)
          .update({ ...fields, model_name: "grok/tts", token_name: "grok/test" });
      }

      const total = await RequestLogModel.totalCost({ sonamuFilter: { project_name: projectName }, num: 0, page: 1 });
      expect(total.unknownCostCount).toBe(1);
      expect(total.unknownImageCostCount).toBe(1);
    } finally {
      await RequestLogModel.del(ids);
    }
  });

  it("prices unsourced finishRun and save costs at write time but keeps unknown media unpriced", async () => {
    const projectName = `write-cost-${randomUUID()}`;
    const ids: number[] = [];
    const read = (id: number) =>
      RequestLogModel.getPuri("r")
        .from("request_logs")
        .select({ cost_usd: "cost_usd", cost_source: "cost_source" })
        .where("id", id)
        .first();
    try {
      const priced = await RequestLogModel.createRun({ user_prompt: "priced", project_name: projectName });
      const media = await RequestLogModel.createRun({ user_prompt: "media", project_name: projectName });
      ids.push(priced, media);
      // Sonnet 4.6: 1K input × $3 + 1K output × $15 = $0.018; a source-less caller cost is re-priced.
      await RequestLogModel.finishRun(priced, {
        status: "succeeded",
        token_name: "anthropic/test",
        model_name: "claude-sonnet-4-6",
        input_tokens: 1_000,
        output_tokens: 1_000,
        cost_usd: 1,
      });
      await RequestLogModel.finishRun(media, {
        status: "succeeded",
        token_name: "grok/test",
        model_name: "grok/tts",
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: null,
        cost_source: null,
      });
      expect(await read(priced)).toEqual({ cost_usd: 18_000, cost_source: "pricing_table" });
      expect(await read(media)).toEqual({ cost_usd: null, cost_source: null });

      const saved = (
        await RequestLogModel.save([
        {
          user_prompt: "saved",
          project_name: projectName,
          token_name: "anthropic/test",
          model_name: "claude-sonnet-4-6",
          input_tokens: 1_000,
          output_tokens: 1_000,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          cost_usd: null,
          cost_source: null,
        } as Parameters<typeof RequestLogModel.save>[0][number],
        ])
      )[0]!;
      ids.push(saved);
      expect(await read(saved)).toEqual({ cost_usd: 18_000, cost_source: "pricing_table" });
    } finally {
      await RequestLogModel.del(ids);
    }
  });

  it("prices an expired run whose generate steps carried no cost source", async () => {
    const id = await RequestLogModel.createRun({ user_prompt: "stale external run" });
    try {
      await RequestLogModel.recordRunProgress(id, { token_name: "anthropic/test", model_name: "claude-sonnet-4-6" });
      await RequestLogModel.appendStep(id, { step_index: 0, type: "generate", input_tokens: 1_000, output_tokens: 1_000 });
      await RequestLogModel.appendStep(id, { step_index: 1, type: "tool_call", tool_call_id: "call-1", tool_name: "t" });

      await expect(
        RequestLogModel.tryExpireStaleToolWaitingRun(id, new Date(Date.now() + 60_000), "stale"),
      ).resolves.toBe(true);
      const row = await RequestLogModel.getPuri("r")
        .from("request_logs")
        .select({ cost_usd: "cost_usd", cost_source: "cost_source" })
        .where("id", id)
        .first();
      expect(row).toEqual({ cost_usd: 18_000, cost_source: "pricing_table" });
    } finally {
      await RequestLogModel.del([id]);
    }
  });

  it("lists distinct project and model names in ascending order without NULL", async () => {
    const prefix = `distinct-${randomUUID()}`;
    const ids: number[] = [];
    try {
      for (const project of [`${prefix}-b`, `${prefix}-a`, `${prefix}-b`, null]) {
        const id = await RequestLogModel.createRun({ user_prompt: "distinct", project_name: project ?? undefined });
        ids.push(id);
        await RequestLogModel.recordRunProgress(id, { model_name: `${prefix}-model` });
      }

      const projects = (await RequestLogModel.distinctProjectNames()).filter((name) => name.startsWith(prefix));
      expect(projects).toEqual([`${prefix}-a`, `${prefix}-b`]);
      expect((await RequestLogModel.distinctModelNames()).filter((name) => name.startsWith(prefix))).toEqual([
        `${prefix}-model`,
      ]);
      const all = await RequestLogModel.distinctProjectNames();
      expect(all).toEqual([...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    } finally {
      await RequestLogModel.del(ids);
    }
  });

  it("does not expire a run while another connection holds its follow-up lock", async () => {
    const wdb = RequestLogModel.getPuri("w");
    const client = new Client(wdb.knex.client.config.connection as ClientConfig);
    const requestLogId = 987_654_321;
    let connected = false;

    try {
      await client.connect();
      connected = true;
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [718, requestLogId]);

      const threshold = new Date(Date.now() + 60_000);
      await expect(
        RequestLogModel.tryExpireStaleToolWaitingRun(
          requestLogId,
          threshold,
          "stale tool run",
        ),
      ).resolves.toBe(false);
    } finally {
      if (connected) {
        await client.query("ROLLBACK").catch(() => {});
        await client.end().catch(() => {});
      }
    }
  });
});
