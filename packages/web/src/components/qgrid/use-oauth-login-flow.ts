import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { QgridService, TokenService } from "@/services/services.generated";

export type Provider = "anthropic" | "openai" | "grok";

const PROVIDERS: readonly Provider[] = ["anthropic", "openai", "grok"];

export function isOAuthProvider(value: string): value is Provider {
  return PROVIDERS.some((provider) => provider === value);
}

const OPENAI_POLL_INTERVAL_MS = 3000;
const OPENAI_POLL_TIMEOUT_MS = 300_000;
// RFC 8628 §3.5: slow_down adds 5 s to the interval for every later request.
const DEVICE_SLOW_DOWN_STEP_SEC = 5;
// A transient API/network failure should not end a device login; a persistent one should.
const DEVICE_MAX_CONSECUTIVE_POLL_FAILURES = 3;

/** Grok device-code login state shown by `DeviceCodeEntry`. */
export type GrokDeviceFlow =
  | { status: "starting" }
  | {
      status: "waiting";
      userCode: string;
      verificationUri: string;
      verificationUriComplete?: string;
      /** Epoch ms after which the device code is no longer valid. */
      expiresAt: number;
      slowDown: boolean;
    }
  | { status: "added"; name: string }
  | { status: "expired" }
  | { status: "error"; message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Grok login failed";
}

/** Server-provided login URLs are only opened or linked when they are https. */
export function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

async function getTokenIds(provider: Provider, name: string): Promise<Set<number>> {
  const { rows } = await TokenService.getTokens("A", { num: 0, queryMode: "list" });
  return new Set(
    rows
      .filter((token) => token.provider === provider && token.name === name)
      .map((token) => token.id),
  );
}

/**
 * provider별 OAuth 로그인 시작과 코드 제출을 한 곳에 모은다.
 * Add Token 모달과 tokens 목록의 재로그인 버튼이 같은 플로우를 쓴다 — 두 진입점이
 * redirect/code 분기나 폴링 처리를 각자 구현하면 원격 접속 경험이 갈라진다.
 */
