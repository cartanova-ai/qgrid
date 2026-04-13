import path from "path";

import { getConsoleSink } from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import dotenv from "dotenv";
import { CachePresets, defineConfig } from "sonamu";
import { drivers as cacheDrivers, store } from "sonamu/cache";
import { drivers } from "sonamu/storage";

dotenv.config({ path: path.join(import.meta.dirname, "../.env") });

const host = process.env.HOST ?? "localhost";
const port = Number(process.env.PORT ?? 44900);

export default defineConfig({
  projectName: process.env.PROJECT_NAME ?? "SonamuProject",
  database: {
    name: process.env.DB_NAME ?? "qgrid",
    defaultOptions: {
      connection: {
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 44901),
        user: process.env.DB_USER ?? "postgres",
        password: process.env.DB_PASSWORD ?? "postgres",
      },
    },
    environments: {
      production: {
        connection: {
          host: process.env.DEV0_DB_HOST,
          port: Number(process.env.DEV0_DB_PORT),
          database: process.env.DATABASE_NAME,
          user: process.env.DEV0_DB_USER,
          password: process.env.DEV0_DB_PASSWORD,
        },
      },
      fixture: {
        connection: {
          host: process.env.DEV0_DB_HOST,
          port: Number(process.env.DEV0_DB_PORT),
          database: process.env.DATABASE_NAME,
          user: process.env.DEV0_DB_USER,
          password: process.env.DEV0_DB_PASSWORD,
        },
      },
    },
  },
  api: {
    dir: "api",
    timezone: "Asia/Seoul",
    route: {
      prefix: "/api",
    },
  },
  i18n: {
    defaultLocale: "ko",
    supportedLocales: ["ko", "en"],
  },
  sync: {
    targets: ["web"],
  },
  slackConfirm:
    process.env.SLACK_BOT_TOKEN && process.env.SLACK_CHANNEL_ID
      ? {
          targets: ["development_master", "production_master"],
          botToken: process.env.SLACK_BOT_TOKEN ?? "",
          channelId: process.env.SLACK_CHANNEL_ID ?? "",
        }
      : undefined,
  test: {
    parallel: true,
    maxWorkers: 4,
    devRunner: { enabled: true },
  },
  logging: {
    sinks: {
      console: getConsoleSink({
        formatter: getPrettyFormatter({
          timestamp: "time",
          categoryWidth: 20,
          categoryTruncate: "middle",
        }),
      }),
    },
    loggers: [
      {
        category: ["sonamu"],
        sinks: ["console"],
        lowestLevel: process.env.NODE_ENV === "test" ? "warning" : "debug",
      },
    ],
  },
  server: {
    listen: { port, host },
    plugins: {
      formbody: true,
      qs: true,
      multipart: { limits: { fileSize: 1024 * 1024 * 30 } },
      static: {
        root: path.join(import.meta.dirname, "/../", "public"),
        prefix: "/api/public",
      },
      custom: (server) => {
        // OAuth 콜백 — Anthropic이 /callback으로 리다이렉트
        server.get("/callback", async (request, reply) => {
          const { code, state } = request.query as { code?: string; state?: string };
          if (!code || !state) {
            return reply.redirect("/?oauth=error&reason=missing_params");
          }
          // Frame의 oauthCallback으로 위임
          try {
            const { QgridFrame } = await import("./application/qgrid/qgrid.frame");
            await QgridFrame.handleOAuthCallback(code, state, reply);
          } catch (e) {
            return reply.redirect(
              `/?oauth=error&reason=${encodeURIComponent((e as Error).message)}`,
            );
          }
        });
      },
    },
    apiConfig: {
      contextProvider: (defaultContext, request) => {
        return {
          ...defaultContext,
          ip: request.ip,
          body: request.body,
        };
      },
      guardHandler: (_guard, _request, _api) => {
        if (_guard === "user") {
          console.log("user guard");
        }
        console.log("NOTHING YET");
      },
      cacheControlHandler: (req) => {
        switch (req.type) {
          case "assets":
            // Hash 포함된 파일: 영구 캐시
            if (req.path.match(/-[a-f0-9]+\./)) {
              return CachePresets.immutable;
            }
            return CachePresets.longLived;

          case "api":
            // GET 요청만 캐싱 고려
            if (req.method === "GET") {
              // 특정 경로는 짧은 캐시
              if (req.path.startsWith("/api/static-data")) {
                return CachePresets.shortLived;
              }
              if (req.path.startsWith("/api/terms")) {
                return CachePresets.mediumLived;
              }
            }
            // 기본: 캐시 없음
            return CachePresets.noCache;

          case "ssr":
            // SSR 페이지: 10초 캐시
            return CachePresets.ssr;

          case "csr":
            // CSR fallback (index.html): 1분 캐시
            return CachePresets.shortLived;
        }
      },
    },
    storage: {
      drivers: {
        fs: drivers.fs({
          location: path.join(import.meta.dirname, "/../public/uploaded"),
          visibility: "public",
          urlBuilder: {
            async generateURL(key) {
              return `/api/public/uploaded/${key}`;
            },
            async generateSignedURL(key) {
              return `/api/public/uploaded/${key}`;
            },
          },
        }),
        s3: drivers.s3({
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
          },
          region: process.env.S3_REGION ?? "ap-northeast-2",
          bucket: process.env.S3_BUCKET ?? "sonamu_default_bucket",
          visibility: "private",
        }),
      },
    },
    cache: {
      default: "main",
      stores: {
        main: store().useL1Layer(cacheDrivers.memory({ maxSize: "50mb" })),
      },
      ttl: "5m",
      prefix: "",
    },
    lifecycle: {
      onStart: async () => {
        const { initPool } = await import("./application/qgrid/pool");
        try {
          const { TokenModel } = await import("./application/token/token.model");
          const entries = await TokenModel.findActive("A");
          const tokens = entries.map((e) => e.token);
          const pool = initPool(tokens);
          console.log(
            `🌲 Server listening on http://${host}:${port} (${pool.workers.size} tokens loaded)`,
          );
        } catch (e) {
          console.warn(
            `⚠️ Pool init failed (tokens table may not exist yet): ${(e as Error).message}`,
          );
          initPool([]);
          console.log(`🌲 Server listening on http://${host}:${port} (no tokens)`);
        }
      },
      onShutdown: () => {
        console.log("graceful shutdown");
      },
      onError: (error, _request, reply) => {
        console.error(error);
        reply.status(500).send({
          name: error.name,
          message: error.message,
        });
      },
    },
  },
});
