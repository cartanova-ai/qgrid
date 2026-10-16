/**
 * JSON Schema → OpenAI strict JSON Schema 변환.
 *
 * OpenAI Responses API strict 모드 요구사항:
 *  - 모든 object 에 additionalProperties: false
 *  - 모든 object properties 를 required 에 포함
 *  - optional 필드 → anyOf [original, { type: 'null' }] 로 required 유지
 *  - recursive 처리 (nested objects, arrays, allOf/anyOf/oneOf)
 */

import { z } from "zod";

import {
  SCHEMA_ARRAY_KEYWORDS,
  SCHEMA_MAP_KEYWORDS,
  SCHEMA_SINGLE_KEYWORDS,
  UNSUPPORTED_REFERENCE_KEYWORDS,
} from "./json-schema-keywords";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type ReadonlyJsonObject,
} from "./provider-types";

/** An object-form JSON Schema node. Boolean schemas and malformed members stay plain JSON values. */
export type JsonSchema = JsonObject;

export interface StrictifierOptions {
  provider?: string;
}

export class StrictifierError extends Error {
  constructor(
    message: string,
    public path: string,
  ) {
    super(`strictifier: ${message} (at ${path})`);
    this.name = "StrictifierError";
  }
}

export function strictify(input: ReadonlyJsonObject, options: StrictifierOptions = {}): JsonSchema {
  // Work on the JSON the provider will receive: a fresh copy, with undefined members dropped as
  // serialization drops them. JSON.parse without a reviver yields only JSON values.
  const serialized: JsonValue = JSON.parse(JSON.stringify(input));

  if (!isSchemaObject(serialized)) throw new StrictifierError("schema must be an object", "$");
  const schema = serialized;

  if (options.provider === "openai" || options.provider === "anthropic") {
    assertNormalizationCompatibility(schema, options.provider);
  }

  const result = strictifyNode(schema, "$", options.provider);

  if (options.provider === "openai" || options.provider === "anthropic") {
    assertNormalizationCompatibility(result, options.provider);
  }

  return result;
}

/**
 * 위치 목록은 json-schema-keywords 가 소유하고, 여기서는 각 위치의 `normalizable` 여부만 얹는다.
 * normalizable=true 는 strictifyNode 가 그 위치를 실제로 재작성한다는 뜻이다. `not`/`if` 처럼
 * 재작성하면 caller 의미가 바뀌는 위치는 false 이고, 그 아래 tuple/`$ref` 는 정규화 대신 거부된다.
 *
 * `items`/`additionalItems` 는 tuple 판정과 함께 다뤄야 해서 아래 순회에서 개별 처리한다.
 */
