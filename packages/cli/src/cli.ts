#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program.name("qgrid").version("0.1.0").description("Qgrid — LLM 구독 토큰 프록시 서버");

program
  .command("start")
  .description("서버 + 대시보드 시작")
  .option("-p, --port <port>", "서버 포트", "44900")
  .action(async (opts) => {
    // claude CLI 사전 체크
    const { execSync } = await import("node:child_process");
    try {
      execSync("claude --version", { stdio: "ignore" });
    } catch {
      console.error("Error: claude CLI not found.");
      console.error("Install: npm i -g @anthropic-ai/claude-code");
      process.exit(1);
    }

    process.env.PORT = opts.port;

    // bundle 안의 빌드된 서버 실행
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const serverEntry = join(__dirname, "..", "bundle", "dist", "index.js");

    try {
      await import(serverEntry);
    } catch (e) {
      console.error("Failed to start server:", (e as Error).message);
      console.error("Run `pnpm run bundle` first, or reinstall @qgrid/cli.");
      process.exit(1);
    }
  });

program.parse();
