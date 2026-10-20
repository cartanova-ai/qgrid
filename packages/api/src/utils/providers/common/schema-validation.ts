import { Buffer } from "node:buffer";

import { z } from "zod";

import { isJsonObject, type JsonValue } from "./provider-types";

/**
 * Caller-provided schemas are serialized, copied, and recursively normalized before dispatch.
 * Keep these limits comfortably above normal generated schemas while bounding that preprocessing
 * well below the API's 10 MiB request-body ceiling.
 */
export const CALLER_SCHEMA_LIMITS = {
  maxUtf8Bytes: 512 * 1024,
  maxNodes: 20_000,
  maxDepth: 128,
} as const;

// Linux permits at most 128 KiB (MAX_ARG_STRLEN) for one argv value. qgrid uses a 50% safety
// margin for every argv-delivered payload — Claude Code --json-schema here and the system-prompt
// transport (claude-session) both derive from this single constant.
export const ARGV_SAFE_MAX_UTF8_BYTES = 64 * 1024;
export const ANTHROPIC_SCHEMA_ARGV_MAX_UTF8_BYTES = ARGV_SAFE_MAX_UTF8_BYTES;

export class CallerSchemaValidationError extends Error {
  constructor(message: string) {
    super(`qgrid: ${message}`);
    this.name = "CallerSchemaValidationError";
  }
}

export interface CallerSchemasInput {
  jsonSchema?: string;
  tools?: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

interface ComplexityState {
  utf8Bytes: number;
  nodes: number;
  schemas: number;
}

export function parseAndValidateCallerSchemas(input: CallerSchemasInput): JsonValue | undefined {
  const state: ComplexityState = {
    utf8Bytes: 0,
    nodes: 0,
    schemas: 0,
  };

  let outputSchema: JsonValue | undefined;

  if (input.jsonSchema !== undefined) {
    addUtf8Bytes(Buffer.byteLength(input.jsonSchema, "utf8"), "jsonSchema", state);

    let parsed: JsonValue;

    try {
      // JSON.parse without a reviver yields only JSON values.
      parsed = JSON.parse(input.jsonSchema);
    } catch {
      throw new CallerSchemaValidationError("jsonSchema must contain valid JSON");
    }

    if (!isJsonObject(parsed) || parsed.type !== "object") {
      throw new CallerSchemaValidationError('jsonSchema top-level type must be "object"');
    }

    complexityWalk("jsonSchema", state, false).parse(parsed);
    state.schemas += 1;
    outputSchema = parsed;
  }

  for (const [index, tool] of (input.tools ?? []).entries()) {
    addToolMetadataUtf8Bytes(tool, index, state);

    const path = `tools[${index}].inputSchema`;
    complexityWalk(path, state, true).parse(tool.inputSchema);

    const serialized = callerJsonText.safeParse(tool.inputSchema);

    if (!serialized.success) {
      throw new CallerSchemaValidationError(`${path} must be JSON-serializable`);
    }

    // buildToolCallSchema embeds this serialization inside another JSON string. Charge the
    // escaped outer-string representation before that composed description is materialized.
    addUtf8Bytes(jsonStringContentUtf8ByteUpperBound(serialized.data), path, state);
    state.schemas += 1;
  }

  return outputSchema;
}

export function serializeAndValidateDispatchSchema(
  schema: JsonValue | undefined,
  provider?: string,
): string | undefined {
  if (schema === undefined) return undefined;

  const serialized = stringifyJsonOrThrow(schema, "dispatch schema");

  const byteLength = Buffer.byteLength(serialized, "utf8");

  if (byteLength > CALLER_SCHEMA_LIMITS.maxUtf8Bytes) {
    throw new CallerSchemaValidationError(
      `dispatch schema exceeds UTF-8 byte limit of ${CALLER_SCHEMA_LIMITS.maxUtf8Bytes}`,
    );
  }

  if (provider === "anthropic") {
    assertAnthropicSchemaArgvSize(serialized);
  }

  return serialized;
}

export function assertAnthropicSchemaArgvSize(jsonSchema: string): void {
  if (Buffer.byteLength(jsonSchema, "utf8") > ANTHROPIC_SCHEMA_ARGV_MAX_UTF8_BYTES) {
    throw new CallerSchemaValidationError(
      `Anthropic dispatch schema exceeds argv UTF-8 byte limit of ${ANTHROPIC_SCHEMA_ARGV_MAX_UTF8_BYTES}`,
    );
  }
}

/**
 * Decodes an opaque caller value (QgridTool.inputSchema is z.unknown() at the API boundary) into
 * its JSON text. Cycles, BigInt, and values with no JSON form (bare undefined, functions) fail.
 */
const callerJsonText = z.unknown().transform((value, context): string => {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }

  if (serialized === undefined) {
    context.addIssue({ code: "custom", message: "value is not JSON-serializable" });

    return z.NEVER;
  }

  return serialized;
});

