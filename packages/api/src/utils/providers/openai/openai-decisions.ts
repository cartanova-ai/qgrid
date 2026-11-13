import { z } from "zod";

import {
  type DecideInput,
  type DecideOutput,
  type DecisionAnswer,
  type DecisionQuestion,
  OPENAI_DECISION_MODEL,
  type OpenAIDecisionAnswer,
  type OpenAIDecisionQuestion,
  OpenAIDecisionRequest,
  OpenAIDecisionResult,
} from "../../../application/qgrid/qgrid.types";
import { OpenAIProtocolError } from "./openai-backend-protocol";
import { type OpenAIDirectCredentials } from "./openai-direct-client";

/**
 * Public API endpoint, not the Codex private backend: it accepts the ChatGPT OAuth access token
 * as a plain Bearer token (live probe 2026-11-13; chatgpt.com/backend-api/codex/decisions is 404).
 */
export const OPENAI_DECISIONS_URL = "https://api.openai.com/v1/decisions";

const DECISIONS_TIMEOUT_MS = 60_000;

const errorBody = z.object({
  error: z.object({ message: z.string(), code: z.string().nullish() }),
});

/** One native Decisions call. Token selection and 401 refresh belong to `OpenAITokenPool.runWithToken`. */
export async function createOpenAIDecision(
  credentials: OpenAIDirectCredentials,
  input: OpenAIDecisionRequest,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<OpenAIDecisionResult> {
  const request = OpenAIDecisionRequest.parse(input);
  const timeout = AbortSignal.timeout(DECISIONS_TIMEOUT_MS);

  const response = await fetcher(OPENAI_DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(request),
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });

  const data: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const error = errorBody.safeParse(data);

    throw new OpenAIProtocolError(
      error.success
        ? error.data.error.message
        : `OpenAI Decisions returned HTTP ${response.status}`,
      (error.success ? error.data.error.code : undefined) ?? "decisions_http_error",
      response.status,
    );
  }

  const parsed = OpenAIDecisionResult.safeParse(data);

  if (!parsed.success) {
    throw new OpenAIProtocolError(
      "Invalid OpenAI Decisions response",
      "decisions_response_invalid",
    );
  }

  // Refusals carry the question name too, so every question must map to exactly one answer.
  const answered = parsed.data.answers.map((answer) => answer.name);

  if (
    answered.length !== request.questions.length ||
    request.questions.some((question) => !answered.includes(question.name))
  ) {
    throw new OpenAIProtocolError(
      "OpenAI Decisions must return exactly one answer per question",
      "decisions_response_invalid",
    );
  }

  return parsed.data;
}

// ---- qgrid neutral shape <-> OpenAI wire ------------------------------------

const jsonObject = z.record(z.string(), z.json());
const jsonObjects = z.array(jsonObject).min(1);
const plainText = z.string();

/** Text content stays as is; JSON content is serialized for OpenAI's text fields. */
function contentText(content: z.infer<ReturnType<typeof z.json>>): string {
  const text = plainText.safeParse(content);

  return text.success ? text.data : JSON.stringify(content);
}

function stateParts(state: DecideInput["state"]) {
  return state.map((part) => {
    if (part.type === "text") return { type: "input_text" as const, text: part.text };

    if (part.type === "image") return { type: "input_image" as const, image_url: part.url };

    // input_json takes an object or a nonempty array of objects; other JSON goes as text.
    const data = jsonObject.or(jsonObjects).safeParse(part.value);

    return data.success
      ? { type: "input_json" as const, data: data.data }
      : { type: "input_text" as const, text: JSON.stringify(part.value) };
  });
}

/**
 * Same mapping as @ai-sdk/openai's native decision model (4.0.116). Missing instructions become
 * "" so `OpenAIDecisionRequest` rejects them with 400 instead of OpenAI's error.
 */
