// 대시보드 채팅과 Voice 플레이그라운드(GPT-Live 위임 모델)가 함께 쓰는 모델 목록.
// dispatcher 는 provider prefix 없는 모델을 라우팅하지 못하므로 항상 접두사를 포함한다.
// ai-sdk 의 QgridSupportedModel union 중 실제로 서비스되는 모델만 provider 별로 최신순 나열한다.
// web 은 ai-sdk 에 의존하지 않아 런타임 공유가 없으므로, 모델을 추가할 때 두 곳을 함께 갱신한다.
// union 에는 남아 있지만 여기서 제외한 항목:
//  - `gpt-5.4`, `gpt-5.4-mini`: qgrid 가 쓰는 ChatGPT 구독 Codex 경로에서 2026-08-31 retired
//    (대체 gpt-5.6-terra / gpt-5.6-luna).
//  - `gpt-5.2`, `gpt-5.3-codex`: 같은 경로에서 이미 제공 종료.
//  - `gpt-5.3-codex-spark`: 같은 경로에서 400("not supported when using Codex with a ChatGPT account"),
//    Codex 카탈로그에서도 빠짐(2026-09-29 확인).
//  - `gpt-5.5`: Codex/ChatGPT 경로에서 2026-10-14 은퇴 예정(대체 gpt-6.1-sol / gpt-6-luna).
//  - `claude-opus-4`, `claude-sonnet-4`: 2026-06-15 retired, Claude Code 에서 모델 오류.
//  - `claude-opus-4-1`: 2026-08-05 retired, Claude Code 가 claude-opus-5-5 로 대체 서빙.
//  - `claude-sonnet-4-5`: 2026-09-30 deprecated, 2026-11-30 retirement 예정(대체 claude-sonnet-5-5).
//  - `claude-sonnet-4-7`: 공식 카탈로그에 없는 유령 항목.
export const MODEL_PRESET_GROUPS: { label: string; models: string[] }[] = [
  {
    label: "OpenAI",
    models: [
      "openai/gpt-6-astra",
      "openai/gpt-6.1-sol",
      "openai/gpt-6.1-terra",
      "openai/gpt-6-sol",
      "openai/gpt-6-luna",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-luna",
    ],
  },
  {
    label: "Anthropic",
    models: [
      "anthropic/claude-fable-5-1",
      "anthropic/claude-fable-5",
      "anthropic/claude-opus-5-5",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-5-5",
      "anthropic/claude-opus-4-8",
      "anthropic/claude-opus-4-7",
      "anthropic/claude-opus-4-6",
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-6",
      "anthropic/claude-haiku-4-5",
    ],
  },
  {
    label: "Grok",
    // ai-sdk QgridGrokModel 의 구독 카탈로그 id(grok-4.7 이 기본). Grok 4.6/4.7 은 Build 모델로 라우팅된다.
    models: ["grok/grok-4.7", "grok/grok-4.7-build-fast", "grok/grok-4.6", "grok/grok-4.5"],
  },
];

export const EFFORT_PRESETS = ["low", "medium", "high"] as const;