export function useOAuthLoginFlow() {
  // 로그인 진행 중인 provider — 스피너를 해당 버튼에만 표시한다.
  const [loadingProvider, setLoadingProvider] = useState<Provider | null>(null);
  // 원격 접속(code 모드): provider에 맞는 인증 결과를 붙여넣는 단계.
  const [codeEntryProvider, setCodeEntryProvider] = useState<Provider | null>(null);
  // Grok device-code 로그인 진행 상태. null이면 device 플로우가 아니다.
  const [deviceFlow, setDeviceFlow] = useState<GrokDeviceFlow | null>(null);

  const queryClient = useQueryClient();
  const oauthStartMutation = QgridService.useOauthStartMutation();
  const oauthStartOpenAIMutation = QgridService.useOauthStartOpenAIMutation();
  const oauthStartGrokMutation = QgridService.useOauthStartGrokMutation();
  const oauthCompleteMutation = QgridService.useOauthCompleteMutation();

  // 폴링 타이머는 언마운트 시 반드시 정리한다 — 안 하면 모달을 닫거나 페이지를 떠나도
  // 최대 5분간 계속 refetch 가 돈다.
  const pollTimers = useRef<{ interval?: number; timeout?: number }>({});
  const attemptRef = useRef(0);
  const stopPolling = () => {
    attemptRef.current += 1;
    if (pollTimers.current.interval !== undefined) clearInterval(pollTimers.current.interval);
    if (pollTimers.current.timeout !== undefined) clearTimeout(pollTimers.current.timeout);
    pollTimers.current = {};
  };
  useEffect(() => stopPolling, []);

  const invalidateTokens = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["Token"] }),
      queryClient.invalidateQueries({ queryKey: ["Qgrid"] }),
    ]);

  const start = async (provider: Provider, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    stopPolling();
    const attempt = attemptRef.current;
    setDeviceFlow(null);
    // popup 을 동기적으로 열어야 브라우저가 차단하지 않음
    const popup = window.open("about:blank", "_blank");
    setLoadingProvider(provider);

    try {
      if (provider === "grok") {
        // Grok 의 redirect 는 qgrid 가 받지 않는 127.0.0.1 임의 포트라 항상 붙여넣기 단계로 간다.
        const { authUrl } = await oauthStartGrokMutation.mutateAsync({ name: trimmed });
        if (attempt !== attemptRef.current) {
          popup?.close();
          return;
        }
        const loginUrl = safeHttpsUrl(authUrl);
        if (!loginUrl) throw new Error("Grok login URL is not https");
        if (popup) popup.location.href = loginUrl;
        else window.open(loginUrl, "_blank");
        setCodeEntryProvider(provider);
        setLoadingProvider(null);
        return;
      }

      if (provider === "openai") {
        // 로그인 페이지를 열기 전에 전체 대상 ID를 읽는다. 재로그인은 행 수가 같아도 ID가 바뀐다.
        const before = await getTokenIds(provider, trimmed);
        if (attempt !== attemptRef.current) {
          popup?.close();
          return;
        }
        const { authUrl, mode } = await oauthStartOpenAIMutation.mutateAsync({ name: trimmed });
        if (attempt !== attemptRef.current) {
          popup?.close();
          return;
        }
        if (popup) popup.location.href = authUrl;
        else window.open(authUrl, "_blank");

        if (mode === "code") {
          setCodeEntryProvider(provider);
          setLoadingProvider(null);
          return;
        }

        // 다른 계정의 변경은 무시하고, 이번 이름으로 새 토큰이 저장되면 종료한다.
        pollTimers.current.interval = window.setInterval(() => {
          void getTokenIds(provider, trimmed)
            .then((ids) => {
              if (attempt !== attemptRef.current) return;
              if ([...ids].some((id) => !before.has(id))) {
                stopPolling();
                setLoadingProvider(null);
                void invalidateTokens();
              }
            })
            .catch(() => {
              // 일시적인 조회 실패는 다음 폴링에서 재시도한다.
            });
        }, OPENAI_POLL_INTERVAL_MS);
        pollTimers.current.timeout = window.setTimeout(() => {
          if (attempt !== attemptRef.current) return;
          stopPolling();
          setLoadingProvider(null);
        }, OPENAI_POLL_TIMEOUT_MS);
        return;
      }

      const { authUrl, mode } = await oauthStartMutation.mutateAsync({ name: trimmed });
      if (attempt !== attemptRef.current) {
        popup?.close();
        return;
      }
      if (mode === "code") {
        // 원격 접속: 새 탭에서 인증 → 표시된 코드를 붙여넣는다.
        if (popup) popup.location.href = authUrl;
        else window.open(authUrl, "_blank");
        setCodeEntryProvider(provider);
        setLoadingProvider(null);
      } else {
        popup?.close();
        window.location.href = authUrl;
      }
    } catch (e) {
      popup?.close();
      if (attempt !== attemptRef.current) return;
      console.error("OAuth start failed:", e);
      setLoadingProvider(null);
    }
  };

  /**
   * Grok device-code 로그인. 사용자 코드를 보여 주고 `interval` 초마다 폴링한다.
   * 타이머는 OpenAI 폴링과 같은 `pollTimers`/`attemptRef` 로 관리해 reset·언마운트 시 멈춘다.
   * `onAdded` 는 토큰 저장과 목록 무효화가 끝난 뒤, 플로우가 취소되지 않았을 때만 호출된다.
   */
  const startDevice = async (name: string, onAdded?: () => void) => {
    const trimmed = name.trim();
    if (!trimmed) return;

    stopPolling();
    const attempt = attemptRef.current;
    setCodeEntryProvider(null);
    setLoadingProvider(null);
    setDeviceFlow({ status: "starting" });

    let device;
    try {
      device = await QgridService.oauthStartGrokDevice(trimmed);
    } catch (e) {
      if (attempt !== attemptRef.current) return;
      console.error("Grok device login start failed:", e);
      setDeviceFlow({ status: "error", message: errorMessage(e) });
      return;
    }
    if (attempt !== attemptRef.current) return;

    const { deviceCode } = device;
    const verificationUri = safeHttpsUrl(device.verificationUri);
    if (!verificationUri) {
      setDeviceFlow({ status: "error", message: "Grok verification URL is not https" });
      return;
    }
    const verificationUriComplete = safeHttpsUrl(device.verificationUriComplete);
    const expiresAt = Date.now() + device.expiresIn * 1000;
    let intervalSec = Math.max(device.interval, 1);
    let failures = 0;
    setDeviceFlow({
      status: "waiting",
      userCode: device.userCode,
      verificationUri,
      ...(verificationUriComplete ? { verificationUriComplete } : {}),
      expiresAt,
      slowDown: false,
    });

    const schedule = () => {
      // 만료 시각을 넘겨 기다리지 않도록 남은 시간으로 자른다.
      const delay = Math.min(intervalSec * 1000, Math.max(expiresAt - Date.now(), 0));
      pollTimers.current.timeout = window.setTimeout(() => void poll(), delay);
    };

    const poll = async () => {
      if (attempt !== attemptRef.current) return;
      if (Date.now() >= expiresAt) {
        setDeviceFlow({ status: "expired" });
        return;
      }
      let result;
      try {
        result = await QgridService.oauthPollGrokDevice(deviceCode);
      } catch (e) {
        if (attempt !== attemptRef.current) return;
        failures += 1;
        if (failures >= DEVICE_MAX_CONSECUTIVE_POLL_FAILURES) {
          console.error("Grok device login poll failed:", e);
          setDeviceFlow({ status: "error", message: errorMessage(e) });
          return;
        }
        schedule();
        return;
      }
      if (attempt !== attemptRef.current) return;
      failures = 0;

      if (result.status === "added") {
        setDeviceFlow({ status: "added", name: result.name ?? trimmed });
        await invalidateTokens();
        if (attempt === attemptRef.current) onAdded?.();
        return;
      }
      if (result.status === "slow_down") {
        intervalSec = result.intervalSec ?? intervalSec + DEVICE_SLOW_DOWN_STEP_SEC;
        setDeviceFlow((prev) => (prev?.status === "waiting" ? { ...prev, slowDown: true } : prev));
      } else if (result.intervalSec !== undefined) {
        intervalSec = result.intervalSec;
      }
      intervalSec = Math.max(intervalSec, 1);
      schedule();
    };

    schedule();
  };

  /** @returns 교환 성공 여부. 실패 시 `completeMutation.isError` 로 안내 문구를 띄운다. */
  const submitCode = async (pastedCode: string): Promise<boolean> => {
    const trimmed = pastedCode.trim();
    if (!trimmed) return false;
    try {
      await oauthCompleteMutation.mutateAsync({ pastedCode: trimmed });
    } catch (e) {
      console.error("OAuth complete failed:", e);
      return false;
    }
    await invalidateTokens();
    return true;
  };

  const reset = () => {
    stopPolling();
    setLoadingProvider(null);
    setCodeEntryProvider(null);
    setDeviceFlow(null);
    oauthCompleteMutation.reset();
  };

  return {
    loadingProvider,
    codeEntryProvider,
    deviceFlow,
    start,
    startDevice,
    submitCode,
    reset,
    completeMutation: oauthCompleteMutation,
  };
}