const NON_NORMALIZABLE_POSITIONS = new Set<string>([
  "dependentSchemas",
  "patternProperties",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function positionEntries(keywords: readonly string[]): ReadonlyArray<readonly [string, boolean]> {
  return keywords.map((keyword) => [keyword, !NON_NORMALIZABLE_POSITIONS.has(keyword)] as const);
}

const SCHEMA_SCAN_MAP_KEYWORDS = positionEntries(SCHEMA_MAP_KEYWORDS);
const SCHEMA_SCAN_ARRAY_KEYWORDS = positionEntries(SCHEMA_ARRAY_KEYWORDS);

// items/additionalItems 는 tuple 분기에서 직접 다루므로 단일 위치 스캔에서 제외한다.
const SCHEMA_SCAN_SINGLE_KEYWORDS = positionEntries(
  SCHEMA_SINGLE_KEYWORDS.filter((keyword) => keyword !== "items" && keyword !== "additionalItems"),
);

/**
 * Inspect every JSON Schema-bearing position without rewriting it.
 *
 * Positive positions already traversed by strictifyNode may normalize OpenAI tuples. Positions
 * such as `not` and `if` cannot be tightened without changing caller semantics, so positional
 * tuples there fail explicitly instead of leaking an unsupported provider schema. References
 * from those positions also fail because their definitions are normalized globally.
 */
function assertNormalizationCompatibility(
  schema: JsonSchema,
  provider: "openai" | "anthropic",
): void {
  const references: Array<{ value: string; path: string }> = [];

  const stack: Array<{ node: JsonSchema; path: string; normalizable: boolean }> = [
    { node: schema, path: "$", normalizable: true },
  ];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const itemsValue = ownValue(current.node, "items");
    const prefixItemsValue = ownValue(current.node, "prefixItems");
    const legacyTuple = Array.isArray(itemsValue);
    const prefixTuple = Array.isArray(prefixItemsValue);

    assertUnsupportedReferenceKeywords(current.node, current.path);
    collectSchemaReference(current, references);

    if (legacyTuple || prefixTuple) {
      const tuple = legacyTuple ? itemsValue : prefixTuple ? prefixItemsValue : [];

      if (provider === "anthropic" && tuple.length > 0) {
        throw new StrictifierError(
          "positional tuple schemas are not supported on Anthropic because Claude Code cannot preserve item positions",
          current.path,
        );
      }

      if (!current.normalizable) {
        throw new StrictifierError(
          "positional tuple schemas are not supported in this schema position",
          current.path,
        );
      }

      if (ownValue(current.node, "type") !== "array") {
        throw new StrictifierError(
          'positional tuple schemas must declare type "array"; express nullable tuples with anyOf',
          `${current.path}.type`,
        );
      }
    }

    for (const [keyword, keywordNormalizable] of SCHEMA_SCAN_MAP_KEYWORDS) {
      const schemas = ownValue(current.node, keyword);

      if (!isSchemaObject(schemas)) continue;

      for (const [name, child] of Object.entries(schemas)) {
        if (!isSchemaObject(child)) continue;
        stack.push({
          node: child,
          path: `${current.path}.${keyword}.${name}`,
          normalizable: current.normalizable && keywordNormalizable,
        });
      }
    }

    const dependencies = ownValue(current.node, "dependencies");

    if (isSchemaObject(dependencies)) {
      for (const [name, child] of Object.entries(dependencies)) {
        if (!isSchemaObject(child)) continue;
        stack.push({
          node: child,
          path: `${current.path}.dependencies.${name}`,
          normalizable: false,
        });
      }
    }

    for (const [keyword, keywordNormalizable] of SCHEMA_SCAN_ARRAY_KEYWORDS) {
      const schemas = ownValue(current.node, keyword);

      if (!Array.isArray(schemas)) continue;

      for (let index = 0; index < schemas.length; index += 1) {
        const child = schemas[index];

        if (!isSchemaObject(child)) continue;
        stack.push({
          node: child,
          path: `${current.path}.${keyword}[${index}]`,
          normalizable: current.normalizable && keywordNormalizable,
        });
      }
    }

    const items = ownValue(current.node, "items");

    if (isSchemaObject(items)) {
      stack.push({
        node: items,
        path: `${current.path}.items`,
        normalizable: current.normalizable,
      });
    } else if (Array.isArray(items)) {
      for (let index = 0; index < items.length; index += 1) {
        const child = items[index];

        if (!isSchemaObject(child)) continue;
        stack.push({
          node: child,
          path: `${current.path}.items[${index}]`,
          normalizable: current.normalizable,
        });
      }
    }

    const additionalItems = ownValue(current.node, "additionalItems");

    if (isSchemaObject(additionalItems)) {
      stack.push({
        node: additionalItems,
        path: `${current.path}.additionalItems`,
        normalizable: current.normalizable && legacyTuple,
      });
    }

    for (const [keyword, keywordNormalizable] of SCHEMA_SCAN_SINGLE_KEYWORDS) {
      const child = ownValue(current.node, keyword);

      if (!isSchemaObject(child)) continue;
      stack.push({
        node: child,
        path: `${current.path}.${keyword}`,
        normalizable: current.normalizable && keywordNormalizable,
      });
    }
  }

  assertReferenceTargets(schema, references);
}

function assertUnsupportedReferenceKeywords(schema: JsonSchema, path: string): void {
  for (const keyword of UNSUPPORTED_REFERENCE_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      throw new StrictifierError(`${keyword} is not supported`, `${path}.${keyword}`);
    }
  }
}

function collectSchemaReference(
  current: { node: JsonSchema; path: string; normalizable: boolean },
  references: Array<{ value: string; path: string }>,
): void {
  if (!Object.hasOwn(current.node, "$ref")) return;

  const reference = current.node.$ref;
  const referenceText = z.string().safeParse(reference);

  if (!referenceText.success) {
    throw new StrictifierError("$ref must be a string", `${current.path}.$ref`);
  }

  if (!current.normalizable) {
    throw new StrictifierError(
      "schema references are not supported in this schema position",
      current.path,
    );
  }

  references.push({ value: referenceText.data, path: `${current.path}.$ref` });
}

function assertReferenceTargets(
  root: JsonSchema,
  references: Array<{ value: string; path: string }>,
): void {
  for (const reference of references) {
    const tokens = parseLocalJsonPointer(reference.value, reference.path);

    if (!isDefinitionRootPointer(tokens)) {
      throw new StrictifierError(
        "$ref target must be the document root or a definition root",
        reference.path,
      );
    }

    resolveDefinitionRoot(root, tokens, reference.path);
  }
}

