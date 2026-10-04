import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import type { ElicitationContentValue } from "effect-acp/compat";

import { unknownRecord } from "./AcpClientPolicy.ts";

export class AcpElicitationAnswerError extends Schema.TaggedError<AcpElicitationAnswerError>()(
  "AcpElicitationAnswerError",
  { field: Schema.String, reason: Schema.Literals(["required", "invalid"]) },
) {
  override get message(): string {
    return this.reason === "required"
      ? `ACP answer for ${this.field} is required.`
      : `ACP answer for ${this.field || "form"} does not satisfy the requested schema.`;
  }
}

type Scalar = string | number | boolean;
type Choice = { value: Scalar; label: string; description: string };
type Field = {
  id: string;
  type: "string" | "number" | "integer" | "boolean" | "array";
  choices: ReadonlyArray<Choice> | undefined;
  required: boolean;
  accepts: (value: unknown) => boolean;
};

const scalar = Schema.is(Schema.Union([Schema.String, Schema.Boolean, Schema.Finite]));
const stringArray = Schema.is(Schema.Array(Schema.String));

const nullableAcpSchemaKeys = new Set([
  "title",
  "description",
  "default",
  "required",
  "enum",
  "oneOf",
  "anyOf",
  "enumNames",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);

function normalizeAcpSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    // ACP optional constraints use null for absent, and _meta is not a JSON Schema keyword.
    if (key === "_meta" || (value === null && nullableAcpSchemaKeys.has(key))) continue;
    const record = unknownRecord(value);
    const next =
      key === "properties" && record
        ? Object.fromEntries(
            Object.entries(record).map(([id, property]) => {
              const field = unknownRecord(property);
              return [id, field ? normalizeAcpSchema(field) : property];
            }),
          )
        : key === "items" && record
          ? normalizeAcpSchema(record)
          : (key === "oneOf" || key === "anyOf") && Array.isArray(value)
            ? value.map((branch) => {
                const option = unknownRecord(branch);
                return option ? normalizeAcpSchema(option) : branch;
              })
            : value;
    Object.defineProperty(normalized, key, { value: next, enumerable: true, configurable: true });
  }
  return normalized;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function choicesFromSchema(property: Record<string, unknown>): ReadonlyArray<Choice> | undefined {
  if (Array.isArray(property.enum)) {
    if (!property.enum.length || !property.enum.every(scalar)) return undefined;
    const names = Array.isArray(property.enumNames) ? property.enumNames : [];
    return property.enum.map((value, index) => {
      const label = text(names[index], text(String(value), "Empty"));
      return { value, label, description: text(String(value), label) };
    });
  }
  const branches = property.oneOf ?? property.anyOf;
  if (!Array.isArray(branches) || !branches.length) return undefined;
  const choices: Choice[] = [];
  for (const branch of branches) {
    const record = unknownRecord(branch);
    if (!record || !scalar(record.const)) return undefined;
    const label = text(record.title, text(String(record.const), "Empty"));
    choices.push({ value: record.const, label, description: text(record.description, label) });
  }
  return choices;
}

function validator(schema: Record<string, unknown>): (value: unknown) => boolean {
  // The importer enforces enum/union, required, size, range, and uniqueness checks.
  // Untrusted regex patterns and unsupported constraints are rejected, never ignored.
  return Schema.is(
    SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(schema)),
  );
}

/** Returns undefined when the existing question UX cannot faithfully represent a form. */
export function projectAcpElicitationForm(requestedSchema: unknown, message: string) {
  const requested = unknownRecord(requestedSchema);
  if (!requested || (requested.type !== undefined && requested.type !== "object")) return undefined;
  const schema = normalizeAcpSchema({ type: "object", properties: {}, ...requested });
  const properties = unknownRecord(schema.properties);
  if (!properties) return undefined;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      !schema.required.every((id) => typeof id === "string" && Object.hasOwn(properties, id)))
  ) {
    return undefined;
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const questions: OrchestrationV2UserInputQuestion[] = [];
  const fields: Field[] = [];
  try {
    for (const [id, property] of Object.entries(properties)) {
      // Question IDs cross a trimmed contract; decline rather than changing native field keys.
      if (!id || id !== id.trim()) return undefined;
      const record = unknownRecord(property);
      if (!record) return undefined;
      const choiceSchema = record.type === "array" ? unknownRecord(record.items) : record;
      if (!choiceSchema) return undefined;
      let choices = choicesFromSchema(choiceSchema);
      if (
        ("enum" in choiceSchema || "oneOf" in choiceSchema || "anyOf" in choiceSchema) &&
        !choices
      ) {
        return undefined;
      }
      const type = record.type ?? (choices ? typeof choices[0]?.value : undefined);
      if (
        type !== "string" &&
        type !== "boolean" &&
        type !== "number" &&
        type !== "integer" &&
        type !== "array"
      )
        return undefined;
      if (
        type === "array" &&
        (!choices || choices.some((choice) => typeof choice.value !== "string"))
      ) {
        return undefined;
      }
      if (type === "boolean" && !choices) {
        choices = [
          { value: true, label: "Yes", description: "Yes" },
          { value: false, label: "No", description: "No" },
        ];
      }
      if (
        choices &&
        new Set(choices.map((choice) => String(choice.value))).size !== choices.length
      ) {
        return undefined;
      }
      const accepts = validator(record);
      fields.push({ id, type, choices, required: required.has(id), accepts });
      questions.push({
        id,
        header: text(record.title, `Question ${questions.length + 1}`),
        question: text(record.description, text(record.title, text(message, "Please answer"))),
        options: (choices ?? []).map((choice) => ({
          value: String(choice.value),
          label: choice.label,
          description: choice.description,
        })),
        ...(type === "array" ? { multiSelect: true } : {}),
        allowCustomAnswer: !choices,
        required: required.has(id),
      });
    }
    const acceptsForm = validator(schema);
    const convertAnswers = Effect.fnUntraced(function* (answers: ProviderUserInputAnswers) {
      const content: Record<string, ElicitationContentValue> = {};
      for (const field of fields) {
        let value = Object.hasOwn(answers, field.id) ? answers[field.id] : undefined;
        // Older callers wrap scalar selections in an array (or { answers: [...] }).
        const nested = unknownRecord(value);
        if (nested && Object.hasOwn(nested, "answers")) value = nested.answers;
        if (field.type !== "array" && Array.isArray(value) && value.length === 1) value = value[0];
        if (
          value === undefined ||
          (!field.required &&
            typeof value === "string" &&
            !value.trim() &&
            !field.choices?.some((choice) => choice.value === value))
        ) {
          if (field.required)
            return yield* new AcpElicitationAnswerError({ field: field.id, reason: "required" });
          continue;
        }
        if (field.type !== "array" && typeof value === "string") {
          if (field.choices) {
            const choice = field.choices.find((entry) => String(entry.value) === value);
            if (choice) value = choice.value;
          } else if ((field.type === "number" || field.type === "integer") && value.trim()) {
            value = Number(value);
          }
        }
        if (!field.accepts(value) || !(scalar(value) || stringArray(value))) {
          return yield* new AcpElicitationAnswerError({ field: field.id, reason: "invalid" });
        }
        Object.defineProperty(content, field.id, { value, enumerable: true, configurable: true });
      }
      if (!acceptsForm(content))
        return yield* new AcpElicitationAnswerError({ field: "", reason: "invalid" });
      return content;
    });
    return { questions, convertAnswers };
  } catch {
    return undefined;
  }
}
