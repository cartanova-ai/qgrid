import { jsonSchemaToZod } from "json-schema-to-zod";
import {
  api,
  asArray,
  BadRequestException,
  BaseModelClass,
  type ListResult,
  normalizeFilterQuery,
  NotFoundException,
  Puri,
  transactional,
} from "sonamu";
import { z } from "zod";

import { SD } from "../../i18n/sd.generated";
import { calculateCostUsd } from "../../utils/providers/common/model-cost";
import {
  isJsonObject,
  isProviderId,
  type JsonValue,
  jsonValueSchema,
  type ProviderId,
} from "../../utils/providers/common/provider-types";
import { type RequestLogStepSaveParams } from "../request-log-step/request-log-step.types";
import { type RequestLogSubsetKey, type RequestLogSubsetMapping } from "../sonamu.generated";
import { requestLogLoaderQueries, requestLogSubsetQueries } from "../sonamu.generated.sso";
import { renderJsonSchemaZodText, renderParsedJsonSchemaTypeText } from "./json-schema-type-text";
import {
  MICRO_USD,
  normalizedUsageForCost,
  resolvePricingCost,
  type RequestLogUsageRow,
} from "./request-log-cost";
import {
  type HistoryItems,
  type RequestLogListParams,
  type RequestLogSaveParams,
  type InputImages,
  ToolDefinitions,
  type ToolView,
} from "./request-log.types";
import { formatZodCode } from "./zod-code-format";

export { MICRO_USD };

const REQUEST_LOG_RUN_LOCK_CLASS_ID = 718;
const TOOL_ENUM_VALUE_LIMIT = 6;

/**
 * 비용을 알 수 없는 non-token 요청(Grok STT/TTS, ticks 없는 video). provider 비용 없이
 * 토큰 0 으로 성공 저장되므로 SUM 은 건너뛰고 legacy 재계산도 $0 으로 매긴다 — 합계에
 * 빠졌다는 신호를 따로 센다. 실패/중단/진행 중 row 는 과금 대상이 아니라 제외하고,
 * 이미지 row 는 `unknownImageCostCount` 가 이미 센다.
 */
export const UNKNOWN_MEDIA_COST_PREDICATE =
  "request_logs.status = 'succeeded' AND request_logs.cost_usd IS NULL AND request_logs.cost_source IS NULL" +
  " AND request_logs.is_image_generation = false AND request_logs.input_tokens = 0 AND request_logs.output_tokens = 0";

/** Numeric aggregate column that node-postgres may deliver as bigint text. */
const bigintAggregate = z.coerce.number();

function decodeStoredTools(
  value: ToolDefinitions | string | null | undefined,
): ToolDefinitions | null {
  if (!value) return null;

  if (Array.isArray(value)) return value;

  try {
    return ToolDefinitions.safeParse(JSON.parse(value)).data ?? null;
  } catch {
    return null;
  }
}

type ToolResultContinuation = {
  toolCallId: string;
  output: string;
  isError?: boolean;
};

type RequestLogRunRow = Partial<RequestLogSaveParams>;

export type RequestLogStatus = NonNullable<RequestLogSaveParams["status"]>;

/** Step columns the caller supplies; `request_log_id` is bound by `appendStep`. */
export type RequestLogStepFields = Partial<Omit<RequestLogStepSaveParams, "request_log_id">> &
  Pick<RequestLogStepSaveParams, "step_index" | "type">;

export interface FinishRunParams {
  status: RequestLogStatus;
  response?: string;
  token_name?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cache_creation_5m_tokens?: number | null;
  cache_creation_1h_tokens?: number | null;
  duration_ms?: number;
  requested_model_name?: string | null;
  model_name?: string | null;
  service_tier?: string | null;
  fallback_count?: number | null;
  cost_usd?: number | null;
  cost_source?: string | null;
  history?: HistoryItems;
  error_message?: string;
  tool_call_count?: number;
  image_cost_usd?: number | null;
  image_cost_method?: string | null;
  is_image_generation?: boolean;
  response_json_ok?: boolean | null;
}

type FinishRunUpdate = Partial<FinishRunParams> & { id: number; ttft_ms?: number };

export type RunProgressUpdate = { token_name?: string; model_name?: string; ttft_ms?: number };

/** Copies `key` only when the caller supplied it, so omitted columns stay untouched. */
function copyDefined<T>(target: Partial<T>, source: T, key: keyof T): void {
  if (source[key] !== undefined) target[key] = source[key];
}

type RequestLogStepAggregate = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cache_creation_5m_tokens?: number;
  cache_creation_1h_tokens?: number;
  duration_ms: number;
  fallback_count: number;
  cost_usd: number;
  cost_source?: string;
};