function stringifyJsonOrThrow(value: JsonValue, subject: string): string {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new CallerSchemaValidationError(`${subject} must be JSON-serializable`);
  }

  if (serialized === undefined) {
    throw new CallerSchemaValidationError(`${subject} must be JSON-serializable`);
  }

  return serialized;
}

function addUtf8Bytes(byteLength: number, path: string, state: ComplexityState): void {
  state.utf8Bytes += byteLength;

  if (state.utf8Bytes > CALLER_SCHEMA_LIMITS.maxUtf8Bytes) {
    throwLimitError(path, "UTF-8 byte", CALLER_SCHEMA_LIMITS.maxUtf8Bytes, state);
  }
}

const TOOL_DESCRIPTION_ENTRY_PREFIX = "- ";
const TOOL_DESCRIPTION_NAME_SEPARATOR = ": ";
const TOOL_DESCRIPTION_INPUT_SCHEMA_PREFIX = "\n  inputSchema: ";
const TOOL_DESCRIPTION_ENTRY_SEPARATOR = "\n";

function addToolMetadataUtf8Bytes(
  tool: NonNullable<CallerSchemasInput["tools"]>[number],
  index: number,
  state: ComplexityState,
): void {
  const toolPath = `tools[${index}]`;

  // buildToolCallSchema places every tool name in both the enum and the human-readable tool
  // description. Count both escaped occurrences, plus the enum's JSON string delimiters.
  const encodedNameBytes = jsonStringContentUtf8ByteUpperBound(tool.name);
  addUtf8Bytes(encodedNameBytes * 2 + 2, `${toolPath}.name`, state);

  if (tool.description !== undefined) {
    addUtf8Bytes(
      jsonStringContentUtf8ByteUpperBound(tool.description),
      `${toolPath}.description`,
      state,
    );
  }

  // Per-tool framing also grows with the number of tools even when all caller strings are empty.
  // Include both the toolDescriptions join separator and the enum comma after the first entry.
  const framingBytes =
    jsonStringContentUtf8ByteUpperBound(TOOL_DESCRIPTION_ENTRY_PREFIX) +
    jsonStringContentUtf8ByteUpperBound(TOOL_DESCRIPTION_NAME_SEPARATOR) +
    jsonStringContentUtf8ByteUpperBound(TOOL_DESCRIPTION_INPUT_SCHEMA_PREFIX) +
    (index === 0 ? 0 : jsonStringContentUtf8ByteUpperBound(TOOL_DESCRIPTION_ENTRY_SEPARATOR) + 1);

  addUtf8Bytes(framingBytes, toolPath, state);
}

/**
 * Returns a conservative UTF-8 byte count for a string when it becomes JSON string content,
 * without allocating the escaped representation. JSON.stringify uses short two-byte escapes for
 * five control characters; counting every control character as a six-byte `\u00XX` escape keeps
 * this an upper bound while avoiding a second large temporary string.
 */
function jsonStringContentUtf8ByteUpperBound(value: string): number {
  let bytes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit === 0x22 || codeUnit === 0x5c) {
      bytes += 2;
      continue;
    }

    if (codeUnit <= 0x1f) {
      bytes += 6;
      continue;
    }

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);

      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        // Well-formed JSON.stringify escapes lone surrogates as `\uXXXX`.
        bytes += 6;
      }

      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      bytes += 6;
      continue;
    }

    bytes += codeUnit <= 0x7f ? 1 : codeUnit <= 0x7ff ? 2 : 3;
  }

  return bytes;
}

