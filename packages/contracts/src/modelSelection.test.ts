import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  PROVIDER_DISPLAY_NAMES,
} from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);
const encodeModelSelection = Schema.encodeUnknownEffect(ModelSelection);

it.effect("ModelSelection migrates legacy `provider` field to `instanceId`", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      model: "gpt-5-codex",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex"));
    assert.strictEqual(parsed.model, "gpt-5-codex");
    assert.deepStrictEqual(parsed.options, [{ id: "reasoningEffort", value: "high" }]);
  }),
);

it.effect("ModelSelection prefers explicit instanceId over legacy provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeModelSelection({
      provider: "codex",
      instanceId: "codex_personal",
      model: "gpt-5-codex",
    });
    assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("codex_personal"));
  }),
);

it.effect(
  "ModelSelection decodes unknown driver kinds via legacy provider (rollback / fork invariant)",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "ollama",
        model: "llama3:70b",
        options: [{ id: "temperature", value: "0.4" }],
      });
      assert.strictEqual(parsed.instanceId, ProviderInstanceId.make("ollama"));
      assert.strictEqual(parsed.model, "llama3:70b");
    }),
);

it.effect("ModelSelection preserves native OMP model and thinking option ids", () =>
  Effect.gen(function* () {
    const input = {
      instanceId: "omp_work",
      model: "vendor/model:preview/variant",
      options: [{ id: "thinking", value: "auto" }],
    };
    const parsed = yield* decodeModelSelection(input);
    assert.deepStrictEqual(yield* encodeModelSelection(parsed), input);
  }),
);

it.effect(
  "ModelSelection canonicalizes legacy OMP selections without renaming native options",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeModelSelection({
        provider: "omp",
        model: "anthropic/claude-sonnet-4-6",
        options: { thinking: "high" },
      });
      assert.deepStrictEqual(yield* encodeModelSelection(parsed), {
        instanceId: "omp",
        model: "anthropic/claude-sonnet-4-6",
        options: [{ id: "thinking", value: "high" }],
      });
    }),
);

it("OMP defaults retain its session-selected model for chat and unattended generation", () => {
  const omp = ProviderDriverKind.make("omp");
  assert.strictEqual(DEFAULT_MODEL_BY_PROVIDER[omp], "default");
  assert.strictEqual(DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[omp], "default");
  assert.strictEqual(PROVIDER_DISPLAY_NAMES[omp], "Oh My Pi");
});

it.effect(
  "normalizes legacy object-shaped options on decode and re-encodes as a canonical array",
  () =>
    Effect.gen(function* () {
      const decoded = yield* decodeModelSelection({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,

          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      });
      assert.deepStrictEqual(decoded.options, [
        { id: "effort", value: "max" },
        { id: "fastMode", value: true },
      ]);
      const encoded = yield* encodeModelSelection(decoded);
      assert.deepStrictEqual(encoded.options, decoded.options);
    }),
);
