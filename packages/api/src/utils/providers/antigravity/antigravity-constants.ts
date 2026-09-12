export const ANTIGRAVITY_PROVIDER = "antigravity";
export const ANTIGRAVITY_MODEL_EFFORTS = {
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.7-flash": ["low", "medium", "high"],
  "gemini-3.6-flash": ["low", "medium", "high"],
  "gemini-3.1-pro": ["low", "high"],
  "gemini-3.1-flash-lite": ["low", "medium", "high"],
  "gemini-3.5-flash-lite": ["low", "medium", "high"],
} as const;
export type AntigravityModel = keyof typeof ANTIGRAVITY_MODEL_EFFORTS;
export function assertSupportedAntigravityModel(model?: string): AntigravityModel {
  const name = model?.replace(/^antigravity\//, "") ?? "gemini-3.1-flash-lite";
  if (!Object.hasOwn(ANTIGRAVITY_MODEL_EFFORTS, name))
    throw new Error(`Unsupported antigravity model: ${name}`);
  return name as AntigravityModel;
}
export function assertSupportedAntigravityEffortForModel(
  model: AntigravityModel,
  effort: string,
): void {
  const supported: readonly string[] = ANTIGRAVITY_MODEL_EFFORTS[model];
  if (!supported.includes(effort))
    throw new Error(
      `effort "${effort}" is not supported for antigravity/${model} (supported: ${supported.join(", ")})`,
    );
}
