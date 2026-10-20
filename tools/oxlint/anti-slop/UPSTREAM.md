# anti-slop Oxlint plugin provenance

- Source repository: <https://github.com/dmmulroy/anti-slop>
- Copied from: `skills/install-anti-slop/assets/anti-slop/`, installed with that skill's `scripts/install.mjs`.
- Source revision: commit `d2a9aea3b896ffcb291a85f2c1301aa2543ad8c8` (2026-09-13), the last upstream commit touching `skills/install-anti-slop/`. Upstream HEAD `13909c9e07590f5a85d93c62712259fe14a883f7` has the same content.
- Asset tree: git tree `54b50f11bed7f52ca1948f8802f4df591644762f`. Verified with `diff -r` against the upstream clone: all copied files are byte-identical.
- Upstream license: MIT, Copyright (c) 2026 Dillon Mulroy. The vendored ESLint Stylistic rule keeps its own `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md`.

## Installed paths

- `tools/oxlint/anti-slop/index.ts` is the generic plugin, registered in `.oxlintrc.json` as `anti-slop`.
- `tools/oxlint/anti-slop/effect/` was copied but is not registered. No package manifest in this repository depends on `effect` directly.

## Intentional deviations

- Added `tools/oxlint/anti-slop/package.json` (`{"type": "module"}`). The root package has no `type` field, so without this file Node emits `MODULE_TYPELESS_PACKAGE_JSON` and reparses the plugin on every lint run.
- `@oxlint/plugins` is pinned at `1.59.0` to match the installed `oxlint`. Upstream builds against `1.78.0`. The rules load and run on 1.59.0, but `tsc` against 1.59.0 typings reports two `never` property errors (`rules/no-widen-then-assert.ts`, `shared/function-parameters.ts`). These go away with newer typings. Upgrade `oxlint` and `@oxlint/plugins` together.

## Updating

Install the upstream `install-anti-slop` skill again and follow its `references/update.md`. The skill is not kept in this repository because it is only needed at install time. Compare against an explicit upstream revision, keep the deviations above, and update this record.
