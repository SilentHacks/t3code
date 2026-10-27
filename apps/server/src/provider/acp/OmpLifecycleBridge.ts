// One token-authenticated Unix socket per OMP runtime, in a private 0700 directory.
// Relayed frames use the same session-update handlers as native ACP events.
// @effect-diagnostics nodeBuiltinImport:off -- Unix-socket IPC with an out-of-process extension.
// @effect-diagnostics globalTimers:off -- ack timeouts live inside a raw socket Promise.
// @effect-diagnostics preferSchemaOverJson:off -- outbound control lines are fixed literals.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import {
  OMP_LIFECYCLE_BRIDGE_EXTENSION_SOURCE,
  OMP_LIFECYCLE_BRIDGE_PROTOCOL_VERSION,
} from "./OmpLifecycleBridgeExtension.ts";

const OMP_BRIDGE_SOCKET_ENV = "T3_OMP_BRIDGE_SOCKET";
const OMP_BRIDGE_TOKEN_ENV = "T3_OMP_BRIDGE_TOKEN";
/** A missing or wedged extension must never stall a prompt. */
const PROMPT_BOUNDARY_ACK_TIMEOUT_MS = 1_000;
const MAX_LINE_BYTES = 8 * 1024 * 1024;

type SessionUpdateHandler = (
  notification: EffectAcpSchema.SessionNotification,
) => Effect.Effect<void, EffectAcpErrors.AcpError>;

const BridgeMessage = Schema.Union([
  Schema.Struct({ t: Schema.Literal("hello"), token: Schema.String, protocol: Schema.Number }),
  Schema.Struct({ t: Schema.Literal("ack"), seq: Schema.Number }),
  Schema.Struct({ t: Schema.Literal("session"), sessionId: Schema.String }),
  Schema.Struct({
    t: Schema.Literal("frames"),
    sessionId: Schema.String,
    notifications: Schema.Array(
      Schema.Struct({ sessionId: Schema.String, update: Schema.Unknown }),
    ),
  }),
]);
const decodeBridgeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(BridgeMessage));

export interface OmpLifecycleBridge {
  /** OMP argv that loads the bridge extension. */
  readonly spawnArgs: ReadonlyArray<string>;
  readonly environment: Readonly<Record<string, string>>;
  /** Registers a consumer for relayed root-session frames. */
  readonly handleSessionUpdate: (handler: SessionUpdateHandler) => Effect.Effect<void>;
  /** The ACP session T3 prompts. Frames from other OMP sessions (subagents) are dropped. */
  readonly setRootSession: (sessionId: string) => Effect.Effect<void>;
  /** Tells the extension a prompt opened or settled; waits briefly for its ack. */
  readonly promptBoundary: (input: {
    readonly active: boolean;
    readonly cancelled?: boolean;
  }) => Effect.Effect<void>;
  /** Whether an extension authenticated (used for diagnostics and tests). */
  readonly connected: Effect.Effect<boolean>;
}

interface BridgeClient {
  readonly socket: NodeNet.Socket;
  authenticated: boolean;
}

