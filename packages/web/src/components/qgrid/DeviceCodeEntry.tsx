import { useEffect, useState } from "react";

import { type GrokDeviceFlow } from "./use-oauth-login-flow";

function formatRemaining(ms: number): string {
  const totalSec = Math.max(Math.ceil(ms / 1000), 0);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 만료 시각까지 1초마다 갱신되는 남은 시간. */
function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tabular-nums">{formatRemaining(expiresAt - now)}</span>;
}

/**
 * Grok device-code 로그인 단계. 사용자 코드와 인증 링크를 보여 주고, 폴링 상태를 표시한다.
 * 폴링 자체는 `useOAuthLoginFlow().startDevice` 가 소유한다.
 */
export function DeviceCodeEntry({
  flow,
  onRestart,
}: {
  flow: GrokDeviceFlow;
  onRestart: () => void;
}) {
  return (
    <div className="space-y-2">
      {flow.status === "starting" && (
        <p className="flex items-center gap-1.5 text-[12px] text-sand-600">
          <span className="w-3.5 h-3.5 border-2 border-sand-400 border-t-transparent rounded-full animate-spin" />
          Requesting device code...
        </p>
      )}

      {flow.status === "waiting" && (
        <>
          <p className="text-[12px] text-sand-600 leading-relaxed">
            아래 링크를 열어 xAI 계정으로 로그인한 뒤 이 코드를 입력하세요. 승인되면 토큰이 자동으로
            추가됩니다.
          </p>
          <div className="rounded-md border border-sand-200 bg-sand-50 px-3 py-3 text-center">
            <p className="text-[10px] uppercase tracking-wider text-sand-500 font-medium">
              Device code
            </p>
            <p className="mt-1 font-mono text-lg tracking-widest text-sand-900 select-all">
              {flow.userCode}
            </p>
          </div>
          <a
            href={flow.verificationUriComplete ?? flow.verificationUri}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full py-2.5 text-sm font-medium rounded-md bg-sand-900 text-white text-center hover:bg-sand-800 transition-colors duration-150"
          >
            Open xAI to approve
          </a>
          <p className="flex items-center justify-between text-[11px] text-sand-500">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 border-2 border-sand-400 border-t-transparent rounded-full animate-spin" />
              {flow.slowDown
                ? "Waiting for approval (polling slowed down)..."
                : "Waiting for approval..."}
            </span>
            <span>
              expires in <Countdown expiresAt={flow.expiresAt} />
            </span>
          </p>
        </>
      )}

      {flow.status === "added" && (
        <p className="text-[12px] text-sage-600">Token "{flow.name}" added.</p>
      )}

      {flow.status === "expired" && (
        <p className="text-[11px] text-red-500">
          Device code가 만료되었습니다 — 로그인을 다시 시작하세요.
        </p>
      )}

      {flow.status === "error" && <p className="text-[11px] text-red-500">{flow.message}</p>}

      <button
        type="button"
        className="w-full py-1.5 text-[12px] text-sand-500 hover:text-sand-700 transition-colors duration-150"
        onClick={onRestart}
      >
        처음부터 다시 시작
      </button>
    </div>
  );
}
