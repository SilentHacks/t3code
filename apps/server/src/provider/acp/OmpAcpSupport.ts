import type { OmpSettings, RuntimeMode } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

export type OmpAcpRuntimeSettings = Pick<OmpSettings, "binaryPath" | "profile">;

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly ompSettings: OmpAcpRuntimeSettings;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  readonly disableTools?: boolean;
  readonly clientCapabilities?: AcpSessionRuntime.AcpSessionRuntimeOptions["clientCapabilities"];
}

export function ompAcpSpawnArgs(
  runtimeMode: RuntimeMode = "approval-required",
  disableTools = false,
): ReadonlyArray<string> {
  // Explicit argv beats profile defaults. OMP 18.6 accepts --auto-approve
  // (an unrestricted native mode, not an approval classifier).
  const approvalArgument =
    runtimeMode === "auto"
      ? "--auto-approve"
      : runtimeMode === "full-access"
        ? "--approval-mode=yolo"
        : runtimeMode === "auto-accept-edits"
          ? "--approval-mode=write"
          : "--approval-mode=always-ask";
  return ["acp", approvalArgument, ...(disableTools ? ["--no-tools"] : [])];
}

export function buildOmpAcpSpawnInput(
  ompSettings: OmpAcpRuntimeSettings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
  disableTools?: boolean,
): AcpSessionRuntime.AcpSpawnInput {
  const profile = ompSettings.profile.trim();
  return {
    command: ompSettings.binaryPath.trim() || "omp",
    args: [
      ...ompAcpSpawnArgs(runtimeMode, disableTools),
      ...(profile ? ["--profile", profile] : []),
    ],
    cwd,
    env: { ...process.env, ...environment },
  };
}

export const makeOmpAcpRuntime = Effect.fnUntraced(function* (input: OmpAcpRuntimeInput) {
  const {
    childProcessSpawner,
    ompSettings,
    environment,
    runtimeMode,
    disableTools = false,
    clientCapabilities,
    ...runtimeOptions
  } = input;
  const spawn = buildOmpAcpSpawnInput(
    ompSettings,
    input.cwd,
    environment,
    runtimeMode,
    disableTools,
  );
  const platform = input.processGroupPlatform ?? (yield* HostProcessPlatform);
  const ownsProcessGroup = input.ownDetachedProcessGroup ?? platform !== "win32";
  const baseLayer = AcpSessionRuntime.layer({
    ...runtimeOptions,
    // The generic runtime owns teardown; no OMP-specific process management.
    ownDetachedProcessGroup: ownsProcessGroup,
    ownDescendantProcessGroups: input.ownDescendantProcessGroups ?? platform === "linux",
    processGroupPlatform: platform,
    interruptPromptOnCancel: input.interruptPromptOnCancel ?? true,
    cancelBehavior: input.cancelBehavior ?? "interrupt",
    ...(disableTools ? { mcpServers: [], acpMcpServers: [] } : {}),
    // OMP user-input requests use the ACP form elicitation extension. An
    // unattended text-generation runtime must never advertise user interaction.
    clientCapabilities: disableTools
      ? {}
      : {
          ...clientCapabilities,
          _meta: { ...clientCapabilities?._meta, elicitation: { form: {} } },
        },
    spawn,
  });
  const context = yield* Layer.build(
    baseLayer.pipe(
      Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
    ),
  );
  const runtime = yield* AcpSessionRuntime.AcpSessionRuntime.pipe(Effect.provide(context));
  const promptGate = yield* Semaphore.make(1);
  let promptOutput: { sessionId: string; root: boolean; foreign: boolean } | undefined;
  yield* runtime.handleSessionUpdate((notification) =>
    Effect.sync(() => {
      if (
        promptOutput === undefined ||
        (notification.update.sessionUpdate !== "agent_message_chunk" &&
          notification.update.sessionUpdate !== "agent_message")
      )
        return;
      if (notification.sessionId === promptOutput.sessionId) promptOutput.root = true;
      else promptOutput.foreign = true;
    }),
  );
  return {
    ...runtime,
    prompt: (payload, promptOptions?) =>
      promptGate.withPermit(
        Effect.gen(function* () {
          const started = yield* runtime.start();
          promptOutput = { sessionId: started.sessionId, root: false, foreign: false };
          const result = yield* runtime.prompt(payload, promptOptions);
          // OMP 18.6 can move a contested journal without announcing its new ACP ID.
          // Never adopt foreign output or report a successful, invisible reply.
          if (result.stopReason !== "cancelled" && promptOutput.foreign && !promptOutput.root) {
            return yield* new EffectAcpErrors.AcpRequestError({
              code: -32603,
              errorMessage:
                "OMP replied under an unannounced session ID. Another OMP process may own this journal. Close the original session, restart this provider session, and retry. T3 did not adopt the unrelated session's output.",
            });
          }
          return result;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              promptOutput = undefined;
            }),
          ),
        ),
      ),
  } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
});
