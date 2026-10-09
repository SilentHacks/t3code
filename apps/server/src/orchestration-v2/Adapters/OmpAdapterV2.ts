import {
  defaultInstanceIdForDriver,
  OmpSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type RuntimeMode,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as NodeUtil from "node:util";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { makeOmpAcpRuntime } from "../../provider/acp/OmpAcpSupport.ts";
import { isManagedOmpCommand, isUnmanagedOmpPrompt } from "../../provider/Drivers/OmpCommands.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2SubagentUpdate,
} from "@t3tools/provider-acp/server/adapter";

export const OMP_PROVIDER = ProviderDriverKind.make("omp");
export const OMP_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(OMP_PROVIDER);
const DEFAULT_OMP_SETTINGS = Schema.decodeSync(OmpSettings)({});
const decodeOmpSettings = Schema.decodeEffect(OmpSettings);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export const OmpProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  // Shared ACP negotiation gates model switching, snapshot reading and
  // whole-session forking against the live handshake. No fork-at-turn.
  threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    emitsSubagentLifecycle: true,
    // OMP agent IDs are not ACP session IDs and cannot open child threads.
    exposesSubagentThreadIds: false,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface OmpAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly selfInvocation: Parameters<typeof makeAcpAdapterV2>[0]["selfInvocation"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: AcpAdapterV2Flavor["makeRuntime"];
  readonly onAvailableCommandsUpdate?: AcpAdapterV2Flavor["onAvailableCommandsUpdate"];
  readonly onSessionConfigurationUpdate?: AcpAdapterV2Flavor["onSessionConfigurationUpdate"];
}

const TaskIdentity = {
  id: Schema.NonEmptyString,
  agent: Schema.String,
  task: Schema.String,
  description: Schema.optionalKey(Schema.String),
  resolvedModelIdentity: Schema.optionalKey(Schema.String),
};
const decodeTaskOutput = Schema.decodeUnknownOption(
  Schema.Struct({
    details: Schema.Struct({
      projectAgentsDir: Schema.NullOr(Schema.String),
      results: Schema.Array(
        Schema.Struct({ ...TaskIdentity, exitCode: Schema.Number, output: Schema.String }),
      ),
      progress: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            ...TaskIdentity,
            status: Schema.Literals(["pending", "running", "completed", "failed", "aborted"]),
          }),
        ),
      ),
    }),
  }),
);

export const extractOmpSubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
) => {
  const parsed = Option.getOrUndefined(decodeTaskOutput(toolCall.data.rawOutput));
  if (parsed === undefined) return undefined;
  const { results, progress = [] } = parsed.details;
  // The shared hook accepts one subagent per tool call. Never collapse a batch
  // into a fabricated child; retain its complete native tool input/output.
  if (results.length > 1 || progress.length > 1) return undefined;
  const result = results[0];
  const agent = result ?? progress[0];
  if (agent === undefined || agent.id.trim().length === 0) return undefined;
  const status: AcpAdapterV2SubagentUpdate["status"] = result
    ? result.exitCode === 0
      ? "completed"
      : "failed"
    : progress[0]?.status === "aborted"
      ? "cancelled"
      : (progress[0]?.status ?? "pending");
  return {
    nativeTaskId: agent.id,
    prompt: agent.task,
    title: agent.description ?? agent.agent,
    model: agent.resolvedModelIdentity ?? null,
    status,
    childSessionId: null,
    result: result?.output ?? null,
  };
};

export function ompLaunchRuntimeMode(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  return policy.approvalPolicy === undefined && policy.sandboxPolicy === undefined
    ? policy.runtimeMode
    : "approval-required";
}