const STEP_AGGREGATE_SELECT = {
  input_tokens: "input_tokens",
  output_tokens: "output_tokens",
  cache_read_tokens: "cache_read_tokens",
  cache_creation_tokens: "cache_creation_tokens",
  cache_creation_5m_tokens: "cache_creation_5m_tokens",
  cache_creation_1h_tokens: "cache_creation_1h_tokens",
  duration_ms: "duration_ms",
  fallback_count: "fallback_count",
  cost_usd: "cost_usd",
  cost_source: "cost_source",
} as const;

type StepAggregateNumberField = Exclude<keyof typeof STEP_AGGREGATE_SELECT, "cost_source">;

type StepAggregateRow = { [K in StepAggregateNumberField]: number | null } & {
  cost_source: string | null;
};

function aggregateGenerateStepRows(rows: StepAggregateRow[]): RequestLogStepAggregate {
  const sum = (field: StepAggregateNumberField): number =>
    rows.reduce((total, row) => total + (row[field] ?? 0), 0);

  const optionalSum = (field: StepAggregateNumberField): number | undefined =>
    rows.some((row) => row[field] !== null) ? sum(field) : undefined;

  const costSources = [
    ...new Set(rows.flatMap((row) => (row.cost_source ? [row.cost_source] : []))),
  ];

  const aggregate: RequestLogStepAggregate = {
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    cache_read_tokens: sum("cache_read_tokens"),
    cache_creation_tokens: sum("cache_creation_tokens"),
    cache_creation_5m_tokens: optionalSum("cache_creation_5m_tokens"),
    cache_creation_1h_tokens: optionalSum("cache_creation_1h_tokens"),
    duration_ms: sum("duration_ms"),
    fallback_count: sum("fallback_count"),
    cost_usd: sum("cost_usd"),
  };

  if (costSources.length > 0) {
    aggregate.cost_source = costSources.length === 1 ? costSources[0] : "mixed";
  }

  return aggregate;
}

/** Provider of a provider-qualified model id (`openai/`, `anthropic/`, `grok/`); legacy ids are unknown. */
export function providerOfModelName(modelName: string | null | undefined): ProviderId | "unknown" {
  const slash = modelName?.indexOf("/") ?? -1;
  const prefix = slash > 0 ? modelName?.slice(0, slash) : undefined;

  return isProviderId(prefix) ? prefix : "unknown";
}

function normalizeLegacyAnthropicRow<T extends RequestLogUsageRow>(row: T): T {
  // 새 row 는 당시의 provider/가격표 비용을 확정 저장한다. 현재 가격표로 덮어쓰지 않는다.
  if (row.cost_source) return row;
  const usage = normalizedUsageForCost(row);

  if (usage.inputTokens === row.input_tokens) return row;
  const normalized = { ...row, input_tokens: usage.inputTokens };

  if (usage.model) {
    normalized.cost_usd = Math.round(calculateCostUsd(usage.model, usage) * MICRO_USD);
  }

  return normalized;
}

/**
 * `orderBy` enum 값(`컬럼-방향`)을 정렬 절로 옮긴다.
 *
 * enum 이 18 종이라 케이스를 일일이 적는 대신 파싱하되, 컬럼은 아래 목록으로 한정한다 —
 * 문자열을 그대로 컬럼명에 넘기면 enum 이 바뀔 때 검증 없는 식별자가 SQL 로 흘러든다.
 * 목록에 없는 값은 기본 정렬(id desc)로 떨어진다.
 */
const ORDERABLE_COLUMNS = {
  id: "request_logs.id",
  created_at: "request_logs.created_at",
  ttft_ms: "request_logs.ttft_ms",
  duration_ms: "request_logs.duration_ms",
  input_tokens: "request_logs.input_tokens",
  output_tokens: "request_logs.output_tokens",
  cache_read_tokens: "request_logs.cache_read_tokens",
  cache_creation_tokens: "request_logs.cache_creation_tokens",
  cost_usd: "request_logs.cost_usd",
} as const;

const ORDERABLE_COLUMN_BY_KEY = new Map(Object.entries(ORDERABLE_COLUMNS));

function applyOrderBy(
  qb: ReturnType<RequestLogModelClass["getSubsetQueries"]>["qb"],
  orderBy: string,
): void {
  const separator = orderBy.lastIndexOf("-");
  const key = orderBy.slice(0, separator);
  const direction = orderBy.slice(separator + 1) === "asc" ? "asc" : "desc";
  const column = ORDERABLE_COLUMN_BY_KEY.get(key);

  if (!column) {
    qb.orderBy("request_logs.id", "desc");

    return;
  }

  qb.orderBy(column, direction);

  // 동점 행의 순서가 페이지마다 흔들리지 않게 고유 컬럼으로 tie-break 한다.
  if (key !== "id") qb.orderBy("request_logs.id", "desc");
}

