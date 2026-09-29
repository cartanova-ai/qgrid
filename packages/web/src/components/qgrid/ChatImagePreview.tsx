import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import XIcon from "~icons/lucide/x";

import { chatImageInfo, formatImageBytes } from "./chat-image-info";

export function ChatImagePreview({ url, onClose }: { url: string; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [originalSize, setOriginalSize] = useState(false);
  const [failed, setFailed] = useState(false);
  const info = chatImageInfo(url);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-labelledby="chat-image-preview-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          onClose();
      }}
      className="m-auto w-[min(1100px,calc(100vw-2rem))] max-w-none max-h-[calc(100dvh-2rem)] overflow-hidden rounded-2xl bg-white p-0 text-sand-900 shadow-xl backdrop:bg-black/65"
    >
      <div className="flex items-center justify-between gap-3 border-b border-sand-100 px-4 py-3">
        <h2 id="chat-image-preview-title" className="text-sm font-semibold">
          이미지 미리보기
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="이미지 미리보기 닫기"
          className="grid size-8 place-items-center rounded-full hover:bg-sand-100"
        >
          <XIcon className="size-4" />
        </button>
      </div>
      <div
        className="max-h-[calc(100dvh-13rem)] overflow-auto bg-sand-100 p-3"
        style={{
          backgroundImage: "conic-gradient(#e8e4df 25%, #fff 0 50%, #e8e4df 0 75%, #fff 0)",
          backgroundSize: "20px 20px",
        }}
      >
        {failed ? (
          <p role="alert" className="p-8 text-center text-danger-500">
            이미지를 불러올 수 없습니다.
          </p>
        ) : (
          <img
            src={url}
            alt="확대된 채팅 이미지"
            onLoad={(event) =>
              setDimensions({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={() => setFailed(true)}
            className={
              originalSize
                ? "block max-w-none"
                : "mx-auto block max-h-[calc(100dvh-15rem)] max-w-full object-contain"
            }
          />
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-sand-100 px-4 py-3">
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs tabular-nums">
          <div>
            <dt className="text-sand-400">확장자</dt>
            <dd className="mt-1 uppercase">{info.extension}</dd>
          </div>
          <div>
            <dt className="text-sand-400">파일 용량</dt>
            <dd className="mt-1">{formatImageBytes(info.bytes)}</dd>
          </div>
          <div>
            <dt className="text-sand-400">해상도</dt>
            <dd className="mt-1">
              {dimensions ? `${dimensions.width} × ${dimensions.height} px` : "—"}
            </dd>
          </div>
        </dl>
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            disabled={!dimensions || failed}
            onClick={() => setOriginalSize((value) => !value)}
            className="text-sand-600 hover:underline disabled:opacity-40"
          >
            {originalSize ? "화면에 맞추기" : "원본 크기"}
          </button>
          <a
            href={url}
            download={`qgrid-image.${info.extension}`}
            className="text-sienna-500 hover:underline"
          >
            다운로드
          </a>
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
