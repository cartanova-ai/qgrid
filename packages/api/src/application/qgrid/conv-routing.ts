/**
 * conv-routing — 대화 연속성(cache affinity) 좌표 검증/구성.
 *
 * 모든 turn은 현재 input과 전체 history를 전달한다.
 * OpenAI의 epoch=-1 좌표는 system/model hash와 opaque affinity를 검증한 뒤
 * token 선택과 prompt-cache 힌트로만 사용한다.
 */
import { createHash } from "node:crypto";

import { type ReuseThreadCoord } from "../../utils/providers/common/provider-dispatcher";
import { type JsonValue, type UserInput } from "../../utils/providers/common/provider-types";
import { type QgridThreadCoord, type QueryInput, type QgridToolResultInput } from "./qgrid.types";

export function systemHash(system?: string, modelNamespace?: string): string {
  return createHash("sha256")
    .update(modelNamespace === undefined ? (system ?? "") : `${modelNamespace}\0${system ?? ""}`)
    .digest("hex")
    .slice(0, 16);
}

// tool 결과를 다음 turn 의 input text 로 변환 (provider 입력은 UserInput 만 받음).
function toolResultsToText(toolResults: QgridToolResultInput[]): string {
  const lines = toolResults.map((tr) => {
    const name = tr.toolName ? ` (${tr.toolName})` : "";
    const errMark = tr.isError ? " [error]" : "";
    return `Tool result for call ${tr.toolCallId}${name}${errMark}: ${tr.output}`;
  });
  return `${lines.join("\n")}\n\nNow continue answering the user's request using these results.`;
}

export interface ConvDecision {
  // 매 turn의 현재 user/tool input.
  coldInput: Array<UserInput>;
  // 매 turn에 다시 전달할 전체 history.
  coldHistory?: Array<JsonValue>;
  // 이 요청 시점의 system 해시 (응답에서 thread 좌표 발급 시 사용).
  systemHash: string;
  // Direct-provider cache affinity. Presence marks the epoch=-1 coordinate semantics.
  promptCacheKey?: string;
  preferredTokenId?: number;
}

export interface ConvRoutingOptions {
  directOpenAI?: boolean;
  modelNamespace?: string;
}

// 입력과 전체 history를 구성하고, 검증된 OpenAI cache affinity만 부가한다.
export function decideConvRouting(
  input: QueryInput,
  options: ConvRoutingOptions = {},
): ConvDecision {
  const sysHash = systemHash(
    input.system,
    options.directOpenAI ? (options.modelNamespace ?? input.model ?? "openai") : undefined,
  );
  const history: Array<JsonValue> | undefined = input.history
    ? (JSON.parse(input.history) as Array<JsonValue>)
    : undefined;

  const coord = input.runContext?.threadCoord;

  // 재사용 자격: 좌표 존재 + system 동일. sessionKey 격리 + systemHash 로 대화 동일성이
  // 보장되고, 공통 prefix 는 백엔드가 prompt_cache_key 고정으로 알아서 캐시한다.
  const directCoordEligible =
    options.directOpenAI === true &&
    coord?.epoch === -1 &&
    coord.systemHash === sysHash &&
    input.cacheAffinityKey !== undefined &&
    coord.threadId === input.cacheAffinityKey;
  // affinity 를 요청하지 않은 one-shot 요청에 임의 키를 붙이면 transport 가 그 소켓을
  // affinity 소켓으로 오인해 재사용되지 않을 연결을 계속 붙들어 둔다 → 키를 비워 둔다.
  const cacheKey = options.directOpenAI ? input.cacheAffinityKey : undefined;

  return {
    // tool follow-up도 실행 user 줄에 결과를 사용해 계속 답하라는 안내를 담는다.
    coldInput: buildDeltaInput(input),
    coldHistory: history,
    systemHash: sysHash,
    promptCacheKey: cacheKey,
    preferredTokenId: directCoordEligible ? coord.workerId : undefined,
  };
}

// 후속 turn 의 input: tool 결과가 있으면 그걸 text 로, 없으면 마지막 user(prompt).
function buildDeltaInput(input: QueryInput): Array<UserInput> {
  if (input.toolResults && input.toolResults.length > 0) {
    return [{ type: "text", text: toolResultsToText(input.toolResults), text_elements: [] }];
  }
  if (input.input && input.input.length > 0) {
    const hasText = input.input.some((part) => part.type === "text");
    const parts: Array<UserInput> = input.input.map((part) => {
      if (part.type === "text") {
        return { type: "text", text: part.text, text_elements: part.text_elements };
      }
      return { type: "image", url: part.url };
    });
    if (!hasText && input.prompt.length > 0) {
      return [{ type: "text", text: input.prompt, text_elements: [] }, ...parts];
    }
    return parts;
  }
  return [{ type: "text", text: input.prompt, text_elements: [] }];
}

// 응답 threadCoord + 요청 시점 정보로 다음 thread 좌표를 발급한다.
export function issueConvContext(
  threadCoord: ReuseThreadCoord,
  decision: ConvDecision,
  preferredTokenId = threadCoord.workerId,
): QgridThreadCoord {
  if (decision.promptCacheKey) {
    return {
      workerId: preferredTokenId,
      threadId: decision.promptCacheKey,
      epoch: -1,
      systemHash: decision.systemHash,
    };
  }
  return {
    workerId: threadCoord.workerId,
    threadId: threadCoord.threadId,
    epoch: threadCoord.epoch,
    systemHash: decision.systemHash,
  };
}
