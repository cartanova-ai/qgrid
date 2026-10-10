import { existsSync, readFileSync } from "node:fs";

// Start the packaged server directly: CLI startup updates installed packages.
const secretPath = "/run/secrets/qgrid-env";
if (existsSync(secretPath)) {
  Object.assign(process.env, JSON.parse(readFileSync(secretPath, "utf8")));
}

const databaseDefaults = {
  HOST: "localhost",
  PORT: "5432",
  USER: "postgres",
  PASSWORD: "postgres",
  NAME: "qgrid",
};
for (const [suffix, defaultValue] of Object.entries(databaseDefaults)) {
  process.env[`SONAMU_DB_${suffix}`] =
    process.env[`QGRID_DB_${suffix}`] ?? process.env[`SONAMU_DB_${suffix}`] ?? defaultValue;
}

process.env.INIT_CWD = "/usr/local/lib/node_modules/@cartanova/qgrid-cli/bundle";
process.env.HOST ??= "0.0.0.0";
process.env.PORT ??= "44900";
process.env.NODE_ENV ??= "production";
await import(`${process.env.INIT_CWD}/dist/index.js`);
