# Repository Toolchain

- The root `mise.toml` resolves automatically from every repository subdirectory.
- Set up tools with `mise install --locked node npm:pnpm`.
- Run project tasks with `mise run <task>`.
- Run raw or package-local `node`, `npm`, `npx`, or `pnpm` commands with `mise exec -- <command>`.
- Never invoke the host Node.js toolchain directly. Commands intentionally run inside publication containers, if any, are exempt.

# Release Versioning

- Effective 2026-10-26: keep the major version fixed unless the user explicitly changes this policy.
- Bump the minor version when clients need to upgrade `@cartanova/qgrid-ai-sdk` to receive the change; reset patch to zero.
- Use a patch bump for every other release, including server, routing, dashboard, or operational fixes that do not require a client SDK upgrade.
- Follow this project policy rather than inferring the bump from conventional-commit type or generic SemVer rules.
