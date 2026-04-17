#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();
program
  .name("qgrid")
  .version(pkg.version)
  .description("Qgrid — LLM subscription token proxy server")
  .option("--db <url>", "PostgreSQL connection URL (e.g. postgres://user:pw@host:port/dbname)")
  .option("-p, --port <port>", "server port")
  .option("--skip-update", "skip auto-update check")
  .action(async (opts) => {
    const serverPort = opts.port ?? process.env.PORT ?? "44900";

    // check if server port is in use, if so, kill the process using it
    try {
      const pid = execSync(`lsof -ti :${serverPort}`, { encoding: "utf-8" }).trim();
      if (pid) {
        console.log(`⚡ Port ${serverPort} in use (PID ${pid}), killing...`);
        execSync(`kill -9 ${pid}`, { stdio: "ignore" });
      }
    } catch {
      // 포트 미사용 — 정상
    }

    // check latest version and self-update
    if (!opts.skipUpdate) {
      const latest = execSync("npm view @cartanova/qgrid-cli version", {
        encoding: "utf-8",
      }).trim();
      if (latest !== pkg.version) {
        console.log(`@@Updating qgrid-cli: ${pkg.version} → ${latest}@@`);
        execSync("npm i -g @cartanova/qgrid-cli@latest", { stdio: "inherit" });
        console.log("@@Updated. Restarting...\n@@");
        const args = process.argv.slice(2).concat("--skip-update");
        execSync(`qgrid ${args.join(" ")}`, { stdio: "inherit" });
        process.exit(0);
      }
    }

    //  parse --db postgres://user:password@host:port/dbname & set env vars
    if (opts.db) {
      const m = opts.db.match(/^postgres(?:ql)?:\/\/([^:]+):(.+)@([^:]+):(\d+)\/(.+)$/);
      if (!m) {
        console.error("Invalid DB URL format. Expected: postgres://user:password@host:port/dbname");
        process.exit(1);
      }
      const [, user, password, host, port, dbName] = m;
      process.env.QGRID_DB_HOST = host;
      process.env.QGRID_DB_PORT = port;
      process.env.QGRID_DB_USER = user;
      process.env.QGRID_DB_PASSWORD = password;
      process.env.QGRID_DB_NAME = dbName;
    }
    if (opts.port) {
      process.env.PORT = opts.port;
    }

    // ClaudeCode pre-check
    try {
      execSync("claude --version", { stdio: "ignore" });
    } catch {
      console.error("Error: claude CLI not found.");
      console.error("Install: npm i -g @anthropic-ai/claude-code");
      process.exit(1);
    }

    // Sonamu가 bundle/을 프로젝트 루트로 인식하도록 설정
    process.env.LR = "remote";
    const bundlePath = join(__dirname, "..", "bundle");
    const serverEntry = join(bundlePath, "dist", "index.js");
    if (!existsSync(serverEntry)) {
      console.error(`Error: Server bundle not found at ${serverEntry}`);
      console.error("Reinstall: npm i -g @cartanova/qgrid-cli");
      process.exit(1);
    }

    process.env.INIT_CWD = bundlePath;

    // DB 연결 사전 체크
    const dbHost = process.env.QGRID_DB_HOST ?? "localhost";
    const dbPort = process.env.QGRID_DB_PORT ?? "44901";
    const dbName = process.env.QGRID_DB_NAME ?? "qgrid";
    try {
      const pg = await import("pg");
      const client = new pg.default.Client({
        host: dbHost,
        port: Number(dbPort),
        user: process.env.QGRID_DB_USER ?? "postgres",
        password: process.env.QGRID_DB_PASSWORD ?? "postgres",
        database: dbName,
        connectionTimeoutMillis: 5000,
      });
      await client.connect();
      await client.end();
    } catch (e) {
      console.error(`Error: Cannot connect to PostgreSQL at ${dbHost}:${dbPort}/${dbName}`);
      console.error(`  ${(e as Error).message}`);
      console.error(`\nProvide DB connection via --db flag or QGRID_DB_* env vars:`);
      console.error(`  qgrid --db postgres://user:password@host:port/dbname`);
      process.exit(1);
    }

    try {
      await import(serverEntry);
    } catch (e) {
      console.error("Failed to start server:", (e as Error).stack ?? (e as Error).message);
      process.exit(1);
    }
  });

program.parse();
