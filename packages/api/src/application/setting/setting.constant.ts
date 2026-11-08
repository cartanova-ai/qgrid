/**
 * 관리 가능한 런타임 설정 목록.
 *
 * 키·env 이름·타입·검증을 한 곳에 모아 API 와 UI 가 같은 정의를 본다. 여기 없는 env 는
 * 화면에서 바꿀 수 없다 — DB 접속 정보나 포트처럼 서버가 뜨기 전에 필요한 값들이다.
 *
 * `settings` 테이블은 `(key, value)` 문자열 쌍만 담는 그릇이라(`setting.entity.json`),
 * "이 키가 정수인지·범위가 얼마인지·화면에 뭐라고 쓸지"를 담을 곳이 따로 필요하다.
 * 그 메타데이터가 여기 있다 — DB 스키마가 아니라 앱이 아는 상수 목록이다.
 */

export type SettingKind = "boolean" | "integer" | "number" | "string" | "secret" | "preset";

/**
 * 화면에서 묶어 보여줄 단위. 평평하게 나열하면 어디를 봐야 할지 알 수 없다.
 *
 * Slack 은 "언제 보낼까"(slack)와 "어디로 보낼까"(slackConnection)를 나눈다 — 앞은 운영
 * 중 자주 만지고 뒤는 한 번 맞추면 끝이라 수명이 다르다.
 */
export type SettingGroup = "qgrid" | "slack" | "slackConnection";

export type SettingDef = {
  key: string;
  group: SettingGroup;
  envKey?: string;
  label: string;
  kind: SettingKind;
  /** 적용 시점. 부팅 시 한 번만 읽히는 값은 재시작이 필요하다. */
  applies: "immediate" | "restart";
  min?: number;
  max?: number;
  /** `preset` 종류에서 고를 수 있는 값. 이 목록 밖의 값은 저장되지 않는다. */
  presets?: number[];
  /** 허용된 문자열 값. string 입력도 저장 경계에서 검증한다. */
  choices?: string[];
  /**
   * 저장값도 env 도 없을 때 실제로 적용되는 값. 화면을 비워두면 "설정 안 됨"으로 읽히지만
   * 실제로는 이 값이 돌고 있다 — 소비처의 기본값과 반드시 같아야 한다.
   */
  fallback: string;
  help?: string;
};

/**
 * keepalive 스케줄러를 실제로 소유할 인스턴스만 켠다. Settings DB 값과 일부러 분리한다 —
 * 같은 DB를 보는 개발자 로컬 인스턴스가 전역 설정을 읽고 함께 발사하면 중복 요청이 된다.
 */
export const TOKEN_WINDOW_KEEPALIVE_RUNNER_ENV_KEY = "QGRID_TOKEN_WINDOW_KEEPALIVE_ENABLED";

