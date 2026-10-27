import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type RequestLogSubsetP } from "@/services/sonamu.generated";

import { RequestLogTable } from "./RequestLogTable";

const hooks = vi.hoisted(() => ({
  useRequestLogs: vi.fn(),
  useTotalCost: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: unknown }) => children,
  useNavigate: () => vi.fn(),
}));

vi.mock("@/services/services.generated", () => {
  const empty = { data: undefined, refresh: vi.fn() };
  return {
    TokenService: { useTokens: () => empty },
    QgridService: {
      useProjectNames: () => empty,
      useModelNames: () => empty,
      useTotalCost: hooks.useTotalCost,
    },
    RequestLogService: { useRequestLogs: hooks.useRequestLogs },
  };
});

const row: RequestLogSubsetP = {
  id: 4242,
  created_at: new Date("2026-10-27T10:00:00Z"),
  token_name: "openai/yds",
  project_name: "deti",
  model_name: "gpt-6.1-terra",
  requested_model_name: "openai/gpt-6.1-terra",
  fallback_count: 0,
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cache_creation_5m_tokens: null,
  cache_creation_1h_tokens: null,
  duration_ms: 1200,
  ttft_ms: 300,
  cost_usd: 35,
  cost_source: "pricing_table",
  image_cost_usd: null,
  image_cost_method: null,
  effort: "low",
  service_tier: null,
  status: "succeeded",
  response_json_ok: null,
  tool_call_count: 0,
  is_image_generation: false,
  is_structured: false,
};

type Query = { data?: unknown; isLoading?: boolean; isError?: boolean };

function mockQueries({ list, count }: { list: Query; count: Query }) {
  hooks.useRequestLogs.mockImplementation((_subset: string, params: { queryMode?: string }) => ({
    isLoading: false,
    isError: false,
    isRefreshing: false,
    refresh: vi.fn(),
    ...(params.queryMode === "count" ? count : list),
  }));
}

function render() {
  return renderToStaticMarkup(
    <RequestLogTable search={{ page: 2 }} onSearchChange={() => undefined} />,
  );
}

describe("RequestLogTable", () => {
  beforeEach(() => {
    hooks.useTotalCost.mockReturnValue({ data: undefined, isError: false, refresh: vi.fn() });
  });

  it("requests rows without COUNT and the count separately with the same filters", () => {
    mockQueries({ list: { data: { rows: [row] } }, count: { data: { total: 120 } } });
    renderToStaticMarkup(
      <RequestLogTable
        search={{ page: 2, project: "deti", sort: "cost_usd-desc" }}
        onSearchChange={() => undefined}
      />,
    );

    const [[, listParams], [, countParams]] = hooks.useRequestLogs.mock.calls.slice(-2);
    expect(listParams).toMatchObject({ queryMode: "list", page: 2, orderBy: "cost_usd-desc", project_name: "deti" });
    expect(countParams).toMatchObject({ queryMode: "count", project_name: "deti" });
    expect(countParams).not.toHaveProperty("orderBy");
  });

  it("shows rows while the count is pending or failed, without pagination", () => {
    for (const count of [{ isLoading: true }, { isError: true }]) {
      mockQueries({ list: { data: { rows: [row] } }, count });
      const html = render();
      expect(html).toContain("gpt-6.1-terra");
      expect(html).toContain("— results");
      expect(html).not.toContain("2 / 3");
    }
  });

  it("enables 50-row pagination once the count arrives", () => {
    mockQueries({ list: { data: { rows: [row] } }, count: { data: { total: 120 } } });
    const html = render();
    expect(html).toContain("120 results");
    expect(html).toContain("2 / 3");
  });
});
