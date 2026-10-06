import { type ModelSelection, type OmpSettings, TextGenerationError } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { AcpRequestError } from "effect-acp/errors";
import {
  collectSessionConfigOptionValues,
  findSessionConfigOption,
} from "../provider/acp/AcpRuntimeModel.ts";
import { makeOmpAcpRuntime } from "../provider/acp/OmpAcpSupport.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const TIMEOUT_MS = 180_000;
const MAX_OUTPUT_CHARS = 128_000;
const isTextGenerationError = Schema.is(TextGenerationError);

/** Short-lived ACP helpers never receive the repository, MCP servers, or tool authority. */
export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  ompSettings: OmpSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const hostEnvironment = yield* HostProcessEnvironment;
  const processGroupPlatform = yield* HostProcessPlatform;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runJson = Effect.fn("OmpTextGeneration.runJson")(
    function* <S extends Schema.Top>(input: {
      readonly operation: keyof TextGeneration.TextGeneration["Service"];
      readonly prompt: string;
      readonly outputSchema: S;
      readonly modelSelection: ModelSelection;
    }) {
      const { operation } = input;
      const fail = (detail: string) => new TextGenerationError({ operation, detail });
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-text-" });
      const runtime = yield* makeOmpAcpRuntime({
        ompSettings,
        environment: environment ?? hostEnvironment,
        processGroupPlatform,
        childProcessSpawner,
        cwd,
        clientInfo: { name: "t3-code-text", version: "0.0.0" },
        runtimeMode: "approval-required",
        disableTools: true,
        protocolLogging: { logIncoming: false, logOutgoing: false },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      const output = yield* Ref.make("");
      const rejected = yield* Deferred.make<never, TextGenerationError>();
      const reject = (detail: string) => Deferred.fail(rejected, fail(detail)).pipe(Effect.asVoid);
      const rejectTool = () =>
        reject("OMP requested a tool or user input during text generation.").pipe(
          Effect.andThen(
            Effect.fail(
              new AcpRequestError({
                code: -32601,
                errorMessage: "Tools and user input are disabled for text generation.",
              }),
            ),
          ),
        );
      yield* runtime.handleRequestPermission(() =>
        reject("OMP requested permission during text generation.").pipe(
          Effect.as({ outcome: { outcome: "cancelled" as const } }),
        ),
      );
      // The shared ACP transport registers this handler for both elicitation wire forms.
      yield* runtime.handleElicitation(() =>
        reject("OMP requested user input during text generation.").pipe(
          Effect.as({ action: "decline" as const }),
        ),
      );
      yield* runtime.handleReadTextFile(rejectTool);
      yield* runtime.handleWriteTextFile(rejectTool);
      yield* runtime.handleCreateTerminal(rejectTool);
      yield* runtime.handleTerminalOutput(rejectTool);
      yield* runtime.handleTerminalWaitForExit(rejectTool);
      yield* runtime.handleTerminalKill(rejectTool);
      yield* runtime.handleTerminalRelease(rejectTool);
      yield* runtime.handleUnknownExtRequest(rejectTool);
      let sessionId: string | undefined;
      yield* runtime.handleSessionUpdate((notification) =>
        Effect.gen(function* () {
          const update = notification.update;
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            return yield* reject("OMP attempted tool work during text generation.");
          }
          if (
            notification.sessionId !== sessionId ||
            update.sessionUpdate !== "agent_message_chunk" ||
            update.content.type !== "text"
          )
            return;
          const text = update.content.text;
          const exceeded = yield* Ref.modify(output, (current) =>
            current.length + text.length > MAX_OUTPUT_CHARS
              ? [true, current]
              : [false, current + text],
          );
          if (exceeded) yield* reject("OMP text generation exceeded the output limit.");
        }),
      );
      const raw = yield* Effect.gen(function* () {
        const started = yield* runtime.start();
        sessionId = started.sessionId;
        // Product defaults are sentinels, never native ACP model IDs.
        const model = input.modelSelection.model;
        if (model && model !== "default" && model !== "auto") {
          const configs = yield* runtime.getConfigOptions;
          const modelConfig = configs?.find((option) => option.category === "model");
          if (modelConfig) {
            if (!collectSessionConfigOptionValues(modelConfig).includes(model)) {
              return yield* fail("The requested OMP model is not advertised by this session.");
            }
            if (modelConfig.currentValue !== model) yield* runtime.setModel(model);
          } else if (
            started.sessionSetupResult.models?.availableModels.some(
              (option) => option.modelId === model,
            )
          ) {
            yield* runtime.setSessionModel(model);
          } else {
            return yield* fail("OMP did not advertise the requested model.");
          }
        }
        // Model changes can replace thinking choices. Read the new descriptors first.
        const configs = yield* runtime.getConfigOptions;
        for (const selection of input.modelSelection.options ?? []) {
          const option = findSessionConfigOption(configs, selection.id);
          if (
            !option ||
            option.category === "model" ||
            option.category === "mode" ||
            option.category === "collaboration_mode"
          )
            continue;
          if (
            option.type === "boolean"
              ? typeof selection.value !== "boolean"
              : typeof selection.value !== "string" ||
                !collectSessionConfigOptionValues(option).includes(selection.value)
          )
            continue;
          if (option.currentValue !== selection.value)
            yield* runtime.setConfigOption(option.id, selection.value);
        }
        const result = yield* runtime.prompt({
          prompt: [
            {
              type: "text",
              text: [
                "Use only the input below. Do not use tools, read or write files, run commands, or ask questions.",
                "Return only the requested JSON object.",
                "",
                input.prompt,
              ].join("\n"),
            },
          ],
        });
        if (yield* Deferred.isDone(rejected)) return yield* Deferred.await(rejected);
        if (result.stopReason === "cancelled")
          return yield* fail("OMP text generation was cancelled.");
        return (yield* Ref.get(output)).trim();
      }).pipe(
        Effect.onInterrupt(() => runtime.cancel.pipe(Effect.timeoutOption(2_000), Effect.ignore)),
        Effect.raceFirst(Deferred.await(rejected)),
      );
      if ((yield* fs.readDirectory(cwd)).length > 0)
        return yield* fail("OMP wrote files during text generation.");
      if (!raw) return yield* fail("OMP returned empty text generation output.");
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
        extractJsonObject(raw),
      ).pipe(
        // Schema diagnostics contain the rejected value. Do not retain raw provider output.
        Effect.mapError(
          () =>
            new TextGenerationError({
              operation,
              detail: "OMP returned invalid structured output.",
            }),
        ),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOption(TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "OMP text generation timed out.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "OMP text generation failed.",
              }),
        ),
      ),
  );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OmpTextGeneration.generateCommitMessage")(function* (input) {
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        ...buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        }),
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });
  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("OmpTextGeneration.generatePrContent")(function* (input) {
      const generated = yield* runJson({
        operation: "generatePrContent",
        ...buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        }),
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });
  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("OmpTextGeneration.generateBranchName")(function* (input) {
      const generated = yield* runJson({
        operation: "generateBranchName",
        ...buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
          naming: input.naming,
        }),
        modelSelection: input.modelSelection,
      });
      return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
    });
  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OmpTextGeneration.generateThreadTitle")(function* (input) {
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        ...buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          linkedContext: input.linkedContext,
          attachments: input.attachments,
        }),
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });
  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
