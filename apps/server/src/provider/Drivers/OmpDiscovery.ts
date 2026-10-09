import type {
  OmpSettings,
  ServerProviderModel,
  ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeBuffer from "node:buffer";

import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { buildSelectOptionDescriptor } from "@t3tools/provider-core/server/snapshotProbe";
import { catalogFromCommandEntries, type OmpCommandCatalog } from "./OmpCommands.ts";

const CATALOG_MAX_BYTES = 4 * 1024 * 1024;
const CATALOG_RPC_MAX_BYTES = 16 * 1024 * 1024;
const RPC_FRAME_MAX_BYTES = 1024 * 1024;
const RPC_REASSEMBLED_MAX_BYTES = 8 * 1024 * 1024;
const RPC_CHUNK_MAX_BYTES = 256 * 1024;
const CATALOG_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_WORKSPACES = 32;
const NativeModel = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.optional(Schema.String),
  contextWindow: Schema.optional(Schema.Number),
  maxTokens: Schema.optional(Schema.Number),
  input: Schema.optional(Schema.Array(Schema.String)),
  reasoning: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(
    Schema.Struct({
      efforts: Schema.optional(Schema.Array(Schema.String)),
      defaultLevel: Schema.optional(Schema.String),
    }),
  ),
});
const ModelData = Schema.Struct({ models: Schema.Array(Schema.Unknown) });
const StateData = Schema.Struct({
  model: Schema.optional(Schema.NullOr(NativeModel)),
  thinkingLevel: Schema.optional(Schema.String),
});
const CommandData = Schema.Struct({ commands: Schema.Array(Schema.Unknown) });
const Frame = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  success: Schema.optional(Schema.Boolean),
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
const RpcChunk = Schema.Struct({
  type: Schema.Literal("rpc_chunk"),
  chunkId: Schema.String,
  index: Schema.Number,
  count: Schema.Number,
  byteLength: Schema.Number,
  data: Schema.String,
});
const ProtocolV2 = Schema.Struct({ protocolVersion: Schema.Literal(2) });
const JsonFrame = Schema.fromJsonString(Frame);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFrame = Schema.decodeOption(JsonFrame);
const decodeChunk = Schema.decodeOption(Schema.fromJsonString(RpcChunk));
const decodeProtocolV2 = Schema.decodeUnknownOption(ProtocolV2);
const decodeModels = Schema.decodeUnknownOption(ModelData);
const decodeState = Schema.decodeUnknownOption(StateData);
const decodeCommands = Schema.decodeUnknownOption(CommandData);
const decodeNativeModel = Schema.decodeUnknownOption(NativeModel);

