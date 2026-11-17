import { getLogger } from "@logtape/logtape";
import { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";

import { errorStatusCode } from "../../server-error-handler";
import { QgridFrame } from "./qgrid.frame";
import { type QueryInput, type QueryOutput } from "./qgrid.types";

// OpenAI Chat Completions compatibility for third-party apps (e.g. Meetily) that only accept an
// OpenAI-compatible base URL. Scope: non-streaming text. Streaming, tools and images are rejected
// explicitly so callers do not mistake silent drops for model behavior.

const DEFAULT_PROJECT_NAME = "openai-compat";

// Only text parts are accepted; image or audio parts fail parsing with a 400.
const TextPart = z.object({ type: z.literal("text"), text: z.string() });

const MessageContent = z
  .union([z.string(), z.array(TextPart).transform((parts) => parts.map((p) => p.text).join(""))])
  .nullish()
  .transform((content) => content ?? "");

const ChatMessage = z.looseObject({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: MessageContent,
  tool_calls: z.array(z.unknown()).optional(),
});

// Sampling options (temperature, top_p, max_tokens, ...) pass through looseObject and are ignored:
// qgrid has no matching inputs, and rejecting them would break most clients.
export const ChatCompletionRequest = z.looseObject({
  model: z.string().min(1),
  messages: z.array(ChatMessage).min(1),
  stream: z.boolean().optional(),
  tools: z.array(z.unknown()).optional(),
});

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequest>;

const RequestHeaders = z.looseObject({ "x-qgrid-project": z.string().optional() });

export class ChatCompletionRequestError extends Error {}

export function toQueryInput(req: ChatCompletionRequest, projectName?: string): QueryInput {
  if (req.stream) throw new ChatCompletionRequestError("stream: true is not supported");

  if (req.tools?.length) throw new ChatCompletionRequestError("tools are not supported");

  const systemParts: string[] = [];
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];

  for (const message of req.messages) {
    if (message.role === "tool" || message.tool_calls?.length) {
      throw new ChatCompletionRequestError("tool messages are not supported");
    }

    if (message.role === "system" || message.role === "developer") {
      systemParts.push(message.content);
    } else {
      turns.push({ role: message.role, text: message.content });
    }
  }

  const last = turns.pop();

  if (last?.role !== "user") {
    throw new ChatCompletionRequestError("the last non-system message must be from the user");
  }

  // Same Responses-style items the AI SDK provider replays as `history`.
  const history = turns.map((turn) =>
    turn.role === "user"
      ? { type: "message", role: "user", content: [{ type: "input_text", text: turn.text }] }
      : { type: "message", role: "assistant", content: [{ type: "output_text", text: turn.text }] },
  );

  const input: QueryInput = {
    model: req.model,
    prompt: last.text,
    projectName: projectName || DEFAULT_PROJECT_NAME,
  };

  if (systemParts.length > 0) input.system = systemParts.join("\n\n");

  if (history.length > 0) input.history = JSON.stringify(history);

  return input;
}

export function toChatCompletion(result: QueryOutput, requestedModel: string) {
  const { usage } = result;

  const promptTokens =
    usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;

  return {
    id: `chatcmpl-${result.requestLogId ?? crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.model ?? requestedModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: usage.output_tokens,
      total_tokens: promptTokens + usage.output_tokens,
    },
  };
}

function sendError(reply: FastifyReply, status: number, message: string) {
  const type = status < 500 ? "invalid_request_error" : "server_error";

  return reply.status(status).send({ error: { message, type, code: null } });
}

// ponytail: calls QgridFrame.query outside Sonamu's HTTP context, so a client disconnect does not
// abort the provider call and 429 Retry-After headers are not set. Fix when adding streaming.
export async function chatCompletionsHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = ChatCompletionRequest.safeParse(request.body);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return sendError(reply, 400, `invalid request at ${issue?.path.join(".")}: ${issue?.message}`);
  }

  const projectName = RequestHeaders.safeParse(request.headers).data?.["x-qgrid-project"];
  let input: QueryInput;

  try {
    input = toQueryInput(parsed.data, projectName);
  } catch (e) {
    if (e instanceof ChatCompletionRequestError) return sendError(reply, 400, e.message);

    throw e;
  }

  try {
    const result = await QgridFrame.query(input);

    return reply.send(toChatCompletion(result, input.model ?? ""));
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    getLogger(["qgrid", "openai-compat"]).error(`${error}`);

    return sendError(reply, errorStatusCode(error), error.message);
  }
}
