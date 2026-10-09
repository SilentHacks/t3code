import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { OmpSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as AcpSchema from "effect-acp/compat";
import { expect, vi } from "vite-plus/test";
import { AcpSessionRuntime } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeOmpAcpRuntime } from "../provider/acp/OmpAcpSupport.ts";
import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";

vi.mock("../provider/acp/OmpAcpSupport.ts", () => ({ makeOmpAcpRuntime: vi.fn() }));
const encodeTextGenerationError = Schema.encodeEffect(Schema.fromJsonString(TextGenerationError));
const settings = Schema.decodeSync(OmpSettings)({ enabled: true, profile: "work" });
const selection = {
  instanceId: ProviderInstanceId.make("omp-work"),
  model: "Provider/Native.ID",
  options: [{ id: "thinking", value: "high" }],
};
type Runtime = AcpSessionRuntime["Service"];
const context = { requestId: "test", method: "test" };

const fixture = Effect.fn("ompTextFixture")(function* (
  options: {
    output?: string;
    stopReason?: AcpSchema.PromptResponse["stopReason"];
    request?:
      | "permission"
      | "question"
      | "file"
      | "write-file"
      | "terminal"
      | "extension"
      | "tool"
      | "disk-write";
    hang?: boolean;
  } = {},
) {
  const entered = yield* Deferred.make<void>();
  const fs = yield* FileSystem.FileSystem;
  const state = {
    workspaces: [] as string[],
    closed: [] as string[],
    calls: [] as string[],
    prompts: [] as string[],
    cancelled: 0,
    denied: false,
  };
  let model = "Provider/Initial";
  let thinking = "off";
  let sessionUpdate: Parameters<Runtime["handleSessionUpdate"]>[0] = () => Effect.void;
  let permission: Parameters<Runtime["handleRequestPermission"]>[0] = () =>
    Effect.die("Missing permission handler");
  let question: Parameters<Runtime["handleElicitation"]>[0] = () =>
    Effect.die("Missing question handler");
  let file: Parameters<Runtime["handleReadTextFile"]>[0] = () => Effect.die("Missing file handler");
  let writeFile: Parameters<Runtime["handleWriteTextFile"]>[0] = () =>
    Effect.die("Missing write handler");
  let terminal: Parameters<Runtime["handleCreateTerminal"]>[0] = () =>
    Effect.die("Missing terminal handler");
  let extension: Parameters<Runtime["handleUnknownExtRequest"]>[0] = () =>
    Effect.die("Missing extension handler");
  const config = (): AcpSchema.SessionConfigOption[] => [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [
        { value: model, name: "Initial" },
        { value: selection.model, name: "Native" },
      ],
    },
    {
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: thinking,
      options: (model === selection.model ? ["off", "high"] : ["off"]).map((value) => ({
        value,
        name: value,
      })),
    },
  ];
  const emit = (text: string) =>
    sessionUpdate({
      sessionId: "native/opaque-session",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    });
  vi.mocked(makeOmpAcpRuntime).mockImplementation((input) =>
    Effect.gen(function* () {
      state.workspaces.push(input.cwd);
      expect(input.runtimeMode).toBe("approval-required");
      expect(input.disableTools).toBe(true);
      expect(input.ompSettings.profile).toBe("work");
      expect(input.environment).toMatchObject({ OMP_ACCOUNT: "test" });
      expect(yield* fs.readDirectory(input.cwd).pipe(Effect.orDie)).toEqual([]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          state.closed.push(input.cwd);
        }),
      );
      const runtime = {
        processContainment: "none",
        start: () =>
          Effect.succeed({
            sessionId: "native/opaque-session",
            initializeResult: { protocolVersion: 1 },
            sessionSetupResult: { sessionId: "native/opaque-session", configOptions: config() },
            modelConfigId: "model",
          }),
        getConfigOptions: Effect.sync(config),
        getEvents: () => Stream.never,
        setModel: (value: string) =>
          Effect.sync(() => {
            state.calls.push(`model:${value}`);
            model = value;
          }),
        setConfigOption: (id: string, value: string | boolean) =>
          Effect.sync(() => {
            state.calls.push(`${id}:${value}`);
            thinking = String(value);
            return { configOptions: config() };
          }),
        prompt: (request: Parameters<Runtime["prompt"]>[0]) =>
          Effect.gen(function* () {
            state.prompts.push(
              request.prompt
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n"),
            );
            yield* Deferred.succeed(entered, undefined);
            if (options.hang) return yield* Effect.never;
            if (options.request === "permission") {
              const response = yield* permission(
                {
                  sessionId: "native/opaque-session",
                  options: [],
                  toolCall: { toolCallId: "tool" },
                },
                context,
              );
              state.denied = response.outcome.outcome === "cancelled";
            }
            if (options.request === "question") {
              const response = yield* question(
                {
                  sessionId: "native/opaque-session",
                  requestId: "question",
                  mode: "form",
                  message: "Secret?",
                  requestedSchema: { type: "object", properties: {} },
                },
                context,
              );
              state.denied = response.action === "decline";
            }
            if (options.request === "file") {
              yield* file({ sessionId: "native/opaque-session", path: "/private" }, context).pipe(
                Effect.ignore,
              );
              state.denied = true;
            }
            if (options.request === "write-file") {
              yield* writeFile(
                { sessionId: "native/opaque-session", path: "/private", content: "data" },
                context,
              ).pipe(Effect.ignore);
              state.denied = true;
            }
            if (options.request === "extension") {
              yield* extension(
                "_omp/writeOutsideWorkspace",
                { path: "/repo/private" },
                context,
              ).pipe(Effect.ignore);
              state.denied = true;
            }
            if (options.request === "disk-write")
              yield* fs.writeFileString(`${input.cwd}/unexpected`, "data").pipe(Effect.orDie);
            if (options.request === "terminal") {
              yield* terminal(
                { sessionId: "native/opaque-session", command: "echo private" },
                context,
              ).pipe(Effect.ignore);
              state.denied = true;
            }
            if (options.request === "tool")
              yield* sessionUpdate({
                sessionId: "native/opaque-session",
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "tool",
                  title: "Tool",
                  status: "pending",
                },
              });
            yield* emit(options.output ?? '{"title":"Repair login","needsRefinement":true}');
            return {
              stopReason: options.stopReason ?? "end_turn",
            } satisfies AcpSchema.PromptResponse;
          }),
        cancel: Effect.sync(() => {
          state.cancelled++;
        }),
        handleSessionUpdate: (handler: Parameters<Runtime["handleSessionUpdate"]>[0]) =>
          Effect.sync(() => {
            sessionUpdate = handler;
          }),
        handleRequestPermission: (handler: Parameters<Runtime["handleRequestPermission"]>[0]) =>
          Effect.sync(() => {
            permission = handler;
          }),
        handleElicitation: (handler: Parameters<Runtime["handleElicitation"]>[0]) =>
          Effect.sync(() => {
            question = handler;
          }),
        handleReadTextFile: (handler: Parameters<Runtime["handleReadTextFile"]>[0]) =>
          Effect.sync(() => {
            file = handler;
          }),
        handleCreateTerminal: (handler: Parameters<Runtime["handleCreateTerminal"]>[0]) =>
          Effect.sync(() => {
            terminal = handler;
          }),
        handleWriteTextFile: (handler: Parameters<Runtime["handleWriteTextFile"]>[0]) =>
          Effect.sync(() => {
            writeFile = handler;
          }),
        handleTerminalOutput: () => Effect.void,
        handleTerminalWaitForExit: () => Effect.void,
        handleTerminalKill: () => Effect.void,
        handleTerminalRelease: () => Effect.void,
        handleUnknownExtRequest: (handler) =>
          Effect.sync(() => {
            extension = handler;
          }),
      } satisfies Partial<Runtime>;
      const services = yield* Layer.build(Layer.mock(AcpSessionRuntime)(runtime));
      return yield* AcpSessionRuntime.pipe(Effect.provide(services));
    }),
  );
  const service = yield* makeOmpTextGeneration(settings, { OMP_ACCOUNT: "test" });
  return { service, state, entered };
});

