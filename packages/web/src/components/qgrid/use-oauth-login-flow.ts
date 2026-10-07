import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { QgridService, TokenService } from "@/services/services.generated";

export type Provider = "anthropic" | "openai";

const OPENAI_POLL_INTERVAL_MS = 3000;
const OPENAI_POLL_TIMEOUT_MS = 300_000;

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

  const queryClient = useQueryClient();
  const oauthStartMutation = QgridService.useOauthStartMutation();
  const oauthStartOpenAIMutation = QgridService.useOauthStartOpenAIMutation();
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
    // popup 을 동기적으로 열어야 브라우저가 차단하지 않음
    const popup = window.open("about:blank", "_blank");
    setLoadingProvider(provider);

    try {
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
    oauthCompleteMutation.reset();
  };

  return {
    loadingProvider,
    codeEntryProvider,
    start,
    submitCode,
    reset,
    completeMutation: oauthCompleteMutation,
  };
}
