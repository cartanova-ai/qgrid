// Grok (xAI) fingerprint literals. Bumping GROK_BUILD_VERSION means: edit the constant,
// re-capture __fixtures__/golden-responses-<ver>.json from the installed binary, and record
// its build id in GROK_BUILD_COMMIT.

// grok-build 1.0.45 xai-grok-env/src/lib.rs:21
export const GROK_CHAT_PROXY_URL = "https://cli-chat-proxy.grok.com/v1";

// grok-build 1.0.45 xai-grok-config/src/endpoints.rs:4
export const GROK_PUBLIC_API_URL = "https://api.x.ai/v1";

// grok-build 1.0.45 xai-grok-login/src/config.rs:124
export const GROK_AUTH_ISSUER = "https://auth.x.ai";

// grok-build 1.0.45 xai-grok-login/src/config.rs:380 (plaintext in manager_tests.rs:164)
export const GROK_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

// grok-build 1.0.45 xai-grok-login/src/config.rs:16-28 (order frozen by config.rs:624)
export const GROK_OAUTH_SCOPES = Object.freeze([
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
] as const);

// grok-build 1.0.45 xai-grok-login/src/config.rs:152
export const GROK_OAUTH_REFERRER = "grok-build";

// grok-build 1.0.45 xai-grok-login/src/device_code.rs:117
export const GROK_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";

// grok-build 1.0.45 xai-grok-login/src/device_code.rs:187
export const GROK_DEVICE_TOKEN_URL = "https://auth.x.ai/oauth2/token";

// U0 capture 2026-10-16 (installed grok-build 1.0.60, user decision)
export const GROK_BUILD_VERSION = "1.0.60" as const;

// U0 capture 2026-10-16 (Homebrew cask build id of 1.0.60)
export const GROK_BUILD_COMMIT = "01a8e1c591c0";

// U0 capture 2026-10-16 (GET /settings min_client_version; HTTP 426 below it)
export const GROK_MIN_CLIENT_VERSION_OBSERVED = "1.0.13";

// grok-build 1.0.45 xai-grok-http/src/lib.rs:246-248
export const GROK_CLIENT_IDENTIFIER = "grok-shell";

// U0 capture 2026-10-16 (grok -p sends headless; xai-grok-http/src/lib.rs:250-260)
export const GROK_CLIENT_MODE = "headless";

// U0 capture 2026-10-16 (GET /models default and /settings default_model)
export const GROK_DEFAULT_MODEL = "grok-4.7";

// grok-build 1.0.45 image_gen/mod.rs:33
export const GROK_IMAGE_DEFAULT_MODEL = "grok-imagine-image-quality";

// grok-build 1.0.45 video_gen/mod.rs:36-40
export const GROK_VIDEO_DEFAULT_MODEL = "grok-imagine-video-1.5";

// U0 capture 2026-10-16 (packet contract; the STT probe did not name a model)
export const GROK_STT_DEFAULT_MODEL = "grok-voice-transcribe-2.0";

// U0 capture 2026-10-16 (api.x.ai /language-models prices vs public per-token pricing)
export const GROK_USD_PER_TICK = 1e-10;

// U0 capture 2026-10-16 (GET /models reasoning_efforts, identical on all four models)
export const GROK_REASONING_EFFORTS = Object.freeze(["xhigh", "high", "medium", "low"] as const);

export type GrokReasoningEffort = (typeof GROK_REASONING_EFFORTS)[number];

export interface GrokSeedModel {
  readonly id: string;
  readonly contextWindow: number;
  readonly reasoningEfforts: readonly GrokReasoningEffort[];
  readonly defaultEffort: GrokReasoningEffort;
}

// U0 capture 2026-10-16 (GET /models: four ids, context_window 256000, default effort high)
export const GROK_SEED_MODELS: readonly GrokSeedModel[] = Object.freeze(
  ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"].map((id): GrokSeedModel =>
    Object.freeze({
      id,
      contextWindow: 256_000,
      reasoningEfforts: GROK_REASONING_EFFORTS,
      defaultEffort: "high",
    }),
  ),
);

// U0 capture 2026-10-16 (x-compaction-at request header)
export const GROK_COMPACTION_AT = 204_800;

// U0 capture 2026-10-16 (x-compactions-remaining request header)
export const GROK_COMPACTIONS_REMAINING_DEFAULT = 1;

// U0 capture 2026-10-16 (x-grok-doom-loop-check request header)
export const GROK_DOOM_LOOP_CHECK = 1024;

// U0 capture 2026-10-16 (x-grok-exact-repetition-check request header)
export const GROK_EXACT_REPETITION_CHECK = 64;