/*
  RequestLog Model
*/
class RequestLogModelClass extends BaseModelClass<
  RequestLogSubsetKey,
  RequestLogSubsetMapping,
  typeof requestLogSubsetQueries,
  typeof requestLogLoaderQueries
> {
  constructor() {
    super("RequestLog", requestLogSubsetQueries, requestLogLoaderQueries);
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "RequestLog" })
  async findById<T extends RequestLogSubsetKey>(
    subset: T,
    id: number,
  ): Promise<RequestLogSubsetMapping[T]> {
    const { rows } = await this.findMany(subset, {
      id,
      num: 1,
      page: 1,
      queryMode: "list",
    });

    if (!rows[0]) {
      throw new NotFoundException(SD("error.entityNotFound")("RequestLog", id));
    }

    return rows[0];
  }

  async findOne<T extends RequestLogSubsetKey>(
    subset: T,
    listParams: RequestLogListParams,
  ): Promise<RequestLogSubsetMapping[T] | null> {
    const { rows } = await this.findMany(subset, {
      ...listParams,
      num: 1,
      page: 1,
      queryMode: "list",
    });

    return rows[0] ?? null;
  }

  /**
   * 목록 필터의 단일 정의. findMany 와 totalCost 가 같은 조건을 보도록 공유한다 —
   * 화면에서 필터를 걸면 행 수와 비용이 함께 좁혀져야 하는데, 두 쿼리가 각자 필터를
   * 구현하면 한쪽에 축을 추가할 때 조용히 어긋난다.
   */
  applyListFilters(
    qb: ReturnType<RequestLogModelClass["getSubsetQueries"]>["qb"],
    params: RequestLogListParams,
  ): void {
    if (params.id) {
      qb.whereIn("request_logs.id", asArray(params.id));
    }

    if (params.token_name) {
      qb.where("request_logs.token_name", params.token_name);
    }

    if (params.project_name_is_null) {
      qb.where("request_logs.project_name", null);
    } else if (params.project_name_is_not_null) {
      qb.where("request_logs.project_name", "!=", null);
    } else if (params.project_name) {
      qb.where("request_logs.project_name", params.project_name);
    }

    if (params.model_name) {
      qb.where("request_logs.model_name", params.model_name);
    }

    if (params.search && params.keyword && params.keyword.length > 0) {
      if (params.search === "id") {
        qb.where("request_logs.id", Number(params.keyword));
      } else if (params.search === "token_name") {
        qb.where("request_logs.token_name", "like", `%${params.keyword}%`);
      } else if (params.search === "user_prompt") {
        qb.where("request_logs.user_prompt", "like", `%${params.keyword}%`);
      } else {
        throw new BadRequestException(SD("error.unknownSearchField")(params.search));
      }
    }
  }

  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"], resourceName: "RequestLogs" })
  async findMany<T extends RequestLogSubsetKey, LP extends RequestLogListParams>(
    subset: T,
    rawParams?: LP,
  ): Promise<ListResult<LP, RequestLogSubsetMapping[T]>> {
    const params = {
      num: 24,
      page: 1,
      search: "id" as const,
      orderBy: "id-desc" as const,
      ...rawParams,
    } satisfies RequestLogListParams;

    const { qb } = this.getSubsetQueries(subset);

    this.applyListFilters(qb, params);

    if (params.orderBy) applyOrderBy(qb, params.orderBy);

    const enhancers = this.createEnhancers({
      A: (row) => normalizeLegacyAnthropicRow(row),
      C: (row) => normalizeLegacyAnthropicRow(row),
    });

    return this.executeSubsetQuery({
      subset,
      qb,
      params,
      enhancers,
    });
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async save(spa: RequestLogSaveParams[]): Promise<number[]> {
    const wdb = this.getPuri("w");

    // register — 출처 없는 비용은 finishRun 과 같은 규칙으로 쓰기 시점에 확정한다.
    for (const sp of spa) wdb.ubRegister("request_logs", { ...sp, ...resolvePricingCost(sp) });

    // transaction
    return wdb.transaction(async (trx) => {
      const ids = await trx.ubUpsert("request_logs");

      return ids;
    });
  }

  /**
   * 최근 구간의 provider 별 경량 통계(모니터링용). provider 는 requested_model_name 의
   * "openai/..." | "anthropic/..." prefix 로 판정한다 — serving model_name 은 prefix 가
   * 없고, running 초기엔 아직 비어 있다. 집계는 JS 에서 한다: 폴링 주기가 느슨하고
   * 구간이 짧아 row 수가 작으며, prefix CASE 식을 쿼리 빌더에 박지 않아도 된다.
   */
  async providerStatsSince(since: Date): Promise<
    Array<{
      provider: string;
      requests: number;
      errors: number;
      inputTokens: number;
      cacheReadTokens: number;
    }>
  > {
    const rdb = this.getPuri("r");

    const rows = await rdb
      .from("request_logs")
      .select({
        requested_model_name: "request_logs.requested_model_name",
        status: "request_logs.status",
        input_tokens: "request_logs.input_tokens",
        cache_read_tokens: "request_logs.cache_read_tokens",
      })
      .where("request_logs.created_at", ">=", since);

    const byProvider = new Map<
      string,
      { requests: number; errors: number; inputTokens: number; cacheReadTokens: number }
    >();

    for (const row of rows) {
      const provider = providerOfModelName(row.requested_model_name);

      const agg = byProvider.get(provider) ?? {
        requests: 0,
        errors: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
      };

      agg.requests += 1;

      if (row.status === "error") agg.errors += 1;
      agg.inputTokens += row.input_tokens;
      agg.cacheReadTokens += row.cache_read_tokens;
      byProvider.set(provider, agg);
    }

    return [...byProvider.entries()]
      .map(([provider, agg]) => ({ provider, ...agg }))
      .toSorted((a, b) => a.provider.localeCompare(b.provider));
  }

  /**
   * structured output 요청의 JSON Schema 를 표시용 타입 텍스트로 변환한다.
   * typescript 는 간결한 `type` 선언, zod 는 재구성된 zod 표현식이다 — 원본 zod
   * 소스는 wire 를 건너오며 소실되므로 refine/transform 류는 복원되지 않는다.
   * 스키마가 없거나 변환 실패면 null — 화면은 해당 블록 표시를 생략한다.
   */
  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async responseTypeTs(id: number): Promise<{
    typescript: string | null;
    zod: string | null;
  }> {
    const rdb = this.getPuri("r");

    const rows = await rdb
      .from("request_logs")
      .select({ json_schema: "request_logs.json_schema" })
      .where("request_logs.id", id);

    const schema = rows[0]?.json_schema;

    if (!schema) return { typescript: null, zod: null };

    let parsed: JsonValue;

    try {
      // JSON.parse without a reviver yields only JSON values.
      parsed = JSON.parse(schema);
    } catch {
      return { typescript: null, zod: null };
    }

    let zod: string | null = null;

    if (isJsonObject(parsed) || parsed === true || parsed === false) {
      try {
        zod = formatZodCode(jsonSchemaToZod(parsed, { module: "none" }));
      } catch {
        zod = null;
      }
    }

    return { typescript: renderParsedJsonSchemaTypeText(parsed), zod };
  }

  // ── Tool Contract View

  /**
   * 요청에 장착된 tool 계약을 detail 화면용으로 축약한다. JSONB 는 이미 decode 된
   * 배열로 오며 문자열인 경우만 방어적으로 parse 한다. 저장된 QgridTool 계약은
   * 전수 검사로 확인됐으므로 항목별 보정이나 unreadable sentinel 은 만들지 않는다.
   * 다만 `QgridTool.inputSchema` 는 `z.unknown()` 이라 키가 없거나 null 인 값도
   * wire 검증을 통과하므로 빈 스키마로 정규화한다 — SDK 는 `{}` 로 채워 보낸다.
   */
  @api({ httpMethod: "GET", clients: ["axios", "tanstack-query"] })
  async toolsView(id: number): Promise<ToolView[]> {
    const row = await this.getPuri("r")
      .from("request_logs")
      .select({ tools: "request_logs.tools" })
      .where("request_logs.id", id)
      .first();

    const tools = decodeStoredTools(row?.tools);

    if (!tools) return [];

    return tools.map((tool) => {
      const inputSchema = jsonValueSchema.safeParse(tool.inputSchema ?? {}).data ?? {};

      const inputZod = renderJsonSchemaZodText(inputSchema, TOOL_ENUM_VALUE_LIMIT);
      const fullInputZod = renderJsonSchemaZodText(inputSchema);

      const properties =
        isJsonObject(inputSchema) && isJsonObject(inputSchema.properties)
          ? inputSchema.properties
          : {};

      const view: ToolView = {
        name: tool.name,
        parameterCount: Object.keys(properties).length,
        inputZod,
      };

      if (tool.description !== undefined) view.description = tool.description;

      if (inputZod !== fullInputZod) view.fullInputZod = fullInputZod;

      return view;
    });
  }

  // ── Run Lifecycle ──────────────────────────────────────────────

  async createRun(params: {
    user_prompt: string;
    system_prompt?: string | null;
    requested_model_name?: string | null;
    effort?: string | null;
    service_tier?: string | null;
    project_name?: string | null;
    history?: HistoryItems;
    input_images?: InputImages;
    tools?: ToolDefinitions;
    is_image_generation?: boolean;
    is_structured?: boolean;
    json_schema?: string | null;
  }): Promise<number> {
    const wdb = this.getPuri("w");

    const row: RequestLogRunRow = {
      user_prompt: params.user_prompt,
      system_prompt: params.system_prompt ?? null,
      // provider 실행 전이므로 serving model은 아직 알 수 없다.
      requested_model_name: params.requested_model_name ?? null,
      model_name: null,
      effort: params.effort ?? null,
      service_tier: params.service_tier ?? null,
      project_name: params.project_name ?? null,
      status: "running",
      response: "",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      duration_ms: 0,
      tool_call_count: 0,
      // 이미지 turn 식별(R13). run 경로(tools+image 조합)도 auto 경로와 동일하게 마킹.
      is_image_generation: params.is_image_generation ?? false,
      json_schema: params.json_schema ?? null,
      is_structured:
        params.is_structured ?? (params.json_schema !== null && params.json_schema !== undefined),
    };

    if (params.history !== undefined) row.history = params.history;

    if (params.input_images) row.input_images = params.input_images;

    if (params.tools !== undefined) row.tools = params.tools;
    wdb.ubRegister("request_logs", row);

    return wdb.transaction(async (trx) => {
      const ids = await trx.ubUpsert("request_logs");

      return ids[0]!;
    });
  }

  async appendStep(requestLogId: number, step: RequestLogStepFields): Promise<number> {
    const wdb = this.getPuri("w");
    wdb.ubRegister("request_log_steps", { request_log_id: requestLogId, ...step });

    return wdb.transaction(async (trx) => {
      const ids = await trx.ubUpsert("request_log_steps");

      if (step.type === "tool_call") {
        await trx.from("request_logs").where("id", requestLogId).increment("tool_call_count", 1);
      }

      return ids[0]!;
    });
  }

  /** Writes facts known mid-run onto a parent that is still running; finished runs stay as is. */
  async recordRunProgress(requestLogId: number, progress: RunProgressUpdate): Promise<void> {
    await this.getPuri("w")
      .from("request_logs")
      .where("id", requestLogId)
      .where("status", "running")
      .update(progress);
  }

  async finishRun(requestLogId: number, params: FinishRunParams): Promise<void> {
    if (params.status === "succeeded" && !params.token_name) {
      throw new Error("tokenName is required for succeeded runs");
    }

    const update: FinishRunUpdate = { id: requestLogId, status: params.status };

    const fields = [
      "response",
      "token_name",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_creation_tokens",
      "cache_creation_5m_tokens",
      "cache_creation_1h_tokens",
      "duration_ms",
      "requested_model_name",
      "model_name",
      "service_tier",
      "fallback_count",
      "cost_usd",
      "cost_source",
      "error_message",
      "tool_call_count",
      "image_cost_usd",
      "image_cost_method",
      "is_image_generation",
      "response_json_ok",
    ] as const;

    for (const key of fields) copyDefined(update, params, key);

    if (params.history !== undefined) update.history = params.history;
    update.ttft_ms = (await this.firstGenerateStepTtft(requestLogId)) ?? 0;

    // 서버 run 경로는 step 에서 확정한 exact cost 와 출처를 넘긴다. 출처 없이 끝난 외부/legacy
    // run 은 저장된 모델+usage 로 여기서 확정해, 읽기 경로가 다시 계산하지 않게 한다.
    if (
      (params.cost_source === undefined || params.cost_source === null) &&
      params.input_tokens !== undefined &&
      params.output_tokens !== undefined
    ) {
      const row = await this.getPuri("r")
        .from("request_logs")
        .select({ model_name: "model_name" })
        .where("id", requestLogId)
        .first();

      const resolved = resolvePricingCost({
        token_name: params.token_name,
        model_name: params.model_name ?? row?.model_name,
        input_tokens: params.input_tokens,
        output_tokens: params.output_tokens,
        cache_read_tokens: params.cache_read_tokens ?? 0,
        cache_creation_tokens: params.cache_creation_tokens ?? 0,
        cache_creation_5m_tokens: params.cache_creation_5m_tokens,
        cache_creation_1h_tokens: params.cache_creation_1h_tokens,
        cost_usd: params.cost_usd,
      });

      if (resolved) Object.assign(update, resolved);
    }

    const wdb = this.getPuri("w");
    wdb.ubRegister("request_logs", update);
    await wdb.transaction(async (trx) => {
      await trx.ubUpsert("request_logs");
    });
  }

  async firstGenerateStepTtft(requestLogId: number): Promise<number | null> {
    const row = await this.getPuri("r")
      .from("request_log_steps")
      .select({ ttft_ms: "ttft_ms" })
      .where("request_log_id", requestLogId)
      .where("type", "generate")
      .where("ttft_ms", "!=", null)
      .orderBy("step_index", "asc")
      .orderBy("id", "asc")
      .first();

    return row?.ttft_ms ?? null;
  }

  async aggregateStepUsage(requestLogId: number): Promise<RequestLogStepAggregate> {
    const rows = await this.getPuri("r")
      .from("request_log_steps")
      .select(STEP_AGGREGATE_SELECT)
      .where("request_log_id", requestLogId)
      .where("type", "generate");

    return aggregateGenerateStepRows(rows);
  }

  /**
   * Finds stale candidates, then expires each run in its own short transaction.
   * The candidate query is only a hint; the transactional operation rechecks it
   * after acquiring the advisory lock shared with tool follow-ups.
   */
  async expireStaleToolWaitingRuns(
    thresholdMs: number,
    errorMessage: string,
    limit: number = 10,
  ): Promise<number[]> {
    const threshold = new Date(Date.now() - thresholdMs);
    const candidateIds = await this.findStaleToolWaitingRunCandidates(threshold, limit);
    const expiredIds: number[] = [];

    for (const requestLogId of candidateIds) {
      if (await this.tryExpireStaleToolWaitingRun(requestLogId, threshold, errorMessage)) {
        expiredIds.push(requestLogId);
      }
    }

    return expiredIds;
  }

  async findStaleToolWaitingRunCandidates(threshold: Date, limit: number): Promise<number[]> {
    const rows = await this.getPuri("w")
      .from("request_logs")
      .join("request_log_steps", "request_logs.id", "request_log_steps.request_log_id")
      .distinct("request_logs.id")
      .select({ id: "request_logs.id" })
      .where("request_logs.status", "running")
      .where("request_log_steps.type", "tool_call")
      .where("request_log_steps.created_at", "<", threshold)
      .where("request_log_steps.tool_result", null)
      .where("request_log_steps.error", null)
      .limit(limit);

    return rows.map(({ id }) => id);
  }

  @transactional({ dbPreset: "w" })
  async tryExpireStaleToolWaitingRun(
    requestLogId: number,
    threshold: Date,
    errorMessage: string,
  ): Promise<boolean> {
    const wdb = this.getPuri("w");

    const lockResult = await wdb.knex.raw<{ rows?: Array<{ acquired?: boolean }> }>(
      "SELECT pg_try_advisory_xact_lock(?, ?) AS acquired",
      [REQUEST_LOG_RUN_LOCK_CLASS_ID, requestLogId],
    );

    if (lockResult.rows?.[0]?.acquired !== true) return false;

    // The follow-up path uses the same writer transaction lock. Recheck after
    // locking so a result committed during candidate discovery makes this a no-op.
    const unresolved = await wdb
      .from("request_log_steps")
      .select({ id: "id" })
      .where("request_log_id", requestLogId)
      .where("type", "tool_call")
      .where("created_at", "<", threshold)
      .where("tool_result", null)
      .where("error", null)
      .first();

    if (!unresolved) return false;

    const stepRows = await wdb
      .from("request_log_steps")
      .select(STEP_AGGREGATE_SELECT)
      .where("request_log_id", requestLogId)
      .where("type", "generate");

    const aggregate = aggregateGenerateStepRows(stepRows);

    const firstTtft = await wdb
      .from("request_log_steps")
      .select({ ttft_ms: "ttft_ms" })
      .where("request_log_id", requestLogId)
      .where("type", "generate")
      .where("ttft_ms", "!=", null)
      .orderBy("step_index", "asc")
      .orderBy("id", "asc")
      .first();

    const expiry: Partial<RequestLogSaveParams> = {
      status: "error",
      error_message: errorMessage,
      input_tokens: aggregate.input_tokens,
      output_tokens: aggregate.output_tokens,
      cache_read_tokens: aggregate.cache_read_tokens,
      cache_creation_tokens: aggregate.cache_creation_tokens,
    };

    if (aggregate.cache_creation_5m_tokens !== undefined) {
      expiry.cache_creation_5m_tokens = aggregate.cache_creation_5m_tokens;
    }

    if (aggregate.cache_creation_1h_tokens !== undefined) {
      expiry.cache_creation_1h_tokens = aggregate.cache_creation_1h_tokens;
    }

    expiry.duration_ms = aggregate.duration_ms;
    expiry.fallback_count = aggregate.fallback_count;
    expiry.cost_usd = aggregate.cost_usd;

    if (aggregate.cost_source !== undefined) {
      expiry.cost_source = aggregate.cost_source;
    } else {
      // 출처 없는 외부 step 만 있던 run 은 만료 시점에 가격표 비용으로 확정한다.
      const run = await wdb
        .from("request_logs")
        .select({ token_name: "token_name", model_name: "model_name" })
        .where("id", requestLogId)
        .first();

      Object.assign(
        expiry,
        resolvePricingCost({
          ...aggregate,
          token_name: run?.token_name,
          model_name: run?.model_name,
        }),
      );
    }

    expiry.ttft_ms = firstTtft?.ttft_ms ?? 0;

    const updated = await wdb
      .from("request_logs")
      .where("id", requestLogId)
      .where("status", "running")
      .update(expiry);

    return updated > 0;
  }

  /**
   * Applies a native qgrid tool follow-up and computes its next step index while
   * holding the per-run advisory lock shared with stale cleanup.
   */
  @transactional({ dbPreset: "w" })
  async continueToolRun(
    requestLogId: number,
    toolResults: ToolResultContinuation[],
  ): Promise<number> {
    const wdb = this.getPuri("w");
    await wdb.knex.raw("SELECT pg_advisory_xact_lock(?, ?)", [
      REQUEST_LOG_RUN_LOCK_CLASS_ID,
      requestLogId,
    ]);

    const run = await wdb
      .from("request_logs")
      .select({ status: "status" })
      .where("id", requestLogId)
      .first();

    if (!run) throw new Error(`request log run ${requestLogId} not found`);

    if (run.status !== "running") {
      throw new Error(`request log run ${requestLogId} is already ${run.status}`);
    }

    for (const result of toolResults) {
      await wdb
        .from("request_log_steps")
        .where("request_log_id", requestLogId)
        .where("tool_call_id", result.toolCallId)
        .where("type", "tool_call")
        .update(result.isError ? { error: result.output } : { tool_result: result.output });
    }

    const row = await wdb
      .from("request_log_steps")
      .select({ max_step: Puri.max("step_index") })
      .where("request_log_id", requestLogId)
      .first();

    return (row?.max_step ?? -1) + 1;
  }

  /**
   * 화면 표시용 총 비용. 목록과 같은 필터를 적용한다.
   *
   * driver와 image 비용을 함께 SUM한 뒤, legacy driver 비용의 차액만 보정한다.
   * 이미지 비용은 저장값을 한 번만 포함하고 가격표 재계산 대상에서 제외한다.
   *
   * legacy 보정을 남겨둔 이유: 백필로 기존 legacy 는 0 이 되었지만, 외부 로거가
   * `AppendStepInput`/`FinishRunInput` 으로 costSource 없이 넣으면 다시 생길 수 있다.
   * 그런 row 는 저장값 대신 현재 가격표 재계산값이 맞으므로 차액을 더한다.
   *
   * 필터 조건을 여기서 다시 구현하지 않고 `applyListFilters` 를 공유하는 것이 핵심이다 —
   * 두 쿼리가 각자 필터를 가지면 화면에서 필터를 걸었을 때 행 수와 비용이 조용히 어긋난다.
   */
  async totalCost(
    rawParams: RequestLogListParams = { num: 0, page: 1 },
  ): Promise<{ usd: number; unknownImageCostCount: number; unknownCostCount: number }> {
    const params = {
      num: 0,
      page: 1,
      search: "id" as const,
      ...rawParams,
    } satisfies RequestLogListParams;

    const { qb: totalQb } = this.getSubsetQueries("C");
    this.applyListFilters(totalQb, params);

    const sonamuFilter = params.sonamuFilter
      ? normalizeFilterQuery(params.sonamuFilter)
      : undefined;

    this.applySonamuFilters(totalQb, sonamuFilter);

    // subset qb 는 컬럼 목록이 이미 SELECT 에 박혀 있어 집계를 얹으면 GROUP BY 에러가 난다.
    // executeCountQuery 와 같은 방식으로 select 를 비우고 집계만 남긴다.
    const stored = await totalQb
      .clear("select")
      // 음수 저장값(과거 버그)은 0 으로 눌러서 더한다 — JS 쪽 Math.max 와 같은 규칙.
      .select({
        total: Puri.rawNumber(
          "COALESCE(SUM(GREATEST(request_logs.cost_usd, 0) + COALESCE(request_logs.image_cost_usd, 0)), 0)",
        ),
        unknownImageCostCount: Puri.rawNumber(
          "COUNT(*) FILTER (WHERE request_logs.is_image_generation = true AND request_logs.image_cost_usd IS NULL)",
        ),
        unknownCostCount: Puri.rawNumber(`COUNT(*) FILTER (WHERE ${UNKNOWN_MEDIA_COST_PREDICATE})`),
      })
      .first();

    const { qb: legacyQb } = this.getSubsetQueries("C");
    this.applyListFilters(legacyQb, params);
    this.applySonamuFilters(legacyQb, sonamuFilter);

    const legacyRows = await legacyQb
      .whereRaw("request_logs.cost_source IS NULL OR request_logs.cost_usd IS NULL")
      .clear("select")
      .select({
        token_name: "request_logs.token_name",
        model_name: "request_logs.model_name",
        input_tokens: "request_logs.input_tokens",
        output_tokens: "request_logs.output_tokens",
        cache_read_tokens: "request_logs.cache_read_tokens",
        cache_creation_tokens: "request_logs.cache_creation_tokens",
        cache_creation_5m_tokens: "request_logs.cache_creation_5m_tokens",
        cache_creation_1h_tokens: "request_logs.cache_creation_1h_tokens",
        cost_usd: "request_logs.cost_usd",
      });

    // Postgres returns SUM/COUNT as bigint, which node-postgres delivers as text
    // even though `Puri.rawNumber` types it as number.
    const storedTotal = bigintAggregate.parse(stored?.total ?? 0) / MICRO_USD;

    // legacy row 는 위 SUM 에 저장값으로 이미 포함되어 있다. 재계산값과의 차액만 더한다.
    const usd = legacyRows.reduce((sum, row) => {
      const alreadySummed = Math.max(row.cost_usd ?? 0, 0) / MICRO_USD;
      const usage = normalizedUsageForCost(row);

      if (!usage.model) return sum;

      return (
        sum +
        calculateCostUsd(usage.model, {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          cacheCreationInputTokens5m: usage.cacheCreationInputTokens5m,
          cacheCreationInputTokens1h: usage.cacheCreationInputTokens1h,
        }) -
        alreadySummed
      );
    }, storedTotal);

    return {
      usd,
      unknownImageCostCount: bigintAggregate.parse(stored?.unknownImageCostCount ?? 0),
      unknownCostCount: bigintAggregate.parse(stored?.unknownCostCount ?? 0),
    };
  }

  async distinctProjectNames(): Promise<string[]> {
    return this.distinctIndexedValues("project_name");
  }

  async distinctModelNames(): Promise<string[]> {
    return this.distinctIndexedValues("model_name");
  }

  /**
   * Loose index scan: 컬럼 인덱스에서 다음 값만 찾아 건너뛴다. 일반 DISTINCT 는 전체 행 수에
   * 비례하지만 이 쿼리는 고유값 수에 비례한다. NULL 제외·오름차순 의미는 DISTINCT 와 같다.
   */
  private async distinctIndexedValues(column: "project_name" | "model_name"): Promise<string[]> {
    const result = await this.getPuri("r").knex.raw<{ rows: Array<{ v: string }> }>(
      `WITH RECURSIVE t AS (
        (SELECT ?? AS v FROM request_logs WHERE ?? IS NOT NULL ORDER BY ?? LIMIT 1)
        UNION ALL
        SELECT (SELECT ?? FROM request_logs WHERE ?? > t.v ORDER BY ?? LIMIT 1) FROM t WHERE t.v IS NOT NULL
      )
      SELECT v FROM t WHERE v IS NOT NULL`,
      [column, column, column, column, column, column],
    );

    return result.rows.map((row) => row.v);
  }

  @api({ httpMethod: "POST", clients: ["axios", "tanstack-mutation"] })
  async del(ids: number[]): Promise<number> {
    const wdb = this.getPuri("w");

    // transaction
    await wdb.transaction(async (trx) => {
      await trx
        .table("request_log_steps")
        .whereIn("request_log_steps.request_log_id", ids)
        .delete();

      return trx.table("request_logs").whereIn("request_logs.id", ids).delete();
    });

    return ids.length;
  }
}

export const RequestLogModel = new RequestLogModelClass();