function isDefinitionRootPointer(tokens: string[]): boolean {
  if (tokens.length === 0) return true;

  if (tokens.length % 2 !== 0) return false;

  for (let index = 0; index < tokens.length; index += 2) {
    if (tokens[index] !== "$defs" && tokens[index] !== "definitions") return false;
  }

  return true;
}

function parseLocalJsonPointer(reference: string, path: string): string[] {
  if (reference === "#") return [];

  if (!reference.startsWith("#/")) {
    throw new StrictifierError(
      "only local root-relative JSON Pointer $ref values are supported",
      path,
    );
  }

  let fragment: string;

  try {
    fragment = decodeURIComponent(reference.slice(1));
  } catch {
    throw new StrictifierError("$ref contains invalid percent encoding", path);
  }

  if (!fragment.startsWith("/")) {
    throw new StrictifierError(
      "only local root-relative JSON Pointer $ref values are supported",
      path,
    );
  }

  return fragment
    .slice(1)
    .split("/")
    .map((token) => decodeJsonPointerToken(token, path));
}

function resolveDefinitionRoot(root: JsonSchema, tokens: string[], path: string): void {
  let current = root;

  for (let index = 0; index < tokens.length; index += 2) {
    const keyword = tokens[index]!;
    const name = tokens[index + 1]!;
    const definitions = ownValue(current, keyword);

    if (!isSchemaObject(definitions) || !Object.hasOwn(definitions, name)) {
      throw new StrictifierError("$ref does not resolve inside the caller schema", path);
    }

    const target = definitions[name];

    if (!isSchemaObject(target)) {
      throw new StrictifierError("$ref target must be an object schema", path);
    }

    current = target;
  }
}

function decodeJsonPointerToken(rawToken: string, path: string): string {
  let token = "";

  for (let index = 0; index < rawToken.length; index += 1) {
    const character = rawToken[index]!;

    if (character !== "~") {
      token += character;
      continue;
    }

    const escaped = rawToken[index + 1];

    if (escaped === "0") {
      token += "~";
    } else if (escaped === "1") {
      token += "/";
    } else {
      throw new StrictifierError("$ref contains an invalid JSON Pointer escape", path);
    }

    index += 1;
  }

  return token;
}

function strictifyNode(node: JsonSchema, path: string, provider?: string): JsonSchema {
  const dialectNeutralNode = provider === "openai" ? omitKeys(node, ["$schema"]) : node;
  let result = strictifySchemaMaps(dialectNeutralNode, path, provider);
  const type = ownValue(result, "type");

  if (type === "object" || Object.hasOwn(result, "properties")) {
    result = strictifyObject(result, path, provider);
  }

  if (type === "array" || Object.hasOwn(result, "items") || Object.hasOwn(result, "prefixItems")) {
    result = strictifyArray(result, path, provider);
  }

  return strictifySchemaArrays(result, path, provider);
}

/** Boolean and other non-object subschemas pass through unchanged. */
function strictifySubschema(schema: JsonValue, path: string, provider?: string): JsonValue {
  return isSchemaObject(schema) ? strictifyNode(schema, path, provider) : schema;
}

// 재작성 패스는 정의 맵만 재귀한다. properties 는 strictifyObject 가 별도로 처리하므로
// 공유 위치 목록(SCHEMA_MAP_KEYWORDS)과 의도적으로 범위가 다르다.
const DEFINITION_MAP_KEYWORDS = ["$defs", "definitions"] as const;

function strictifySchemaMaps(node: JsonSchema, path: string, provider?: string): JsonSchema {
  const result = { ...node };

  for (const keyword of DEFINITION_MAP_KEYWORDS) {
    const schemas = ownValue(node, keyword);

    if (!isSchemaObject(schemas)) continue;

    result[keyword] = Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        schema === undefined
          ? schema
          : strictifySubschema(schema, `${path}.${keyword}.${name}`, provider),
      ]),
    );
  }

  return result;
}

// prefixItems 는 strictifyArray 의 tuple 경로가 다루므로 여기서는 조합 keyword 만 재귀한다.
const COMBINATOR_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