function openaiQuestion(name: string, question: DecisionQuestion): OpenAIDecisionQuestion {
  const instructions = question.instructions == null ? "" : contentText(question.instructions);

  switch (question.type) {
    case "choice":
      return {
        type: "choice",
        name,
        instructions,
        choices: Object.entries(question.criteria).map(([value, description]) =>
          description == null ? { value } : { value, description: contentText(description) },
        ),
      };
    case "score":
      return {
        type: "score",
        name,
        instructions,
        levels: question.criteria.map((description, index) =>
          description == null
            ? { label: String(index) }
            : { label: String(index), description: contentText(description) },
        ),
      };
    case "boolean": {
      const parts = [
        instructions || undefined,
        question.criteria?.true == null
          ? undefined
          : `Criteria for true:\n${contentText(question.criteria.true)}`,
        question.criteria?.false == null
          ? undefined
          : `Criteria for false:\n${contentText(question.criteria.false)}`,
      ].filter((part) => part !== undefined);

      return { type: "predicate", name, instructions: parts.join("\n\n") };
    }
  }
}

/** Unvalidated OpenAI request; the caller parses it so limit violations surface as 400. */
export function toOpenAIDecisionRequest(input: DecideInput): z.input<typeof OpenAIDecisionRequest> {
  return {
    model: OPENAI_DECISION_MODEL,
    input: [{ role: "user", content: stateParts(input.state) }],
    questions: Object.entries(input.questions).map(([name, question]) =>
      openaiQuestion(name, question),
    ),
    prompt_cache_key: input.promptCacheKey,
    safety_identifier: input.safetyIdentifier,
  };
}

/**
 * Validation issues for the converted request, with `questions.<index>` rewritten to the caller's
 * question ID (the neutral request keys questions by ID; OpenAI's wire format is an array).
 */
export function decisionIssues(error: z.ZodError, questionIds: readonly string[]): string {
  return error.issues
    .map((issue) => {
      const [head, index, ...rest] = issue.path;

      const id =
        head === "questions" && Number.isInteger(index) ? questionIds[Number(index)] : undefined;

      const path = id === undefined ? issue.path : [head, id, ...rest];

      return `${path.join(".") || "input"}: ${issue.message}`;
    })
    .join("; ");
}

function neutralAnswer(question: DecisionQuestion, answer: OpenAIDecisionAnswer): DecisionAnswer {
  if (answer.type === "refusal") return { type: "refusal" };

  const confidence = answer.type !== "predicate" ? (answer.confidence ?? undefined) : undefined;

  if (question.type === "choice" && answer.type === "choice") {
    return {
      type: "choice",
      choice: answer.choice,
      probabilities: Object.fromEntries(answer.probabilities.map((p) => [p.value, p.probability])),
      ...(confidence !== undefined && { confidence }),
    };
  }

  if (question.type === "score" && answer.type === "score") {
    return {
      type: "score",
      score: answer.score,
      probabilities: Object.fromEntries(
        answer.probabilities.map((p) => [String(p.value), p.probability]),
      ),
      ...(confidence !== undefined && { confidence }),
    };
  }

  if (question.type === "boolean" && answer.type === "predicate") {
    return { type: "boolean", probability: answer.probability };
  }

  throw new OpenAIProtocolError(
    `OpenAI Decisions answered a ${question.type} question with ${answer.type}`,
    "decisions_response_invalid",
  );
}

/** Answers keyed by question ID. `createOpenAIDecision` already checked one answer per question. */
export function fromOpenAIDecisionResult(
  questions: DecideInput["questions"],
  result: OpenAIDecisionResult,
): Pick<DecideOutput, "answers" | "usage"> {
  const byName = new Map(result.answers.map((answer) => [answer.name, answer]));

  const answers = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      neutralAnswer(question, byName.get(id)!),
    ]),
  );

  return {
    answers,
    usage: {
      inputTokens: result.usage?.input_tokens ?? 0,
      outputTokens: result.usage?.output_tokens ?? 0,
      cachedInputTokens: result.usage?.input_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: result.usage?.input_tokens_details?.cache_write_tokens ?? 0,
    },
  };
}
