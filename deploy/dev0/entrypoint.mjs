import { readFileSync } from "node:fs";

// Start the packaged server directly: CLI startup updates installed packages.
Object.assign(process.env, JSON.parse(readFileSync("/run/secrets/qgrid-env", "utf8")));
for (const suffix of ["HOST", "PORT", "USER", "PASSWORD", "NAME"]) {
  process.env[`SONAMU_DB_${suffix}`] = process.env[`QGRID_DB_${suffix}`];
}
process.env.INIT_CWD = "/usr/local/lib/node_modules/@cartanova/qgrid-cli/bundle";
process.env.PORT = "44900";
await import(`${process.env.INIT_CWD}/dist/index.js`);