function strictifySchemaArrays(node: JsonSchema, path: string, provider?: string): JsonSchema {
  const result = { ...node };

  for (const keyword of COMBINATOR_KEYWORDS) {
    const schemas = ownValue(node, keyword);

    if (!schemas) continue;

    if (!Array.isArray(schemas)) {
      throw new StrictifierError(`${keyword} must be an array of schemas`, `${path}.${keyword}`);
    }

    result[keyword] = schemas.map((schema, index) =>
      strictifySubschema(schema, `${path}.${keyword}[${index}]`, provider),
    );
  }

  return result;
}

function strictifyObject(node: JsonSchema, path: string, provider?: string): JsonSchema {
  const properties = ownValue(node, "properties");

  if (!properties) {
    return { ...node, additionalProperties: false };
  }

  if (!isSchemaObject(properties)) {
    throw new StrictifierError("properties must be an object", `${path}.properties`);
  }

  const required = ownValue(node, "required");

  const existingRequired = new Set(
    Array.isArray(required) ? required.flatMap((key) => z.string().safeParse(key).data ?? []) : [],
  );

  const allKeys = Object.keys(properties);

  // Object.fromEntries defines own data properties, so names such as "__proto__" stay ordinary keys.
  const strictProps = Object.fromEntries(
    allKeys.flatMap((key) => {
      const prop = properties[key];

      if (prop === undefined) return [];
      const strictProp = strictifySubschema(prop, `${path}.${key}`, provider);

      return [[key, existingRequired.has(key) ? strictProp : makeNullable(strictProp)]];
    }),
  );

  return {
    ...node,
    type: "object",
    properties: strictProps,
    required: allKeys,
    additionalProperties: false,
  };
}

function unreachableTupleTailSchema(): JsonSchema {
  return { type: "string" };
}

function strictifyArray(node: JsonSchema, path: string, provider?: string): JsonSchema {
  if (
    (provider === "openai" || provider === "anthropic") &&
    (Array.isArray(ownValue(node, "items")) || Array.isArray(ownValue(node, "prefixItems")))
  ) {
    return normalizeTuple(node, path, provider);
  }

  const result = { ...node };
  const items = ownValue(node, "items");

  if (Array.isArray(items)) {
    result.items = items.map((schema, index) =>
      strictifySubschema(schema, `${path}.items[${index}]`, provider),
    );
  } else if (items !== undefined) {
    result.items = strictifySubschema(items, `${path}.items`, provider);
  }

  const prefixItems = ownValue(node, "prefixItems");

  if (Array.isArray(prefixItems)) {
    result.prefixItems = prefixItems.map((schema, index) =>
      strictifySubschema(schema, `${path}.prefixItems[${index}]`, provider),
    );
  }

  return result;
}

function normalizeTuple(
  node: JsonSchema,
  path: string,
  provider: "openai" | "anthropic",
): JsonSchema {
  const items = ownValue(node, "items");
  const prefixItems = ownValue(node, "prefixItems");
  const legacyTuple = Array.isArray(items);
  const prefixTuple = Array.isArray(prefixItems);

  if (legacyTuple && prefixTuple) {
    throw new StrictifierError("items and prefixItems tuple forms cannot be combined", path);
  }

  if (prefixTuple && Object.hasOwn(node, "additionalItems")) {
    throw new StrictifierError("additionalItems cannot be combined with prefixItems", path);
  }

  const rawTuple = legacyTuple ? items : prefixTuple ? prefixItems : [];
  const tuplePath = legacyTuple ? `${path}.items` : `${path}.prefixItems`;

  const tuple = rawTuple.map((schema, index) => {
    if (!isSchemaObject(schema)) {
      throw new StrictifierError(
        "boolean and non-object tuple member schemas are not supported",
        `${tuplePath}[${index}]`,
      );
    }

    const memberPath = `${tuplePath}[${index}]`;
    const member = strictifyNode(schema, memberPath, provider);

    if (!hasProviderSchemaEntryPoint(member)) {
      throw new StrictifierError(
        "tuple member must define a provider-representable schema",
        memberPath,
      );
    }

    return member;
  });

  const rawTail = legacyTuple ? ownValue(node, "additionalItems") : items;

  if (rawTail === true) {
    throw new StrictifierError("an unrestricted tuple rest is not supported", path);
  }

  if (rawTail !== undefined && rawTail !== false && !isSchemaObject(rawTail)) {
    throw new StrictifierError("tuple rest must be an object schema or false", path);
  }

  const tail = isSchemaObject(rawTail)
    ? strictifyNode(rawTail, legacyTuple ? `${path}.additionalItems` : `${path}.items`, provider)
    : undefined;

  if (tail !== undefined && !hasProviderSchemaEntryPoint(tail)) {
    throw new StrictifierError("an unrestricted tuple rest is not supported", path);
  }

  const tailMode = tail !== undefined ? "typed" : rawTail === false ? "closed" : "implicit";
  const bounds = normalizeTupleBounds(node, tuple.length, tailMode, path);

  const result = omitKeys(node, [
    "items",
    "prefixItems",
    "additionalItems",
    "minItems",
    "maxItems",
  ]);

  // Anthropic 은 assertNormalizationCompatibility 가 비어 있지 않은 tuple 을 이미 거부했으므로
  // 여기 도달하는 tuple 은 빈 tuple 뿐이고, 그 경우 prefixItems 는 생략된다 —
  // provider 분기 없이 한 형태로 두 provider 모두를 표현한다.
  if (tuple.length > 0) result.prefixItems = tuple;
  result.items = tail ?? unreachableTupleTailSchema();
  result.minItems = bounds.minItems;

  if (bounds.maxItems !== undefined) result.maxItems = bounds.maxItems;

  return result;
}

