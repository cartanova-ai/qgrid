import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

import { z } from "zod";

// The speech aligner times OpenAI speech and transcription: the MMS-FA int8 model (CC BY-NC 4.0)
// run by onnxruntime-node. The Docker image ships both; elsewhere `qgrid --install-aligner` puts
// them under ~/.cache/qgrid without npm or pnpm (a pnpm v11 global install cannot see a globally
// installed onnxruntime-node). Keep the paths in sync with packages/api/src/utils/speech-aligner.ts
// and the model and runtime version with deploy/docker/Dockerfile.
const QGRID_CACHE = join(homedir(), ".cache", "qgrid");
const RUNTIME_DIR = join(QGRID_CACHE, "runtime");
const ONNXRUNTIME_VERSION = "1.31.1";

/** A pinned download and its Subresource Integrity hash (`<algorithm>-<base64 digest>`). */
interface PinnedFile {
  url: string;
  integrity: string;
}

const MODEL: PinnedFile = {
  url: "https://github.com/cartanova-ai/qgrid/releases/download/aligner-model-v1/mms-300m-fa-int8.onnx",
  integrity: "sha256-2Tw7L2Lp/EKmGWSGeUTsuHMwaYgu2TUrWtLfnOJuGYo=",
};

// Integrity values are the npm registry's `dist.integrity` for these exact versions.
const RUNTIME_PACKAGES: Array<PinnedFile & { name: string }> = [
  {
    name: "onnxruntime-common",
    url: `https://registry.npmjs.org/onnxruntime-common/-/onnxruntime-common-${ONNXRUNTIME_VERSION}.tgz`,
    integrity:
      "sha512-F+nnYNiQtmNJ95V6R/isBJqiVpdANCrsMEg1OaF+Bkbl3GAtzWLR7Ng17Ld0QtYtYJyotOHPJzOQn1Y6PLZjpg==",
  },
  {
    name: "onnxruntime-node",
    url: `https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-${ONNXRUNTIME_VERSION}.tgz`,
    integrity:
      "sha512-ijnSghbDHVWaQ2nDPmVccPlCHI8kH1Mx1aJ4a/qzRP16bBcVs4E3EqZQKZCkhWnbqN1tuQWxagimFtDpbPYYQw==",
  },
];

export function alignerModelPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.QGRID_ALIGNER_MODEL || join(QGRID_CACHE, "models", "mms-300m-fa-int8.onnx");
}

/** Streams `url` to `path` through a temporary file that is kept only if it matches `integrity`. */
export async function downloadVerified(
  url: string,
  path: string,
  integrity: string,
): Promise<void> {
  const dash = integrity.indexOf("-");
  const hash = createHash(integrity.slice(0, dash));
  const response = await fetch(url);

  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} from ${url}`);
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.download`;

  try {
    await pipeline(
      response.body,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(partial),
    );
    const actual = `${integrity.slice(0, dash)}-${hash.digest("base64")}`;

    if (actual !== integrity) {
      throw new Error(`integrity mismatch for ${url}: expected ${integrity}, got ${actual}`);
    }

    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

/** Unpacks the pinned runtime packages into RUNTIME_DIR, keeping only this platform's binary. */
async function installRuntime(): Promise<void> {
  const nodeModules = join(RUNTIME_DIR, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  // Inside RUNTIME_DIR so the final rename stays on one filesystem.
  const work = await mkdtemp(join(RUNTIME_DIR, ".install-"));

  try {
    for (const pkg of RUNTIME_PACKAGES) {
      const tarball = join(work, `${pkg.name}.tgz`);
      const unpacked = join(work, pkg.name);
      await downloadVerified(pkg.url, tarball, pkg.integrity);
      await mkdir(unpacked);
      const tar = spawnSync("tar", ["-xzf", tarball, "-C", unpacked], { stdio: "inherit" });

      if (tar.status !== 0) throw new Error(`tar could not unpack ${pkg.name}`);
      const target = join(nodeModules, pkg.name);
      await rm(target, { recursive: true, force: true });
      // npm tarballs keep their files under package/.
      await rename(join(unpacked, "package"), target);
    }

    const binaries = join(nodeModules, "onnxruntime-node", "bin", "napi-v6");
    await keepOnly(binaries, process.platform);
    await keepOnly(join(binaries, process.platform), process.arch);

    if (!existsSync(join(binaries, process.platform, process.arch, "onnxruntime_binding.node"))) {
      throw new Error(`onnxruntime-node has no binary for ${process.platform}/${process.arch}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function keepOnly(dir: string, keep: string): Promise<void> {
  const entries = existsSync(dir) ? await readdir(dir) : [];

  for (const entry of entries) {
    if (entry !== keep) await rm(join(dir, entry), { recursive: true, force: true });
  }
}

const runtimePackageSchema = z.object({ version: z.string() });

/** onnxruntime-node is importable as installed, or unpacked by --install-aligner at this version. */
function runtimeInstalled(): boolean {
  if (canResolve("onnxruntime-node")) return true;

  try {
    const manifest = join(RUNTIME_DIR, "node_modules", "onnxruntime-node", "package.json");
    const { version } = runtimePackageSchema.parse(JSON.parse(readFileSync(manifest, "utf-8")));

    return version === ONNXRUNTIME_VERSION;
  } catch {
    return false;
  }
}

/** `qgrid --install-aligner`: downloads whatever part of the aligner is missing. */
export async function installSpeechAligner(): Promise<void> {
  const model = alignerModelPath();

  if (existsSync(model)) {
    console.log(`Speech aligner model already at ${model}`);
  } else {
    console.log(`Downloading the speech aligner model (355 MB) to ${model}`);
    await downloadVerified(MODEL.url, model, MODEL.integrity);
  }

  if (runtimeInstalled()) {
    console.log("onnxruntime-node already installed.");
  } else {
    console.log(`Downloading onnxruntime-node ${ONNXRUNTIME_VERSION} (115 MB) to ${RUNTIME_DIR}`);
    await installRuntime();
  }

  console.log("Speech aligner installed. Restart qgrid if it is running.");
}

/** Without the model or onnxruntime-node the server returns OpenAI voice results without timing. */
export function warnMissingSpeechAligner(env: NodeJS.ProcessEnv = process.env): void {
  if (existsSync(alignerModelPath(env)) && runtimeInstalled()) return;

  console.warn(
    "Warning: speech aligner not installed. OpenAI speech and transcription return no timing.",
  );
  console.warn("Install it with: qgrid --install-aligner");
}

function canResolve(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);

    return true;
  } catch {
    return false;
  }
}