export const SETTING_DEFS: SettingDef[] = [
  {
    key: "qgrid.agents.enabled",
    group: "qgrid",
    envKey: "QGRID_AGENTS_ENABLED",
    label: "Agents 사용",
    kind: "boolean",
    applies: "restart",
    fallback: "false",
  },
  {
    key: "qgrid.agents.sandboxImage",
    group: "qgrid",
    envKey: "QGRID_AGENTS_SANDBOX_IMAGE",
    label: "Agents 샌드박스 이미지",
    kind: "string",
    applies: "restart",
    fallback: "",
    help: "배포한 ghcr.io/cartanova-ai/qgrid-sandbox-pi:<버전> 이미지 태그를 지정합니다",
  },
  {
    key: "qgrid.agents.subnet",
    group: "qgrid",
    envKey: "QGRID_AGENTS_SUBNET",
    label: "Agents 서브넷",
    kind: "string",
    applies: "restart",
    fallback: "172.30.0.0/24",
  },
  {
    key: "qgrid.agents.maxSessions",
    group: "qgrid",
    envKey: "QGRID_AGENTS_MAX_SESSIONS",
    label: "Agents 동시 세션 수",
    kind: "integer",
    applies: "restart",
    min: 1,
    fallback: "4",
  },
  {
    key: "qgrid.agents.idleTtlSec",
    group: "qgrid",
    envKey: "QGRID_AGENTS_IDLE_TTL_SEC",
    label: "Agents 유휴 정지 시간 (초)",
    kind: "integer",
    applies: "restart",
    min: 1,
    fallback: "1800",
  },
  {
    key: "qgrid.agents.retainSec",
    group: "qgrid",
    envKey: "QGRID_AGENTS_RETAIN_SEC",
    label: "Agents 작업공간 보존 시간 (초)",
    kind: "integer",
    applies: "restart",
    min: 1,
    fallback: "86400",
  },
  {
    key: "qgrid.agents.maxModelCallsPerTurn",
    group: "qgrid",
    envKey: "QGRID_AGENTS_MAX_MODEL_CALLS_PER_TURN",
    label: "Agents 턴당 모델 호출 한도",
    kind: "integer",
    applies: "restart",
    min: 1,
    fallback: "60",
  },
  {
    key: "qgrid.agents.maxTurnSeconds",
    group: "qgrid",
    envKey: "QGRID_AGENTS_MAX_TURN_SECONDS",
    label: "Agents 턴 실행 한도 (초)",
    kind: "integer",
    applies: "restart",
    min: 1,
    fallback: "1200",
  },
  {
    key: "qgrid.agents.minFreeDiskGb",
    group: "qgrid",
    envKey: "QGRID_AGENTS_MIN_FREE_DISK_GB",
    label: "Agents 최소 디스크 여유 (GiB)",
    kind: "number",
    applies: "restart",
    min: 0,
    fallback: "20",
  },
  {
    key: "qgrid.agents.isolationCheck",
    group: "qgrid",
    envKey: "QGRID_AGENTS_ISOLATION_CHECK",
    label: "Agents 격리 점검 모드",
    kind: "string",
    applies: "restart",
    choices: ["enforce", "warn"],
    fallback: "enforce",
    help: "enforce: 격리 실패 시 기동하지 않음, warn: 경고만 기록 (개발 환경용)",
  },
  {
    key: "qgrid.agents.isolationPorts",
    group: "qgrid",
    envKey: "QGRID_AGENTS_ISOLATION_PORTS",
    label: "Agents 차단 점검 포트",
    kind: "string",
    applies: "restart",
    fallback: "5432,6379",
    help: "샌드박스에서 닿지 않아야 하는 호스트 TCP 포트를 쉼표로 구분합니다. API 포트는 항상 포함됩니다",
  },
  {
    key: "qgrid.tokenWindowKeepaliveEnabled",
    fallback: "true",
    group: "qgrid",
    label: "토큰 윈도우 keepalive",
    kind: "boolean",
    applies: "immediate",
    help: "끄면 이 서버에서 선택한 Anthropic 토큰의 5시간 윈도우 자동 유지 요청을 중단합니다",
  },
  {
    key: "slack.enabled",
    fallback: "true",
    group: "slack",
    envKey: "SLACK_ENABLED",
    label: "Slack 알림",
    kind: "boolean",
    applies: "immediate",
    help: "연휴처럼 규칙으로 잡을 수 없는 기간에 끕니다. 서비스 정지급 장애 알림은 꺼도 전달됩니다",
  },
  {
    key: "slack.remindersEnabled",
    fallback: "true",
    group: "slack",
    envKey: "SLACK_REMINDERS_ENABLED",
    label: "만료 알림 반복",
    kind: "boolean",
    applies: "immediate",
    help: "끄면 반복만 멈추고 만료 순간의 알림은 그대로 갑니다",
  },
  {
    key: "slack.expiryReminderMinutes",
    fallback: "60",
    group: "slack",
    envKey: "SLACK_EXPIRY_REMINDER_INTERVAL_MINUTES",
    label: "반복 주기",
    kind: "preset",
    applies: "immediate",
    // 자유 입력 대신 고정 선택지를 쓴다 — "얼마나 자주 재촉할까"라서 1분 단위 정밀도가
    // 의미 없고, 잘못 넣으면 채널이 시끄러워진다. 끄는 것은 remindersEnabled 가 맡는다.
    presets: [10, 30, 60, 180],
    help: "재로그인이 필요한 토큰이 남아 있는 동안 이 주기로 다시 알립니다",
  },
  {
    key: "slack.quietFromHour",
    fallback: "20",
    group: "slack",
    envKey: "SLACK_QUIET_FROM_HOUR",
    label: "조용 시간 시작",
    kind: "integer",
    applies: "immediate",
    min: 0,
    max: 23,
    help: "이 시각부터 알리지 않습니다 (한국 시간)",
  },
  {
    key: "slack.quietUntilHour",
    fallback: "8",
    group: "slack",
    envKey: "SLACK_QUIET_UNTIL_HOUR",
    label: "조용 시간 종료",
    kind: "integer",
    applies: "immediate",
    min: 0,
    max: 23,
    help: "이 시각부터 다시 알립니다. 시작보다 빠르면 자정을 넘는 구간이 됩니다",
  },
  {
    key: "slack.notifyOnWeekends",
    fallback: "false",
    group: "slack",
    envKey: "SLACK_NOTIFY_ON_WEEKENDS",
    label: "주말에도 알림",
    kind: "boolean",
    applies: "immediate",
    help: "켜면 주말에도 위의 조용 시간 규칙만 적용됩니다",
  },
  {
    key: "slack.channelId",
    fallback: "",
    group: "slackConnection",
    envKey: "SLACK_CHANNEL_ID",
    label: "Slack 채널 ID",
    kind: "string",
    applies: "immediate",
    help: "사용자 ID(U...)를 넣으면 그 사람 DM 으로 갑니다",
  },
  {
    key: "slack.userMap",
    fallback: "",
    group: "slackConnection",
    envKey: "SLACK_USER_MAP",
    label: "Slack 사용자 매핑",
    kind: "string",
    applies: "immediate",
    help: "토큰명:SlackUserId 를 쉼표로. 공용 계정은 넣지 않습니다",
  },
  {
    key: "slack.botToken",
    fallback: "",
    group: "slackConnection",
    envKey: "SLACK_BOT_TOKEN",
    label: "Slack 봇 토큰",
    kind: "secret",
    applies: "immediate",
  },
];