export class OmpDiscoveryError extends Schema.TaggedError<OmpDiscoveryError>()(
  "OmpDiscoveryError",
  {
    stage: Schema.Literals(["spawn", "timeout", "exit", "decode"]),
    reason: Schema.optional(
      Schema.Literals(["no-models", "catalog-too-large", "rpc-command-failed"]),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Oh My Pi discovery was incomplete (${this.stage}).`;
  }
}

const isDiscoveryError = Schema.is(OmpDiscoveryError);

/** Global profile flags must precede subcommands such as usage/update in OMP 18.6. */
export function ompProfileArgs(settings: Pick<OmpSettings, "profile">): ReadonlyArray<string> {
  return settings.profile.trim() ? [`--profile=${settings.profile.trim()}`] : [];
}

/** Bounded finite process; stdin closes after requests, and scope owns teardown. */
export const runOmpReadOnlyCommand = Effect.fn("runOmpReadOnlyCommand")(function* (
  settings: Pick<OmpSettings, "binaryPath" | "profile">,
  environment: NodeJS.ProcessEnv,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly stdin?: string;
    readonly maxBytes?: number;
    readonly timeoutMs?: number;
  } = {},
) {
  const result = yield* Effect.gen(function* () {
    const binary = settings.binaryPath || "omp";
    const launch = yield* resolveSpawnCommand(binary, [...ompProfileArgs(settings), ...args], {
      env: environment,
    });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(launch.command, launch.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: environment,
        extendEnv: false,
        shell: launch.shell,
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({
          stream: child.stdout,
          maxBytes: options.maxBytes ?? CATALOG_MAX_BYTES,
        }),
        collectUint8StreamText({ stream: child.stderr, maxBytes: 64 * 1024 }),
        child.exitCode,
        Stream.run(Stream.encodeText(Stream.succeed(options.stdin ?? "")), child.stdin),
      ],
      { concurrency: "unbounded" },
    );
    if (stdout.truncated)
      return yield* new OmpDiscoveryError({ stage: "decode", reason: "catalog-too-large" });
    if (stdout.invalidUtf8) return yield* new OmpDiscoveryError({ stage: "decode" });
    return { stdout: stdout.text, stderr: stderr.text, code: Number(exitCode) };
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) =>
      isDiscoveryError(cause) ? cause : new OmpDiscoveryError({ stage: "spawn", cause }),
    ),
    Effect.timeoutOption(options.timeoutMs ?? CATALOG_TIMEOUT_MS),
  );
  if (Option.isNone(result)) return yield* new OmpDiscoveryError({ stage: "timeout" });
  return result.value;
});

export interface OmpModelMetadata {
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly inputModalities: ReadonlyArray<string>;
}
export interface OmpDiscovery extends OmpCommandCatalog {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly metadataBySlug: ReadonlyMap<string, OmpModelMetadata>;
  readonly checkedAt: string;
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

const readRpcFrames = Effect.fnUntraced(function* (stdout: string) {
  const frames: Array<typeof Frame.Type> = [];
  let protocolV2 = false;
  let pending:
    | {
        readonly chunkId: string;
        readonly count: number;
        readonly byteLength: number;
        readonly chunks: Array<Buffer>;
        receivedBytes: number;
      }
    | undefined;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") continue;
    if (
      Buffer.byteLength(line) + 1 >
      (protocolV2 ? RPC_FRAME_MAX_BYTES : RPC_REASSEMBLED_MAX_BYTES)
    )
      return yield* new OmpDiscoveryError({ stage: "decode", reason: "catalog-too-large" });
    const parsed = decodeFrame(line);
    if (Option.isNone(parsed)) {
      if (pending) return yield* new OmpDiscoveryError({ stage: "decode" });
      continue;
    }
    let frame = parsed.value;
    if (frame.type === "rpc_chunk") {
      const decoded = decodeChunk(line);
      if (!protocolV2 || Option.isNone(decoded))
        return yield* new OmpDiscoveryError({ stage: "decode" });
      const chunk = decoded.value;
      if (chunk.byteLength > RPC_REASSEMBLED_MAX_BYTES)
        return yield* new OmpDiscoveryError({ stage: "decode", reason: "catalog-too-large" });
      if (
        !chunk.chunkId ||
        chunk.chunkId.length > 128 ||
        !Number.isSafeInteger(chunk.index) ||
        !Number.isSafeInteger(chunk.count) ||
        !Number.isSafeInteger(chunk.byteLength) ||
        chunk.byteLength < RPC_FRAME_MAX_BYTES ||
        chunk.count !== Math.ceil(chunk.byteLength / RPC_CHUNK_MAX_BYTES) ||
        chunk.index < 0 ||
        chunk.index >= chunk.count ||
        !chunk.data ||
        chunk.data.length > 4 * Math.ceil(RPC_CHUNK_MAX_BYTES / 3) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
      )
        return yield* new OmpDiscoveryError({ stage: "decode" });
      const bytes = Buffer.from(chunk.data, "base64");
      if (bytes.toString("base64") !== chunk.data || bytes.length > RPC_CHUNK_MAX_BYTES)
        return yield* new OmpDiscoveryError({ stage: "decode" });
      if (!pending) {
        if (chunk.index !== 0) return yield* new OmpDiscoveryError({ stage: "decode" });
        pending = {
          chunkId: chunk.chunkId,
          count: chunk.count,
          byteLength: chunk.byteLength,
          chunks: [],
          receivedBytes: 0,
        };
      }
      if (
        chunk.chunkId !== pending.chunkId ||
        chunk.count !== pending.count ||
        chunk.byteLength !== pending.byteLength ||
        chunk.index !== pending.chunks.length
      )
        return yield* new OmpDiscoveryError({ stage: "decode" });
      pending.chunks.push(bytes);
      pending.receivedBytes += bytes.length;
      if (pending.receivedBytes > pending.byteLength)
        return yield* new OmpDiscoveryError({ stage: "decode" });
      if (pending.chunks.length !== pending.count) continue;
      const complete = Buffer.concat(pending.chunks, pending.receivedBytes);
      if (complete.length !== pending.byteLength || !NodeBuffer.isUtf8(complete))
        return yield* new OmpDiscoveryError({ stage: "decode" });
      const reassembled = decodeFrame(complete.toString("utf8"));
      if (Option.isNone(reassembled) || reassembled.value.type === "rpc_chunk")
        return yield* new OmpDiscoveryError({ stage: "decode" });
      frame = reassembled.value;
      pending = undefined;
    } else if (pending) {
      return yield* new OmpDiscoveryError({ stage: "decode" });
    }
    if (
      frame.type === "response" &&
      frame.id === "negotiate_protocol" &&
      frame.command === "negotiate_protocol" &&
      frame.success === true &&
      Option.isSome(decodeProtocolV2(frame.data))
    )
      protocolV2 = true;
    if (
      frame.type === "response" &&
      frame.id === frame.command &&
      ["get_state", "get_available_models", "get_available_commands"].includes(
        frame.command ?? "",
      ) &&
      frame.success === false
    )
      return yield* new OmpDiscoveryError({
        stage: "decode",
        reason:
          frame.error === "RPC response exceeded the transport limit"
            ? "catalog-too-large"
            : "rpc-command-failed",
      });
    frames.push(frame);
  }
  if (pending) return yield* new OmpDiscoveryError({ stage: "decode" });
  return frames;
});

function parseCatalog(
  frames: ReadonlyArray<typeof Frame.Type>,
  checkedAt: string,
): OmpDiscovery | undefined {
  const responses = new Map<string, unknown>();
  for (const value of frames) {
    if (
      value.type === "response" &&
      value.success === true &&
      value.id !== undefined &&
      value.id === value.command
    ) {
      responses.set(value.id, value.data);
    }
  }
  const modelData = decodeModels(responses.get("get_available_models"));
  const stateData = decodeState(responses.get("get_state"));
  const commandData = decodeCommands(responses.get("get_available_commands"));
  if (Option.isNone(modelData) || Option.isNone(stateData) || Option.isNone(commandData))
    return undefined;
  const active = stateData.value.model;
  const activeSlug = active ? `${active.provider}/${active.id}` : undefined;
  const models = new Map<string, ServerProviderModel>();
  const metadata = new Map<string, OmpModelMetadata>();
  for (const raw of modelData.value.models) {
    const decoded = decodeNativeModel(raw);
    if (Option.isNone(decoded)) continue;
    const model = decoded.value;
    const provider = model.provider;
    const id = model.id;
    if (!provider.trim() || !id.trim()) continue;
    const slug = `${provider}/${id}`;
    if (models.has(slug)) continue;
    const levels = [
      ...new Set(
        ["off", "auto", ...(model.reasoning ? (model.thinking?.efforts ?? []) : [])]
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ];
    const current =
      slug === activeSlug ? stateData.value.thinkingLevel : model.thinking?.defaultLevel;
    models.set(slug, {
      slug,
      name: model.name?.trim() || id,
      subProvider: provider,
      isCustom: false,
      ...(slug === activeSlug ? { isDefault: true } : {}),
      capabilities: {
        optionDescriptors: [
          buildSelectOptionDescriptor({
            id: "thinking",
            label: "Thinking",
            options: levels.map((value) => ({
              value,
              label: value,
              ...(value === current ? { isDefault: true } : {}),
            })),
          }),
        ],
      },
    });
    const contextWindow = positiveInteger(model.contextWindow);
    const maxTokens = positiveInteger(model.maxTokens);
    metadata.set(slug, {
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      inputModalities: model.input ?? [],
    });
  }
  return {
    models: [...models.values()].sort(
      (a, b) =>
        (a.subProvider ?? "").localeCompare(b.subProvider ?? "") || a.name.localeCompare(b.name),
    ),
    metadataBySlug: metadata,
    ...catalogFromCommandEntries(commandData.value.commands),
    checkedAt,
  };
}

/**
 * No prompt, authentication request, MCP injection, or persisted session is created.
 * RPC v1 rejects responses over 1 MiB. Negotiate v2 for bounded chunk reassembly;
 * older OMP versions that reject negotiation can still return plain JSONL.
 */
export const discoverOmpCatalog = Effect.fn("discoverOmpCatalog")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  if (!settings.enabled) return yield* new OmpDiscoveryError({ stage: "spawn" });
  const requests = ["get_state", "get_available_models", "get_available_commands"];
  const result = yield* runOmpReadOnlyCommand(
    settings,
    environment,
    [
      "--mode",
      "rpc",
      "--no-session",
      "--no-lsp",
      "--no-tools",
      "--no-ui",
      "--approval-mode=always-ask",
    ],
    {
      cwd,
      maxBytes: CATALOG_RPC_MAX_BYTES,
      stdin:
        `${encodeJson({ id: "negotiate_protocol", type: "negotiate_protocol", protocolVersion: 2 })}\n` +
        requests.map((type) => `${encodeJson({ id: type, type })}\n`).join(""),
    },
  );
  if (result.code !== 0)
    return yield* new OmpDiscoveryError({
      stage: "exit",
      ...(/^No models available\./m.test(result.stderr) ? { reason: "no-models" as const } : {}),
    });
  const frames = yield* readRpcFrames(result.stdout);
  const catalog = parseCatalog(frames, DateTime.formatIso(yield* DateTime.now));
  if (!catalog) return yield* new OmpDiscoveryError({ stage: "decode" });
  return catalog;
});

/** Instance-owned cache, keyed by cwd; hits never extend the original observation age. */
export const makeOmpDiscoveryCache = Effect.fnUntraced(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const semaphore = yield* Semaphore.make(1);
  const entries = new Map<string, { readonly expiresAt: number; readonly catalog: OmpDiscovery }>();
  const get = (cwd: string) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const previous = entries.get(cwd);
        if (previous && previous.expiresAt > now) return previous.catalog;
        const catalog = yield* discoverOmpCatalog(settings, environment, cwd).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        entries.delete(cwd);
        entries.set(cwd, { expiresAt: (yield* Clock.currentTimeMillis) + CACHE_TTL_MS, catalog });
        if (entries.size > MAX_WORKSPACES) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
        return catalog;
      }),
    );
  const workspaceSnapshots = (): ReadonlyArray<ServerProviderWorkspaceSnapshot> =>
    [...entries].map(([cwd, { catalog }]) => ({
      cwd,
      checkedAt: catalog.checkedAt,
      slashCommands: catalog.slashCommands,
      skills: catalog.skills,
    }));
  return {
    get,
    invalidate: semaphore.withPermits(1)(Effect.sync(() => entries.clear())),
    workspaceSnapshots,
  };
});
