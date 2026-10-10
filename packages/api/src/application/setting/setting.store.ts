/**
 * 런타임 설정 조회 캐시.
 *
 * 값의 출처는 DB(`settings`) → env 순이다. 저장된 설정이 없으면 기동 시 전달된
 * 환경변수를 사용하므로, 설정을 DB에 저장하기 전에도 기존 값이 유지된다.
 *
 * 설정은 요청 경로(permit 해석, 알림 전송)에서 읽히므로 매번 DB 를 때리지 않고 메모리에
 * 둔다. `immediate` 변경도 현재 API 프로세스에만 즉시 반영된다. 인스턴스가 여러 개면 다른
 * 인스턴스의 캐시는 갱신되지 않으며, 이 범위에서는 프로세스 간 전파를 두지 않는다.
 */
import { getLogger } from "@logtape/logtape";

import { SettingModel } from "./setting.model";

const logger = getLogger(["qgrid", "setting"]);

/** 로드 전에는 null 이라 전부 env 로 떨어진다. */
let cache: Map<string, string> | null = null;

type SettingChangeHandler = (key: string) => void;
export type SettingPersistence = Pick<
  typeof SettingModel,
  "clearByKey" | "findAllAsMap" | "setByKey"
>;
let settingChangeHandler: SettingChangeHandler | null = null;

/**
 * 런타임 소비자는 상위 조립 계층에서 하나만 등록한다. handler 는 동기 작업만 해야 하며,
 * 실패해도 이미 성공한 DB 저장을 실패로 바꾸지 않는다.
 */
export function setSettingChangeHandler(handler: SettingChangeHandler | null): void {
  settingChangeHandler = handler;
}

function notifySettingChanged(key: string): void {
  try {
    settingChangeHandler?.(key);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`setting change handler failed for ${key}: ${message}`);
  }
}

export async function loadSettings(persistence: SettingPersistence = SettingModel): Promise<void> {
  try {
    cache = await persistence.findAllAsMap();
    logger.info(`settings loaded: ${cache.size} stored`);
  } catch (e) {
    // 테이블이 아직 없는 배포(마이그레이션 전)에서도 서버는 떠야 한다.
    cache = new Map();
    logger.warn(`settings load failed, using env only: ${(e as Error).message}`);
  }
}

/** DB → env 순. 둘 다 없으면 undefined 라 호출부의 기본값으로 떨어진다. */
export function getSetting(key: string, envKey?: string): string | undefined {
  return cache?.get(key) ?? (envKey ? process.env[envKey] : undefined);
}

/** 저장된 값인지 — 화면에서 출처를 구분해 보여준다. */
export function isStored(key: string): boolean {
  return cache?.has(key) ?? false;
}

export async function saveSetting(
  key: string,
  value: string,
  persistence: SettingPersistence = SettingModel,
): Promise<void> {
  await persistence.setByKey(key, value);
  cache ??= new Map();
  cache.set(key, value);
  notifySettingChanged(key);
}

/** 저장값을 지워 env 기본값으로 되돌린다. */
export async function resetSetting(
  key: string,
  persistence: SettingPersistence = SettingModel,
): Promise<void> {
  await persistence.clearByKey(key);
  cache?.delete(key);
  notifySettingChanged(key);
}