export function findSettingDef(key: string): SettingDef | undefined {
  return SETTING_DEFS.find((d) => d.key === key);
}

/** 저장 전 검증. 잘못된 값이 들어가면 런타임에서 조용히 기본값으로 떨어져 원인을 찾기 어렵다. */
export function validateSettingValue(
  def: SettingDef,
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = raw.trim();

  if (def.choices && !def.choices.includes(trimmed)) {
    return { ok: false, error: `${def.choices.join(", ")} 중 하나여야 합니다` };
  }

  if (def.key === "qgrid.agents.isolationPorts" && trimmed !== "") {
    const ports = trimmed.split(",");

    if (
      ports.some((port) => !/^\d+$/.test(port.trim()) || Number(port) < 1 || Number(port) > 65535)
    ) {
      return { ok: false, error: "1~65535 사이 포트를 쉼표로 구분하세요" };
    }

    return { ok: true, value: ports.map((port) => String(Number(port))).join(",") };
  }

  if (def.kind === "boolean") {
    if (!["true", "false"].includes(trimmed)) return { ok: false, error: "true 또는 false" };

    return { ok: true, value: trimmed };
  }

  if (def.kind === "preset") {
    // 화면은 버튼만 주지만 API 는 아무 값이나 받을 수 있다. 목록 밖의 값이 들어오면
    // 화면에서 아무 버튼도 선택돼 보이지 않아 "왜 안 바뀌지"가 된다.
    const parsed = Number(trimmed);

    if (!def.presets?.includes(parsed)) {
      return { ok: false, error: `${def.presets?.join(", ") ?? ""} 중 하나여야 합니다` };
    }

    return { ok: true, value: String(parsed) };
  }

  if (def.kind === "integer" || def.kind === "number") {
    const parsed = Number(trimmed);

    if (!Number.isFinite(parsed)) return { ok: false, error: "숫자를 입력하세요" };

    if (def.kind === "integer" && !Number.isInteger(parsed)) {
      return { ok: false, error: "정수를 입력하세요" };
    }

    if (def.min !== undefined && parsed < def.min) {
      return { ok: false, error: `${def.min} 이상이어야 합니다` };
    }

    if (def.max !== undefined && parsed > def.max) {
      return { ok: false, error: `${def.max} 이하여야 합니다` };
    }

    return { ok: true, value: String(parsed) };
  }

  return { ok: true, value: trimmed };
}

/** 화면에 그대로 내려보내면 안 되는 값. 앞뒤만 남긴다. */
export function maskSecret(value: string): string {
  if (value.length <= 12) return "***";

  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}
