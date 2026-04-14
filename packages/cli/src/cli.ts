#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

const program = new Command();
program.name("qgrid").version("0.1.0").description("Qgrid — LLM subscription token proxy server");

function checkCommand(cmd: string): boolean {
  try {
    execSync(`${cmd} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

program
  .name("qgrid")
  .version("1.1.0")
  .description("Qgrid — LLM subscription token proxy server")
  .option("--db <url>", "PostgreSQL connection URL (e.g. postgres://user:pw@host:port/dbname)")
  .option("-p, --port <port>", "server port")
  .action(async (opts) => {
    const __dirname = dirname(fileURLToPath(import.meta.url));

    // --db URL 파싱 → QGRID_DB_* 환경변수로 변환
    if (opts.db) {
      const url = new URL(opts.db);
      process.env.QGRID_DB_HOST = url.hostname;
      process.env.QGRID_DB_PORT = url.port || "5432";
      process.env.QGRID_DB_USER = url.username;
      process.env.QGRID_DB_PASSWORD = url.password;
      process.env.QGRID_DB_NAME = url.pathname.slice(1); // remove leading /
    }

    if (opts.port) {
      process.env.PORT = opts.port;
    }

    // claude CLI 사전 체크
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

    try {
      await import(serverEntry);
    } catch (e) {
      console.error("Failed to start server:", (e as Error).stack ?? (e as Error).message);
      process.exit(1);
    }
  });

program.parse();
