import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  OmpSettings,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { Crypto, Effect, FileSystem, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import { makeOmpAdapterV2 } from "./Adapters/OmpAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("omp");
const settings = Schema.decodeSync(OmpSettings)({});
const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-elicitation-" }).pipe(
  Layer.provide(NodeServices.layer),
);
const agent = `
const { createInterface } = require('node:readline');
const write = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\\n');
let promptId;
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  const reply = result => write({id:request.id,result});
  if (request.method === 'initialize') return reply({protocolVersion:1, agentInfo:{name:'omp',version:'18.6.0'}});
  if (request.method === 'session/new') return reply({sessionId:'opaque-native-session'});
  if (request.method === 'session/prompt') {
    promptId = request.id;
    return write({id:'form',method:'session/elicitation',params:{sessionId:'opaque-native-session',mode:'form',message:'Choose tools',requestedSchema:{type:'object',properties:{confirmed:{type:'boolean'},features:{type:'array',minItems:1,items:{anyOf:[{const:'Diff',title:'Diff'},{const:'Tools',title:'Tools'}]}},q0__other:{type:'string',title:'Other'}},required:['confirmed','features']}}});
  }
  if (request.id === 'form') {
    write({method:'session/update',params:{sessionId:'opaque-native-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(request.result)}}}});
    return write({id:promptId,result:{stopReason:'end_turn'}});
  }
  if (request.id !== undefined) reply({});
});
`;

const registryLayer = ProviderAdapterRegistry.makeLayerEffect(
  Effect.gen(function* () {
    const underlying = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) =>
      command._tag === "StandardCommand"
        ? underlying.spawn(ChildProcess.make(process.execPath, ["-e", agent], command.options))
        : underlying.spawn(command),
    );
    return [
      makeOmpAdapterV2({
        instanceId,
        settings,
        environment: {},
        childProcessSpawner: spawner,
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
        selfInvocation: yield* resolveSelfInvocation(),
      }),
    ];
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer, configLayer)));

const testLayer = makeOrchestratorV2ReplayLayerWithRegistry(
  { name: "omp-elicitation-retry" },
  registryLayer,
  { runEffectWorker: false },
);

it.live(
  "reopens a rejected OMP form durably and accepts a corrected answer through the effect worker",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("omp-form-thread");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("omp-form-create"),
        threadId,
        projectId: ProjectId.make("omp-form-project"),
        title: "OMP form",
        modelSelection: { instanceId, model: "default" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("omp-form-message"),
        threadId,
        messageId: MessageId.make("omp-form-message"),
        text: "Ask for tools",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      yield* worker.drain();
      const pending = Option.getOrThrow(
        yield* sink.stream({ threadId }).pipe(
          Stream.map((stored) => stored.event),
          Stream.filter(
            (event) =>
              event.type === "runtime-request.updated" && event.payload.status === "pending",
          ),
          Stream.runHead,
        ),
      );
      if (pending.type !== "runtime-request.updated")
        return yield* Effect.die("Missing form request");
      const requestId = pending.payload.id;
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("omp-form-invalid"),
        threadId,
        requestId,
        answers: { confirmed: "false", features: ["not-a-choice"] },
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests.find(
          (request) => request.id === requestId,
        )?.status,
        "resolved",
      );
      const afterSequence = yield* sink.latestSequence({ threadId });
      yield* worker.drain();
      yield* sink.stream({ threadId, afterSequence }).pipe(
        Stream.map((stored) => stored.event),
        Stream.filter(
          (event) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_input_request" &&
            event.payload.status === "waiting" &&
            event.payload.questions.some((question) =>
              question.question.includes("does not satisfy"),
            ),
        ),
        Stream.runHead,
      );
      const reopened = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        reopened.runtimeRequests.find((request) => request.id === requestId)?.status,
        "pending",
      );
      assert.equal(
        reopened.nodes.find((node) => node.runtimeRequestId === requestId)?.status,
        "waiting",
      );
      const question = reopened.turnItems.find(
        (item) => item.type === "user_input_request" && item.requestId === requestId,
      );
      assert.isTrue(
        question?.type === "user_input_request" &&
          question.questions.some((field) => field.question.includes("does not satisfy")),
      );
      const retrySequence = yield* sink.latestSequence({ threadId });
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("omp-form-corrected"),
        threadId,
        requestId,
        answers: { confirmed: "false", features: ["Tools"], q0__other: "" },
      });
      yield* worker.drain();
      const accepted = Option.getOrThrow(
        yield* sink.stream({ threadId, afterSequence: retrySequence }).pipe(
          Stream.map((stored) => stored.event),
          Stream.filter(
            (event) =>
              event.type === "message.updated" &&
              event.payload.role === "assistant" &&
              event.payload.text.includes('"action":"accept"'),
          ),
          Stream.runHead,
        ),
      );
      if (accepted.type !== "message.updated")
        return yield* Effect.die("Missing native form response");
      assert.include(accepted.payload.text, '"confirmed":false');
      assert.include(accepted.payload.text, '"features":["Tools"]');
      assert.notInclude(accepted.payload.text, "not-a-choice");
      assert.notInclude(accepted.payload.text, "q0__other");
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests.find(
          (request) => request.id === requestId,
        )?.status,
        "resolved",
      );
    }).pipe(Effect.provide(testLayer), Effect.scoped),
);
