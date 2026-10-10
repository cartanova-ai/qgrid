/**
 * 재시작하면 초기화되는 Monit 로그 버퍼.
 * timestamp/processStartedAt은 web의 dateReviver 변환을 피하고 동등성 비교를 유지하도록 epoch ms를 쓴다.
 */
import { type LogRecord, type Sink } from "@logtape/logtape";

const DEFAULT_CAPACITY = 2_000;
const DEFAULT_MAX_TEXT_LENGTH = 4_000;

// 표시 전용 wire 레코드. properties/원본 값은 버퍼에 싣지 않는다(allowlist).
export interface MonitLogEntry {
  seq: number;
  timestamp: number;
  level: string;
  category: string[];
  text: string;
}

export interface MonitLogChunk {
  entries: MonitLogEntry[];
  nextCursor: number;
  // 호출자의 커서가 eviction 에 밀려 유실된 라인 수. 0 이면 공백 없음.
  dropped: number;
}

// logtape message 배열은 홀수 길이 — 짝수 인덱스가 템플릿 텍스트, 홀수가 보간 값.
function flattenMessage(message: readonly unknown[]): string {
  return message
    .map((part, index) => (index % 2 === 0 ? String(part ?? "") : renderValue(part)))
    .join("");
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export class MonitLogBuffer {
  readonly processStartedAt = Date.now();
  entries: MonitLogEntry[] = [];
  nextSeq = 1;

  constructor(
    readonly capacity = DEFAULT_CAPACITY,
    readonly maxTextLength = DEFAULT_MAX_TEXT_LENGTH,
  ) {}

  push(record: LogRecord): void {
    try {
      let text = flattenMessage(record.message);
      if (text.length > this.maxTextLength) {
        text = `${text.slice(0, this.maxTextLength)}…`;
      }
      this.entries.push({
        seq: this.nextSeq++,
        timestamp: record.timestamp,
        level: record.level,
        category: [...record.category],
        text,
      });
      if (this.entries.length > this.capacity) {
        this.entries.splice(0, this.entries.length - this.capacity);
      }
    } catch {
      // 로그 캡처 실패는 조용히 무시 — 로깅 경로를 절대 방해하지 않는다.
    }
  }

  // cursor 미지정이면 최근 엔트리부터 반환한다.
  after(cursor: number | undefined, limit: number): MonitLogChunk {
    const latestSeq = this.nextSeq - 1;
    const oldestSeq = this.entries[0]?.seq ?? this.nextSeq;
    if (cursor === undefined) {
      const entries = this.entries.slice(-limit);
      return {
        entries,
        nextCursor: entries.at(-1)?.seq ?? latestSeq,
        dropped: 0,
      };
    }

    // 이전 프로세스의 커서 등 미래 커서는 방어적으로 현재 tail 로 재동기화한다.
    if (cursor > latestSeq) {
      return { entries: [], nextCursor: latestSeq, dropped: 0 };
    }

    const dropped = Math.max(oldestSeq - cursor - 1, 0);
    const startIndex = this.entries.findIndex((entry) => entry.seq > cursor);
    const entries = startIndex === -1 ? [] : this.entries.slice(startIndex, startIndex + limit);
    return {
      entries,
      nextCursor: entries.at(-1)?.seq ?? cursor + dropped,
      dropped,
    };
  }
}

export const monitLogBuffer = new MonitLogBuffer();

export const monitLogSink: Sink = (record) => {
  monitLogBuffer.push(record);
};