export function normalizeOmpSessionUpdate(
  notification: EffectAcpSchema.SessionNotification,
): EffectAcpSchema.SessionNotification {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "available_commands_update":
      return {
        ...notification,
        update: {
          ...update,
          availableCommands: update.availableCommands.filter(isManagedOmpCommand),
        },
      };
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return update.content.type === "text"
        ? {
            ...notification,
            update: {
              ...update,
              content: {
                ...update.content,
                text: NodeUtil.stripVTControlCharacters(update.content.text),
              },
            },
          }
        : notification;
    case "agent_message":
    case "agent_thought":
      return {
        ...notification,
        update: {
          ...update,
          ...(update.content == null
            ? {}
            : {
                content: update.content.map((content) =>
                  content.type === "text"
                    ? { ...content, text: NodeUtil.stripVTControlCharacters(content.text) }
                    : content,
                ),
              }),
        },
      };
    default:
      return notification;
  }
}

export function makeOmpAcpAdapterFlavor(options: OmpAdapterV2Options): AcpAdapterV2Flavor {
  const onAvailableCommandsUpdate = options.onAvailableCommandsUpdate;
  const makeRuntime: AcpAdapterV2Flavor["makeRuntime"] =
    options.makeRuntime ??
    (({ runtimePolicy, processEnvironment, ...input }) =>
      makeOmpAcpRuntime({
        ...input,
        ompSettings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
        childProcessSpawner: options.childProcessSpawner,
        runtimeMode: ompLaunchRuntimeMode(runtimePolicy),
      }));
  return {
    driver: OMP_PROVIDER,
    runtimeHarness: "OMP",
    capabilities: OmpProviderCapabilitiesV2,
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? { message: cause.errorMessage, code: String(cause.code) }
          : {}),
      }),
    supportsCompaction: true,
    interruptPromptOnCancel: true,
    restartRuntimeAfterInterrupt: true,
    terminateRuntimeProcessGroupOnInterrupt: true,
    resolveModelId: (selection) => selection.model.trim(),
    extractSubagentUpdate: extractOmpSubagentUpdate,
    ...(onAvailableCommandsUpdate === undefined
      ? {}
      : {
          onAvailableCommandsUpdate: (
            commands: Parameters<NonNullable<AcpAdapterV2Flavor["onAvailableCommandsUpdate"]>>[0],
          ) => onAvailableCommandsUpdate(commands.filter(isManagedOmpCommand)),
        }),
    ...(options.onSessionConfigurationUpdate === undefined
      ? {}
      : { onSessionConfigurationUpdate: options.onSessionConfigurationUpdate }),
    // OMP /fresh rotates its provider identity without an ACP identity-change
    // event; /move changes the workspace under T3's policy. Gate both rather
    // than trusting a foreign notification or silently losing the next turn.
    normalizeSessionUpdate: normalizeOmpSessionUpdate,
    makeRuntime: (input) =>
      makeRuntime(input).pipe(
        Effect.map((runtime) => ({
          ...runtime,
          prompt: (payload, promptOptions) => {
            const text = payload.prompt
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n");
            return isUnmanagedOmpPrompt(text)
              ? Effect.fail(
                  new EffectAcpErrors.AcpRequestError({
                    code: -32602,
                    errorMessage:
                      "OMP /fresh, /move, /wt and /worktree are not supported in a managed T3 thread. Start a new T3 thread or use T3's worktree controls instead.",
                  }),
                )
              : runtime.prompt(payload, promptOptions);
          },
        })),
      ),
  };
}

export function makeOmpAdapterV2(options: OmpAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeOmpAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
}

export type OmpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | ProviderHost.ProviderHost
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers;

export const OmpAdapterV2Driver: ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> = {
  driverKind: OMP_PROVIDER,
  configSchema: OmpSettings,
  defaultConfig: () => DEFAULT_OMP_SETTINGS,
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input) {
      const settings = yield* decodeOmpSettings(input.config);
      const environment = yield* HostProcessEnvironment;
      const selfInvocation = yield* resolveSelfInvocation();
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeOmpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...settings, enabled: input.enabled },
        environment: mergeProviderInstanceEnvironment(input.environment, environment),
        selfInvocation,
        childProcessSpawner,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: OMP_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create OMP ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
