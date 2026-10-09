import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { projectAcpElicitationForm } from "@t3tools/provider-acp/server/elicitation";

function form(properties: Record<string, unknown>, required?: string[]) {
  const result = projectAcpElicitationForm(
    { type: "object", properties, ...(required ? { required } : {}) },
    "Please answer",
  );
  assert.isDefined(result);
  return result!;
}

describe("ACP elicitation forms", () => {
  it.effect(
    "returns actual booleans for confirm, including false and legacy singleton answers",
    () =>
      Effect.gen(function* () {
        const projected = form({ value: { type: "boolean" } }, ["value"]);
        assert.deepEqual(projected.questions[0]?.options, [
          { value: "true", label: "Yes", description: "Yes" },
          { value: "false", label: "No", description: "No" },
        ]);
        assert.equal(projected.questions[0]?.allowCustomAnswer, false);
        for (const [answer, expected] of [
          ["true", true],
          ["false", false],
          [["false"], false],
          [{ answers: ["true"] }, true],
          [false, false],
        ] as const) {
          assert.deepEqual(yield* projected.convertAnswers({ value: answer }), { value: expected });
        }
        const invalid = yield* projected.convertAnswers({ value: "yes" }).pipe(Effect.flip);
        assert.equal(invalid._tag, "AcpElicitationAnswerError");
        assert.equal(invalid.field, "value");
      }),
  );

  it.effect(
    "projects OMP askDialog titles/descriptions, native IDs, multi-select and optional other",
    () =>
      Effect.gen(function* () {
        const projected = form({
          q0: {
            type: "string",
            title: "Choose target",
            oneOf: [
              { const: " first\t", title: "First", description: "Recommended" },
              { const: "second", title: "Second" },
            ],
          },
          q0__other: { type: "string", title: "Other" },
          q1: {
            type: "array",
            title: "Features",
            items: {
              anyOf: [
                { const: "diff", title: "Diffs", description: "Inspect changes" },
                { const: "tools", title: "Tools" },
              ],
            },
          },
          q1__other: { type: "string", title: "Other" },
        });
        assert.deepEqual(projected.questions[0]?.options, [
          { value: " first\t", label: "First", description: "Recommended" },
          { value: "second", label: "Second", description: "Second" },
        ]);
        assert.equal(projected.questions[2]?.multiSelect, true);
        assert.isTrue(projected.questions.every((question) => question.required === false));
        assert.deepEqual(
          yield* projected.convertAnswers({
            q0: " first\t",
            q0__other: "",
            q1: ["diff", "tools"],
            q1__other: "",
            unexpected: "secret",
          }),
          { q0: " first\t", q1: ["diff", "tools"] },
        );
        assert.deepEqual(yield* projected.convertAnswers({ q0__other: "Custom target" }), {
          q0__other: "Custom target",
        });
        assert.equal(
          (yield* projected.convertAnswers({ q1: ["diff", "unknown"] }).pipe(Effect.flip)).field,
          "q1",
        );
      }),
  );

  it.effect("supports ACP omitted defaults and nullable optional schema annotations", () =>
    Effect.gen(function* () {
      const projected = projectAcpElicitationForm(
        {
          required: null,
          title: null,
          _meta: { providerExtension: true },
          properties: {
            q0: {
              type: "string",
              enum: null,
              description: null,
              minLength: null,
              oneOf: [{ const: " first\t", title: "First", description: null, _meta: {} }],
            },
            q0__other: { type: "string", default: null, format: null },
            q1: { type: "array", items: { oneOf: [{ const: "tools", title: "Tools" }] } },
          },
        },
        "Answer",
      );
      assert.isDefined(projected);
      assert.deepEqual(
        yield* projected!.convertAnswers({ q0: " first\t", q0__other: " \t", q1: ["tools"] }),
        {
          q0: " first\t",
          q1: ["tools"],
        },
      );
      const empty = projectAcpElicitationForm({}, "Answer");
      assert.isDefined(empty);
      assert.deepEqual(empty!.questions, []);
      assert.deepEqual(yield* empty!.convertAnswers({ unexpected: "ignored" }), {});
    }),
  );

  it.effect("projects primitive anyOf choices and legacy multi-select answer wrappers", () =>
    Effect.gen(function* () {
      const projected = form({
        scalar: {
          anyOf: [
            { const: 1, title: "One" },
            { const: 2, title: "Two" },
          ],
        },
        multi: { type: "array", items: { type: "string", oneOf: [{ const: "a", title: "A" }] } },
      });
      assert.deepEqual(
        yield* projected.convertAnswers({ scalar: "2", multi: { answers: ["a"] } }),
        {
          scalar: 2,
          multi: ["a"],
        },
      );
    }),
  );

  it.effect("enforces required, enum, number/integer range, size, and uniqueness constraints", () =>
    Effect.gen(function* () {
      const projected = form(
        {
          target: {
            type: "string",
            enum: ["dev", "prod"],
            enumNames: ["Development", "Production"],
          },
          count: { type: "integer", minimum: 1, maximum: 3 },
          fraction: { type: "number", exclusiveMinimum: 0, maximum: 1 },
          note: { type: "string", minLength: 2, maxLength: 4 },
          features: {
            type: "array",
            items: { type: "string", enum: ["a", "b"] },
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
          },
        },
        ["target", "count"],
      );
      assert.equal(projected.questions[0]?.options[0]?.label, "Development");
      assert.equal(projected.questions[0]?.required, true);
      assert.deepEqual(
        yield* projected.convertAnswers({
          target: "dev",
          count: "2",
          fraction: "0.5",
          features: ["a", "b"],
        }),
        { target: "dev", count: 2, fraction: 0.5, features: ["a", "b"] },
      );
      for (const [key, value] of [
        ["target", "unknown"],
        ["count", "1.5"],
        ["count", "4"],
        ["count", "NaN"],
        ["fraction", "0"],
        ["note", "a"],
        ["note", "abcde"],
        ["features", []],
        ["features", ["a", "a"]],
        ["features", ["a", 1]],
      ] as const) {
        const error = yield* projected
          .convertAnswers({ target: "dev", count: 2, [key]: value })
          .pipe(Effect.flip);
        assert.equal(error.field, key);
        assert.equal(error.reason, "invalid");
      }
      const missing = yield* projected.convertAnswers({ count: 2 }).pipe(Effect.flip);
      assert.equal(missing.reason, "required");
      assert.equal(missing.field, "target");
    }),
  );

  it.effect("retains explicitly allowed empty enum values and numeric/boolean enum types", () =>
    Effect.gen(function* () {
      const projected = form({
        blank: { type: "string", enum: ["", "text"] },
        number: { type: "integer", enum: [1, 2] },
        boolean: { type: "boolean", enum: [false] },
      });
      assert.deepEqual(projected.questions[0]?.options[0], {
        value: "",
        label: "Empty",
        description: "Empty",
      });
      assert.deepEqual(
        yield* projected.convertAnswers({ blank: "", number: "2", boolean: "false" }),
        { blank: "", number: 2, boolean: false },
      );
      assert.equal(
        (yield* projected.convertAnswers({ boolean: "true" }).pipe(Effect.flip)).field,
        "boolean",
      );
    }),
  );

  it("declines forms that cannot be represented or safely validated", () => {
    for (const property of [
      { type: "object" },
      { type: "array", items: { type: "string" } },
      { type: "array", items: { enum: [1, 2] } },
      { type: "string", oneOf: [{ type: "string" }] },
      { type: "string", pattern: "(a+)+$" },
      { type: "string", enum: [] },
      { type: "string", contains: {} },
      { type: "string", $ref: "https://example.com/schema" },
    ]) {
      assert.isUndefined(
        projectAcpElicitationForm({ type: "object", properties: { value: property } }, "Answer"),
      );
    }
    assert.isUndefined(
      projectAcpElicitationForm(
        { type: "object", properties: {}, required: ["missing"] },
        "Answer",
      ),
    );
    assert.isUndefined(projectAcpElicitationForm({ type: "string" }, "Answer"));
    assert.isUndefined(projectAcpElicitationForm({ type: "object", properties: null }, "Answer"));
    assert.isUndefined(
      projectAcpElicitationForm({ properties: { " ": { type: "string" } } }, "Answer"),
    );
    assert.isUndefined(
      projectAcpElicitationForm({ properties: { " field": { type: "string" } } }, "Answer"),
    );
  });
});