export const makeOmpLifecycleBridge: Effect.Effect<OmpLifecycleBridge, never, Scope.Scope> =
  Effect.gen(function* () {
    const token = NodeCrypto.randomBytes(32).toString("hex");
    const clients = new Set<BridgeClient>();
    const pendingAcks = new Map<number, Map<BridgeClient, () => void>>();
    const expected = Buffer.from(token);
    const tokenMatches = (candidate: string) => {
      const received = Buffer.from(candidate);
      return received.length === expected.length && NodeCrypto.timingSafeEqual(received, expected);
    };
    const handlers: Array<SessionUpdateHandler> = [];
    let rootSessionId: string | null = null;
    let boundarySeq = 0;
    const frames = yield* Queue.unbounded<EffectAcpSchema.SessionNotification>();

    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-omp-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const socketPath = NodePath.join(directory, "bridge.sock");
    const extensionPath = NodePath.join(directory, "t3-lifecycle-bridge.ts");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(extensionPath, OMP_LIFECYCLE_BRIDGE_EXTENSION_SOURCE, { mode: 0o600 }),
    );

    const accept = (client: BridgeClient, line: string) => {
      const decoded = decodeBridgeMessage(line);
      if (decoded._tag === "None") return;
      const message = decoded.value;
      if (!client.authenticated) {
        if (
          message.t === "hello" &&
          message.protocol === OMP_LIFECYCLE_BRIDGE_PROTOCOL_VERSION &&
          tokenMatches(message.token)
        ) {
          client.authenticated = true;
          return;
        }
        client.socket.destroy();
        return;
      }
      switch (message.t) {
        case "ack": {
          pendingAcks.get(message.seq)?.get(client)?.();
          return;
        }
        case "frames": {
          if (rootSessionId === null || message.sessionId !== rootSessionId) return;
          for (const notification of message.notifications) {
            if (notification.sessionId !== rootSessionId) continue;
            Queue.offerUnsafe(frames, notification as EffectAcpSchema.SessionNotification);
          }
          return;
        }
        default:
          return;
      }
    };

    const server = yield* Effect.acquireRelease(
      Effect.callback<NodeNet.Server>((resume) => {
        const server = NodeNet.createServer((socket) => {
          const client: BridgeClient = { socket, authenticated: false };
          clients.add(client);
          let buffered = "";
          socket.setEncoding("utf8");
          socket.on("data", (chunk: string) => {
            buffered += chunk;
            if (buffered.length > MAX_LINE_BYTES && !buffered.includes("\n")) {
              socket.destroy();
              return;
            }
            let newline = buffered.indexOf("\n");
            while (newline >= 0) {
              accept(client, buffered.slice(0, newline));
              buffered = buffered.slice(newline + 1);
              newline = buffered.indexOf("\n");
            }
          });
          socket.on("error", () => {});
          socket.on("close", () => clients.delete(client));
        });
        server.on("error", () => {});
        server.listen(socketPath, () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const client of clients) client.socket.destroy();
          server.close(() => resume(Effect.void));
        }),
    );
    server.unref();

    yield* Queue.take(frames).pipe(
      Effect.flatMap((notification) =>
        Effect.forEach([...handlers], (handler) => handler(notification).pipe(Effect.ignoreCause), {
          discard: true,
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    return {
      spawnArgs: ["--extension", extensionPath],
      environment: { [OMP_BRIDGE_SOCKET_ENV]: socketPath, [OMP_BRIDGE_TOKEN_ENV]: token },
      handleSessionUpdate: (handler) =>
        Effect.sync(() => {
          handlers.push(handler);
        }),
      setRootSession: (sessionId) =>
        Effect.sync(() => {
          rootSessionId = sessionId;
        }),
      promptBoundary: ({ active, cancelled = false }) =>
        Effect.promise(() => {
          const targets = [...clients].filter((client) => client.authenticated);
          if (targets.length === 0) return Promise.resolve();
          const seq = ++boundarySeq;
          const waiters = new Map<BridgeClient, () => void>();
          pendingAcks.set(seq, waiters);
          const line = `${JSON.stringify({ t: "prompt", seq, active, cancelled })}\n`;
          // Subagent sessions load their own extension instance; every
          // instance must hear the boundary before the prompt goes out.
          const acks = targets.map(
            (client) =>
              new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, PROMPT_BOUNDARY_ACK_TIMEOUT_MS);
                timer.unref?.();
                waiters.set(client, () => {
                  clearTimeout(timer);
                  resolve();
                });
                client.socket.write(line);
              }),
          );
          return Promise.all(acks).then(() => {
            pendingAcks.delete(seq);
          });
        }),
      connected: Effect.sync(() => [...clients].some((client) => client.authenticated)),
    } satisfies OmpLifecycleBridge;
  });