/**
 * Bounded, iterative walk over a caller schema, run before anything materializes its
 * serialization. Values are read one at a time, in key order, so a limit stops the walk before
 * later values (including getters) are touched. That rules out decoding each value with a schema
 * first; nodes are classified by identity instead: Object(value) === value holds exactly for
 * objects, arrays, and functions.
 */
function complexityWalk(path: string, state: ComplexityState, precheckUtf8Bytes: boolean) {
  return z.unknown().transform((root): void => {
    const rawUtf8Bytes = { value: 0 };

    if (precheckUtf8Bytes && isPrimitiveText(root)) {
      addRawUtf8LowerBound(root, path, state, rawUtf8Bytes);
    }

    addNode(path, state);

    if (root === null || root === undefined || Object(root) !== root) return;

    const rootObject: object = Object(root);
    const stack: Array<{ value: object; depth: number }> = [{ value: rootObject, depth: 0 }];

    while (stack.length > 0) {
      const current = stack.pop()!;

      if (Array.isArray(current.value)) {
        for (let index = 0; index < current.value.length; index += 1) {
          const depth = current.depth + 1;
          assertDepthWithinLimit(depth, path);
          addNode(path, state);

          const child: unknown = current.value[index];

          if (precheckUtf8Bytes && isPrimitiveText(child)) {
            addRawUtf8LowerBound(child, path, state, rawUtf8Bytes);
          }

          if (child !== null && child !== undefined && Object(child) === child) {
            stack.push({ value: Object(child), depth });
          }
        }

        continue;
      }

      for (const key in current.value) {
        if (!Object.hasOwn(current.value, key)) continue;

        if (precheckUtf8Bytes) {
          addRawUtf8LowerBound(key, path, state, rawUtf8Bytes);
        }

        const depth = current.depth + 1;
        assertDepthWithinLimit(depth, path);
        addNode(path, state);

        // Same read as current.value[key] for an own property: data value, or the getter's result.
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);

        const child: unknown = descriptor?.get
          ? descriptor.get.call(current.value)
          : descriptor?.value;

        if (precheckUtf8Bytes && isPrimitiveText(child)) {
          addRawUtf8LowerBound(child, path, state, rawUtf8Bytes);
        }

        if (child !== null && child !== undefined && Object(child) === child) {
          stack.push({ value: Object(child), depth });
        }
      }
    }
  });
}

/**
 * String test for the bounded walk. A failed zod parse builds a ZodError (which serializes the
 * input), so the walk uses identity: a primitive whose String() form is itself is a string.
 */
function isPrimitiveText(value: unknown): value is string {
  return Object(value) !== value && String(value) === value;
}

function addRawUtf8LowerBound(
  value: string,
  path: string,
  state: ComplexityState,
  rawUtf8Bytes: { value: number },
): void {
  rawUtf8Bytes.value += Buffer.byteLength(value, "utf8");

  if (state.utf8Bytes + rawUtf8Bytes.value > CALLER_SCHEMA_LIMITS.maxUtf8Bytes) {
    throwLimitError(path, "UTF-8 byte", CALLER_SCHEMA_LIMITS.maxUtf8Bytes, state);
  }
}

function assertDepthWithinLimit(depth: number, path: string): void {
  if (depth > CALLER_SCHEMA_LIMITS.maxDepth) {
    throw new CallerSchemaValidationError(
      `${path} exceeds depth limit of ${CALLER_SCHEMA_LIMITS.maxDepth}`,
    );
  }
}

function addNode(path: string, state: ComplexityState): void {
  state.nodes += 1;

  if (state.nodes > CALLER_SCHEMA_LIMITS.maxNodes) {
    throwLimitError(path, "node", CALLER_SCHEMA_LIMITS.maxNodes, state);
  }
}

function throwLimitError(
  path: string,
  kind: "UTF-8 byte" | "node",
  limit: number,
  state: ComplexityState,
): never {
  throw new CallerSchemaValidationError(
    state.schemas === 0
      ? `${path} exceeds ${kind} limit of ${limit}`
      : `caller schemas exceed aggregate ${kind} limit of ${limit}`,
  );
}
