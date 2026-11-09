import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadVerified, warnMissingSpeechAligner } from "./aligner";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("downloadVerified", () => {
  it("keeps the file only when it matches the integrity hash", async () => {
    const body = "model bytes";
    const integrity = `sha256-${createHash("sha256").update(body).digest("base64")}`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    const path = join(mkdtempSync(join(tmpdir(), "qgrid-aligner-")), "models", "m.onnx");

    await expect(downloadVerified("https://example.test/m", path, `sha256-${"A".repeat(43)}=`)).rejects.toThrow(
      "integrity mismatch",
    );
    expect(existsSync(path) || existsSync(`${path}.download`)).toBe(false);

    await downloadVerified("https://example.test/m", path, integrity);
    expect(readFileSync(path, "utf8")).toBe(body);
  });
});

describe("warnMissingSpeechAligner", () => {
  it("points to the install flag when the model is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    warnMissingSpeechAligner({ QGRID_ALIGNER_MODEL: "/nonexistent/mms-300m-fa-int8.onnx" });

    expect(warn.mock.calls.join("\n")).toContain("qgrid --install-aligner");
  });
});
