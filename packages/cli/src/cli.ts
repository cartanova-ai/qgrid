import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";

const QGRID_DIR = join(homedir(), ".qgrid");
const COMPOSE_FILE = join(QGRID_DIR, "docker-compose.yml");
const IMAGE = "ghcr.io/cartanova-ai/qgrid:latest";

function ensureDocker(): void {
  try {
    execSync("docker --version", { stdio: "ignore" });
  } catch {
    console.error("Error: Docker not found.");
    console.error("Install: https://docs.docker.com/get-docker/");
    process.exit(1);
  }
}

function ensureQgridDir(): void {
  if (!existsSync(QGRID_DIR)) {
    mkdirSync(QGRID_DIR, { recursive: true });
  }
}

function generateCompose(opts: {
  port: string;
  dbHost?: string;
  dbPort: string;
  dbUser: string;
  dbPassword: string;
}): string {
  const env = [
    `      DB_HOST: "${opts.dbHost ?? "postgres"}"`,
    `      DB_PORT: "${opts.dbHost ? opts.dbPort : "5432"}"`,
    `      DB_USER: "${opts.dbUser}"`,
    `      DB_PASSWORD: "${opts.dbPassword}"`,
    `      DB_NAME: "qgrid"`,
    `      HOST: "0.0.0.0"`,
    `      PORT: "${opts.port}"`,
  ].join("\n");

  let compose = `services:
  qgrid:
    image: ${IMAGE}
    ports:
      - "${opts.port}:${opts.port}"
    environment:
${env}
    restart: unless-stopped`;

  if (!opts.dbHost) {
    // 로컬 모드: PostgreSQL도 같이 띄움
    compose += `
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:18
    ports:
      - "${opts.dbPort}:5432"
    environment:
      POSTGRES_USER: ${opts.dbUser}
      POSTGRES_PASSWORD: ${opts.dbPassword}
      POSTGRES_DB: qgrid
    healthcheck:
      test: ["CMD-SHELL", "pg_isready"]
      interval: 3s
      retries: 5
    volumes:
      - qgrid-data:/var/lib/postgresql

volumes:
  qgrid-data:`;
  }

  return `${compose}\n`;
}

const program = new Command();
program.name("qgrid").version("0.1.0").description("Qgrid — LLM subscription token proxy server");

program
  .command("start")
  .description("Start Qgrid server (+ PostgreSQL if no --db-host)")
  .option("--port <port>", "server port", "44900")
  .option("--db-host <host>", "external DB host (skip local PostgreSQL)")
  .option("--db-port <port>", "DB port", "44901")
  .option("--db-user <user>", "DB user", "postgres")
  .option("--db-password <password>", "DB password", "postgres")
  .action((opts) => {
    ensureDocker();
    ensureQgridDir();

    const compose = generateCompose(opts);
    writeFileSync(COMPOSE_FILE, compose);

    console.log(
      opts.dbHost
        ? "Starting Qgrid server (external DB)..."
        : "Starting Qgrid server + PostgreSQL...",
    );

    try {
      execSync(`docker compose -f "${COMPOSE_FILE}" up -d`, { stdio: "inherit" });
      console.log(`\n✓ Qgrid is running at http://localhost:${opts.port}`);
    } catch {
      console.error("Failed to start. Check Docker is running.");
      process.exit(1);
    }
  });

program
  .command("stop")
  .description("Stop Qgrid server")
  .action(() => {
    ensureDocker();

    if (!existsSync(COMPOSE_FILE)) {
      console.log("Qgrid is not running.");
      return;
    }

    try {
      execSync(`docker compose -f "${COMPOSE_FILE}" down`, { stdio: "inherit" });
      console.log("✓ Qgrid stopped.");
    } catch {
      console.error("Failed to stop.");
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show Qgrid server status")
  .action(() => {
    ensureDocker();

    if (!existsSync(COMPOSE_FILE)) {
      console.log("Qgrid is not running.");
      return;
    }

    try {
      execSync(`docker compose -f "${COMPOSE_FILE}" ps`, { stdio: "inherit" });
    } catch {
      console.log("Qgrid is not running.");
    }
  });

program.parse();