it.layer(NodeServices.layer)("OmpTextGeneration", (it) => {
  it.effect(
    "negotiates the native model before refreshed thinking options and preserves title context",
    () =>
      Effect.gen(function* () {
        const { service, state } = yield* fixture();
        const generated = yield* service.generateThreadTitle({
          cwd: "/user/repository",
          message: "repair login",
          linkedContext: "Issue 42",
          modelSelection: selection,
        });
        expect(generated).toEqual({ title: "Repair login", needsRefinement: true });
        expect(state.calls).toEqual([`model:${selection.model}`, "thinking:high"]);
        expect(state.prompts[0]).toContain("Issue 42");
        expect(state.workspaces).not.toContain("/user/repository");
        expect(state.closed).toEqual(state.workspaces);
      }),
  );
  it.effect("keeps the default model sentinel local", () =>
    Effect.gen(function* () {
      const { service, state } = yield* fixture();
      yield* service.generateThreadTitle({
        cwd: "/repo",
        message: "repair",
        modelSelection: { ...selection, model: "default", options: [] },
      });
      expect(state.calls).toEqual([]);
    }),
  );
  it.effect(
    "rejects unadvertised models before prompting and skips unavailable thinking values",
    () =>
      Effect.gen(function* () {
        const { service, state } = yield* fixture();
        const error = yield* Effect.flip(
          service.generateThreadTitle({
            cwd: "/repo",
            message: "repair",
            modelSelection: { ...selection, model: "Provider/not-advertised" },
          }),
        );
        expect(error.detail).toContain("not advertised");
        expect(state.prompts).toEqual([]);
        expect(state.closed).toEqual(state.workspaces);
        yield* service.generateThreadTitle({
          cwd: "/repo",
          message: "repair",
          modelSelection: {
            ...selection,
            options: [
              { id: "thinking", value: "not-advertised" },
              { id: "unknown", value: true },
            ],
          },
        });
        expect(state.calls).toEqual([`model:${selection.model}`]);
      }),
  );
  it.effect("uses shared commit, PR and branch prompts and sanitizers", () =>
    Effect.gen(function* () {
      const commit = yield* fixture({ output: '{"subject":"Add OMP\\nextra","body":" Summary "}' });
      expect(
        yield* commit.service.generateCommitMessage({
          cwd: "/repo",
          branch: "feature/omp",
          stagedSummary: "M file",
          stagedPatch: "diff",
          modelSelection: selection,
        }),
      ).toEqual({ subject: "Add OMP", body: "Summary" });
      const pr = yield* fixture({ output: '{"title":"Add OMP","body":" Summary "}' });
      expect(
        yield* pr.service.generatePrContent({
          cwd: "/repo",
          baseBranch: "main",
          headBranch: "omp",
          commitSummary: "commit",
          diffSummary: "file",
          diffPatch: "diff",
          modelSelection: selection,
        }),
      ).toEqual({ title: "Add OMP", body: "Summary" });
      const branch = yield* fixture({ output: '{"branch":"Add OMP"}' });
      expect(
        (yield* branch.service.generateBranchName({
          cwd: "/repo",
          message: "add OMP",
          modelSelection: selection,
        })).branch,
      ).toContain("add-omp");
    }),
  );
  it.effect.each([
    "permission",
    "question",
    "file",
    "write-file",
    "terminal",
    "extension",
    "tool",
  ] as const)("rejects %s even alongside valid JSON", (request) =>
    Effect.gen(function* () {
      const { service, state } = yield* fixture({ request });
      const error = yield* Effect.flip(
        service.generateThreadTitle({
          cwd: "/repo",
          message: "repair",
          modelSelection: selection,
        }),
      );
      expect(error._tag).toBe("TextGenerationError");
      expect(error.detail).toMatch(/tool|permission|input/i);
      expect(state.closed).toEqual(state.workspaces);
    }),
  );
  it.effect("rejects files written directly into the empty workspace", () =>
    Effect.gen(function* () {
      const { service, state } = yield* fixture({ request: "disk-write" });
      const error = yield* Effect.flip(
        service.generateThreadTitle({
          cwd: "/repo",
          message: "repair",
          modelSelection: selection,
        }),
      );
      expect(error.detail).toContain("wrote files");
      expect(state.closed).toEqual(state.workspaces);
    }),
  );
  it.effect("rejects cancellation even if output parses", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture({ stopReason: "cancelled" });
      const error = yield* Effect.flip(
        service.generateThreadTitle({ cwd: "/repo", message: "repair", modelSelection: selection }),
      );
      expect(error.detail).toContain("cancelled");
    }),
  );
  it.effect.each([
    { name: "empty", output: "" },
    { name: "malformed", output: "not json" },
    { name: "oversized", output: "x".repeat(128_001) },
  ])("rejects $name output", ({ output }) =>
    Effect.gen(function* () {
      const { service, state } = yield* fixture({ output });
      const error = yield* Effect.flip(
        service.generateThreadTitle({ cwd: "/repo", message: "repair", modelSelection: selection }),
      );
      expect(error._tag).toBe("TextGenerationError");
      expect(state.closed).toEqual(state.workspaces);
    }),
  );
  it.effect("does not retain raw output in schema error diagnostics", () =>
    Effect.gen(function* () {
      const { service } = yield* fixture({
        output: '{"title":42,"sensitive":"private-output-marker"}',
      });
      const error = yield* Effect.flip(
        service.generateThreadTitle({
          cwd: "/repo",
          message: "repair",
          modelSelection: selection,
        }),
      );
      expect(error.detail).toContain("invalid structured output");
      expect(yield* encodeTextGenerationError(error)).not.toContain("private-output-marker");
    }),
  );
  it.effect("times out with cancellation and scoped cleanup", () =>
    Effect.gen(function* () {
      const { service, state, entered } = yield* fixture({ hang: true });
      const fiber = yield* Effect.forkChild(
        Effect.flip(
          service.generateThreadTitle({
            cwd: "/repo",
            message: "repair",
            modelSelection: selection,
          }),
        ),
      );
      yield* Deferred.await(entered);
      yield* TestClock.adjust(180_000);
      const error = yield* Fiber.join(fiber);
      expect(error.detail).toContain("timed out");
      expect(state.cancelled).toBe(1);
      expect(state.closed).toEqual(state.workspaces);
    }),
  );
});