interface TupleBounds {
  minItems: number;
  maxItems?: number;
}

function normalizeTupleBounds(
  node: JsonSchema,
  tupleLength: number,
  tailMode: "typed" | "closed" | "implicit",
  path: string,
): TupleBounds {
  const callerMinItems = integerBound(ownValue(node, "minItems"), "minItems", path);
  const callerMaxItems = integerBound(ownValue(node, "maxItems"), "maxItems", path);

  if (tailMode === "implicit" && callerMaxItems !== undefined && callerMaxItems > tupleLength) {
    throw new StrictifierError(
      "implicit tuple rest cannot be represented when maxItems exceeds the tuple length",
      path,
    );
  }

  const minItems = callerMinItems ?? (callerMaxItems === undefined ? tupleLength : 0);

  const maxItems =
    tailMode === "typed" ? callerMaxItems : Math.min(callerMaxItems ?? tupleLength, tupleLength);

  if (maxItems !== undefined && minItems > maxItems) {
    throw new StrictifierError("tuple minItems cannot exceed maxItems", path);
  }

  const bounds: TupleBounds = { minItems };

  if (maxItems !== undefined) bounds.maxItems = maxItems;

  return bounds;
}

const nonNegativeSafeInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 0);

function integerBound(
  value: JsonValue | undefined,
  keyword: string,
  path: string,
): number | undefined {
  if (value === undefined) return undefined;
  const bound = nonNegativeSafeInteger.safeParse(value);

  if (!bound.success) {
    throw new StrictifierError(`${keyword} must be a non-negative safe integer`, path);
  }

  return bound.data;
}

function isSchemaObject(value: JsonValue | undefined): value is JsonSchema {
  return isJsonObject(value);
}

function ownValue(schema: JsonSchema, keyword: string): JsonValue | undefined {
  return Object.hasOwn(schema, keyword) ? schema[keyword] : undefined;
}

const PROVIDER_SCHEMA_ENTRY_POINT_KEYWORDS = new Set([
  "type",
  "$ref",
  "properties",
  "anyOf",
  "oneOf",
  "allOf",
]);

function hasProviderSchemaEntryPoint(schema: JsonSchema): boolean {
  return Object.keys(schema).some((key) => PROVIDER_SCHEMA_ENTRY_POINT_KEYWORDS.has(key));
}

function omitKeys(node: JsonSchema, keys: readonly string[]): JsonSchema {
  const omitted = new Set(keys);

  return Object.fromEntries(Object.entries(node).filter(([key]) => !omitted.has(key)));
}

function hasNullVariant(variants: JsonValue[]): boolean {
  return variants.some(
    (variant) => isSchemaObject(variant) && ownValue(variant, "type") === "null",
  );
}

function makeNullable(schema: JsonValue): JsonValue {
  const nullSchema: JsonSchema = { type: "null" };

  if (!isSchemaObject(schema)) return { anyOf: [schema, nullSchema] };

  if (ownValue(schema, "type") === "null") return schema;

  const anyOf = ownValue(schema, "anyOf");

  if (anyOf) {
    if (!Array.isArray(anyOf)) throw new StrictifierError("anyOf must be an array of schemas", "$");

    return hasNullVariant(anyOf) ? schema : { anyOf: [...anyOf, nullSchema] };
  }

  const oneOf = ownValue(schema, "oneOf");

  if (oneOf) {
    if (!Array.isArray(oneOf)) throw new StrictifierError("oneOf must be an array of schemas", "$");

    return hasNullVariant(oneOf) ? schema : { oneOf: [...oneOf, nullSchema] };
  }

  return { anyOf: [schema, nullSchema] };
}
