/**
 * request_logs 의 출처 없는 driver 비용을 가격표 비용으로 1회 확정한다.
 *
 * totalCost 는 지금 `cost_source IS NULL OR cost_usd IS NULL` 행을 매 요청 JS 로 재계산한다.
 * 쓰기 경로와 같은 규칙(resolvePricingCost)으로 저장해 두면 그 재계산 보정이 0 이 되어 읽기 경로를
 * 제거할 수 있다. 저장값은 재계산 결과와 같으므로 백필 전후 총비용은 변하지 않는다.
 *
 * - 기본은 dry-run: 분류와 변경 대상 건수·금액 차이만 출력한다.
 * - `--apply`: id 범위 배치로 갱신한다. 이미 출처가 생긴 행은 건너뛰므로 재실행해도 안전하다.
 * - running 행은 finishRun 이 확정하므로 건드리지 않는다.
 *
 * Usage (repo root):
 *   mise exec -- pnpm exec tsx scripts/backfill-request-log-costs.ts
 *   mise exec -- pnpm exec tsx scripts/backfill-request-log-costs.ts --apply
 * DB 접속은 packages/api/.env 의 SONAMU_DB_* (SONAMU_DB_NAME 기본 qgrid) 를 따른다.
 */
import path from "node:path";

import dotenv from "dotenv";
import { Client } from "pg";

import {
  MICRO_USD,
  resolvePricingCost,
  type RequestLogUsageRow,
} from "../packages/api/src/application/request-log/request-log-cost";

dotenv.config({ path: path.join(__dirname, "../packages/api/.env") });

const apply = process.argv.includes("--apply");
const BATCH_SIZE = 1_000;

const LEGACY = "(cost_source IS NULL OR cost_usd IS NULL) AND status <> 'running'";

type Row = RequestLogUsageRow & { id: number };

async function main(): Promise<void> {
  const client = new Client({
    host: process.env.SONAMU_DB_HOST ?? "localhost",
    port: Number(process.env.SONAMU_DB_PORT ?? 5432),
    user: process.env.SONAMU_DB_USER ?? "postgres",
    password: process.env.SONAMU_DB_PASSWORD ?? "postgres",
    database: process.env.SONAMU_DB_NAME ?? "qgrid",
    application_name: "qgrid-backfill-request-log-costs",
  });

  await client.connect();

  try {
    console.log(`database=${client.database} mode=${apply ? "apply" : "dry-run"}`);

    const classes = await client.query(`
      SELECT status, cost_usd IS NULL AS cost_null, cost_source IS NULL AS source_null,
        model_name IS NULL AS model_null, (input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) > 0 AS has_usage,
        count(*)::int AS rows
      FROM request_logs WHERE ${LEGACY}
      GROUP BY 1, 2, 3, 4, 5 ORDER BY rows DESC`);

    console.table(classes.rows);

    let lastId = 0;
    let changed = 0;
    let deltaMicroUsd = 0;

    for (;;) {
      const { rows } = await client.query<Row>(
        `SELECT id, token_name, model_name, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
           cache_creation_5m_tokens, cache_creation_1h_tokens, cost_usd, cost_source
         FROM request_logs WHERE ${LEGACY} AND id > $1 ORDER BY id LIMIT $2`,
        [lastId, BATCH_SIZE],
      );

      if (rows.length === 0) break;
      lastId = rows.at(-1)!.id;

      const updates = rows.flatMap((row) => {
        const resolved = resolvePricingCost(row);

        return resolved
          ? [{ id: row.id, ...resolved, previous: Math.max(row.cost_usd ?? 0, 0) }]
          : [];
      });

      changed += updates.length;
      deltaMicroUsd += updates.reduce((sum, u) => sum + u.cost_usd - u.previous, 0);

      if (!apply || updates.length === 0) continue;

      await client.query("BEGIN");

      for (const u of updates) {
        // 동시에 finishRun 등이 출처를 채웠다면 덮어쓰지 않는다.
        await client.query(
          `UPDATE request_logs SET cost_usd = $2, cost_source = $3
           WHERE id = $1 AND (cost_source IS NULL OR cost_usd IS NULL) AND status <> 'running'`,
          [u.id, u.cost_usd, u.cost_source],
        );
      }

      await client.query("COMMIT");
    }

    console.log(
      `${apply ? "updated" : "would update"} ${changed} rows; stored total changes by $${(deltaMicroUsd / MICRO_USD).toFixed(6)}` +
        " (equal to the current read-time legacy adjustment)",
    );
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
