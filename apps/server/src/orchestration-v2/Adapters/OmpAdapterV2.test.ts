import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  OmpSettings,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as ServerConfig from "../../config.ts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeOmpAcpRuntime } from "../../provider/acp/OmpAcpSupport.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "@t3tools/provider-core/server/ProviderAdapter";
import {
  extractOmpSubagentUpdate,
  makeOmpAcpAdapterFlavor,
  makeOmpAdapterV2,
  normalizeOmpSessionUpdate,
  type OmpAdapterV2Options,
  ompLaunchRuntimeMode,
  OmpProviderCapabilitiesV2,
} from "./OmpAdapterV2.ts";

// Native OMP 18.6 ACP shapes, with deliberately dynamic per-model thinking
// choices. This is a wire fixture, not a claim of live OMP inference acceptance.
const mockAgent = String.raw`
const readline = require('node:readline');
const sessionId = 'omp-session';
let model = 'Provider/Native-v1';
let thinking = 'low';
const capability = process.env.OMP_TEST_CAPABILITIES !== '0';
const loadSupported = capability && process.env.OMP_TEST_CAPABILITIES !== 'resume';
const resumeSupported = capability && process.env.OMP_TEST_CAPABILITIES !== 'load';
const options = () => [
  {id:'model',name:'Model',category:'model',type:'select',currentValue:model,options:[
    {value:'Provider/Native-v1',name:'Native'}, {value:'OpenAI/CaseSensitive-v2:custom',name:'Custom'}]},
  {id:'thinking',name:'Thinking',category:'thought_level',type:'select',currentValue:thinking,
    options:(model === 'Provider/Native-v1' ? ['low'] : ['high','max']).map(value=>({value,name:value}))}
];
const send = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const update = (update, id=sessionId) => send({method:'session/update',params:{sessionId:id,update}});
readline.createInterface({input:process.stdin}).on('line', line => {
  const {id,method,params} = JSON.parse(line);
  const reply = result => send({id,result});
  if (method === 'initialize') return reply({protocolVersion:1,agentInfo:{name:'omp-mock',version:'18.6.0'},
    agentCapabilities:capability ? {loadSession:loadSupported,promptCapabilities:{image:true},sessionCapabilities:{fork:{},...(resumeSupported?{resume:{}}:{})}} : {}});
  if (method === 'session/new') return reply({sessionId,configOptions:options()});
  if (method === 'session/load' || method === 'session/resume') {
    if (method === 'session/load' && process.env.OMP_TEST_REPLAY === '1') {
      update({sessionUpdate:'user_message_chunk',messageId:'history-user',content:{type:'text',text:'Original question'}},params.sessionId);
      update({sessionUpdate:'agent_message_chunk',messageId:'history-agent',content:{type:'text',text:'Original answer'}},params.sessionId);
    }
    return reply({configOptions:options()});
  }
  if (method === 'session/fork') return reply({sessionId:'omp-fork',configOptions:options()});
  if (method === 'session/set_config_option') {
    if (params.configId === 'model') {model=params.value;thinking=model==='Provider/Native-v1'?'low':'high';}
    if (params.configId === 'thinking') thinking=params.value;
    return reply({configOptions:options()});
  }
  if (method === 'session/cancel') return;
  if (method !== 'session/prompt') return send({id,error:{code:-32601,message:'Unsupported'}});
  if (process.env.OMP_TEST_PROMPT === 'hang') return;
  if (process.env.OMP_TEST_PROMPT === 'fail') return send({id,error:{code:-32603,message:'Provider failed; Authorization: Bearer test-secret-value'}});
  if (process.env.OMP_TEST_PROMPT === 'compact') {
    update({sessionUpdate:'compaction_update',compactionId:'omp-compact',status:'in_progress'});
    update({sessionUpdate:'compaction_update',compactionId:'omp-compact',status:'completed',summary:[{type:'text',text:'Native compaction summary'}]});
  }
  if (process.env.OMP_TEST_PROMPT === 'exit') return process.exit(3);
  if (process.env.OMP_TEST_PROMPT?.startsWith('interleaved')) {
    update({sessionUpdate:'agent_message_chunk',messageId:'answer',content:{type:'text',text:'Full explanation. '}});
    update({sessionUpdate:'agent_thought_chunk',messageId:'answer',content:{type:'text',text:'Checking the conclusion. '}});
    if (process.env.OMP_TEST_PROMPT === 'interleaved-messages') {
      update({sessionUpdate:'agent_message_chunk',messageId:'other-answer',content:{type:'text',text:'Separate message.'}});
    }
    update({sessionUpdate:'agent_message_chunk',messageId:'answer',content:{type:'text',text:'Final sentences.'}});
    update({sessionUpdate:'agent_thought_chunk',messageId:'answer',content:{type:'text',text:'Done.'}});
    return reply({stopReason:'end_turn'});
  }
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FOREIGN'}}, 'unrelated-session');
  if (process.env.OMP_TEST_PROMPT === 'relocate') return reply({stopReason:'end_turn'});
  update({sessionUpdate:'available_commands_update',availableCommands:[
    {name:'compact',description:'Compact context'}, {name:'fresh',description:'New provider ID'}, {name:'move',description:'Move workspace'}]});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OMP response'}});
  update({sessionUpdate:'tool_call',toolCallId:'task-call',title:'task',kind:'other',status:'in_progress',rawInput:{agent:'explore',task:'Inspect repository'}});
  update({sessionUpdate:'tool_call_update',toolCallId:'task-call',status:'completed',rawOutput:{
    content:[{type:'text',text:'Found it'}],details:{projectAgentsDir:null,results:[
      {id:'native-agent-42',agent:'explore',task:'Inspect repository',exitCode:0,output:'Found it',resolvedModelIdentity:model}]}}});
  update({sessionUpdate:'usage_update',used:420,size:10000,cost:{amount:0.01,currency:'USD'}});
  update({sessionUpdate:'session_info_update',title:'Native OMP title',updatedAt:'2026-07-01T00:00:00Z'});
  reply({stopReason:'end_turn'});
});
`;

const serverConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-v2-" }).pipe(
  Layer.provide(NodeServices.layer),
);
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  serverConfigLayer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const settings = Schema.decodeSync(OmpSettings)({ binaryPath: "omp-test", profile: "work" });
const instanceId = ProviderInstanceId.make("omp-test");
const threadId = ThreadId.make("omp-test-thread");
const policy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: process.cwd(),
});

const makeHarness = Effect.fnUntraced(function* (environment: NodeJS.ProcessEnv = {}) {
  const underlying = yield* ChildProcessSpawner.ChildProcessSpawner;
  const launches: Array<ChildProcess.StandardCommand> = [];
  const requests: Array<AcpSessionRuntime.AcpSessionRequestLogEvent> = [];
  const promptSent = yield* Deferred.make<void>();
  const availableCommands: Array<ReadonlyArray<string>> = [];
  const childProcessSpawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") return underlying.spawn(command);
    launches.push(command);
    return underlying.spawn(
      ChildProcess.make(process.execPath, ["-e", mockAgent], command.options),
    );
  });
  const options = {
    instanceId,
    settings,
    environment,
    childProcessSpawner,
    selfInvocation: yield* resolveSelfInvocation(),
    onAvailableCommandsUpdate: (commands) =>
      Effect.sync(() => {
        availableCommands.push(commands.map((command) => command.name));
      }),
    nativeLogging: () => ({
      requestLogger: (request: AcpSessionRuntime.AcpSessionRequestLogEvent) =>
        Effect.sync(() => requests.push(request)).pipe(
          Effect.andThen(
            request.method === "session/prompt" && request.status === "started"
              ? Deferred.succeed(promptSent, undefined)
              : Effect.void,
          ),
          Effect.asVoid,
        ),
      protocolLogging: { logIncoming: false, logOutgoing: false },
    }),
  } satisfies OmpAdapterV2Options;
  return {
    adapter: yield* makeOmpAdapterV2(options),
    flavor: makeOmpAcpAdapterFlavor(options),
    options,
    requests,
    launches,
    promptSent,
    availableCommands,
  };
});

const openHarness = Effect.fnUntraced(function* (
  input: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly selection?: ModelSelection;
  } = {},
) {
  const harness = yield* makeHarness(input.environment);
  const modelSelection = input.selection ?? { instanceId, model: "default" };
  const runtime = yield* harness.adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("omp-test-session"),
    modelSelection,
    runtimePolicy: policy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy: policy,
  });
  return { ...harness, runtime, providerThread, modelSelection };
});

const turnInput = Effect.fnUntraced(function* (
  input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly modelSelection: ModelSelection;
  },
  text = "Inspect the repository",
): Effect.fn.Return<ProviderAdapterV2TurnInput> {
  const now = yield* DateTime.now;
  return {
    appThread: {
      id: threadId,
      projectId: ProjectId.make("omp-test-project"),
      createdBy: "user",
      creationSource: "web",
      title: "OMP test",
      providerInstanceId: instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: input.providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    threadId,
    runId: RunId.make("omp-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("omp-attempt"),
    rootNodeId: NodeId.make("omp-node"),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make("omp-message"),
      text,
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimePolicy: policy,
  };
});

const task = (rawOutput: unknown) => ({
  toolCallId: "task-call",
  title: "task",
  status: "completed" as const,
  data: { rawInput: { agent: "explore", task: "Inspect" }, rawOutput },
});

describe("OMP truthful task projection", () => {
  it("projects only native single-agent IDs, not ACP child-thread IDs", () => {
    expect(
      extractOmpSubagentUpdate(
        task({
          content: [{ type: "text", text: "Done" }],
          details: {
            projectAgentsDir: null,
            results: [
              {
                id: "agent-7",
                agent: "explore",
                task: "Inspect",
                exitCode: 0,
                output: "Done",
                resolvedModelIdentity: "Provider/Native-v1",
              },
            ],
          },
        }),
      ),
    ).toMatchObject({
      nativeTaskId: "agent-7",
      childSessionId: null,
      status: "completed",
      result: "Done",
    });
  });
  it("keeps native progress and cancellation statuses", () => {
    expect(
      extractOmpSubagentUpdate(
        task({
          details: {
            projectAgentsDir: null,
            results: [],
            progress: [{ id: "agent-7", agent: "explore", task: "Inspect", status: "aborted" }],
          },
        }),
      )?.status,
    ).toBe("cancelled");
  });
  it("does not invent agents from bare tool input, summaries, malformed IDs or batch results", () => {
    const result = {
      id: "agent-7",
      agent: "explore",
      task: "Inspect",
      exitCode: 0,
      output: "Done",
    };
    for (const output of [
      undefined,
      "Spawned agent",
      { details: { results: [result] } },
      { details: { projectAgentsDir: null, results: [{ ...result, id: "" }] } },
      { details: { projectAgentsDir: null, results: [result, { ...result, id: "agent-8" }] } },
    ]) {
      expect(extractOmpSubagentUpdate(task(output))).toBeUndefined();
    }
    expect(OmpProviderCapabilitiesV2.subagents.exposesSubagentThreadIds).toBe(false);
    expect(OmpProviderCapabilitiesV2.threads.canForkFromTurn).toBe(false);
    expect(OmpProviderCapabilitiesV2.checkpointing.providerCanRollbackConversation).toBe(false);
  });
});

describe("OMP display normalization", () => {
  it.each(["agent_message_chunk", "agent_thought_chunk"] as const)(
    "strips terminal controls from %s while preserving markdown and metadata",
    (sessionUpdate) => {
      const notification: EffectAcpSchema.SessionNotification = {
        sessionId: "native-session",
        update: {
          sessionUpdate,
          messageId: "native-message",
          content: { type: "text", text: "\u001b[38;5;243m**Context**\u001b[39m\n\nBudget: 32k" },
        },
      };
      expect(normalizeOmpSessionUpdate(notification)).toEqual({
        ...notification,
        update: {
          ...notification.update,
          content: { type: "text", text: "**Context**\n\nBudget: 32k" },
        },
      });
    },
  );
  it.each(["agent_message", "agent_thought"] as const)(
    "normalizes %s without changing non-text content",
    (sessionUpdate) => {
      const content = [
        { type: "text" as const, text: "\u001b[1mContext\u001b[0m" },
        { type: "image" as const, data: "image-data", mimeType: "image/png" },
      ];
      expect(
        normalizeOmpSessionUpdate({
          sessionId: "native-session",
          update: { sessionUpdate, messageId: "native-message", content },
        }),
      ).toEqual({
        sessionId: "native-session",
        update: {
          sessionUpdate,
          messageId: "native-message",
          content: [{ type: "text", text: "Context" }, content[1]],
        },
      });
    },
  );
  it("leaves replayed user text and tool payloads intact", () => {
    const notification: EffectAcpSchema.SessionNotification = {
      sessionId: "native-session",
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "\u001b[31mexample\u001b[0m" },
      },
    };
    expect(normalizeOmpSessionUpdate(notification)).toBe(notification);
  });
});

describe("OMP ACP wire integration", () => {
  it.live(
    "projects a normal turn, usage and native task results while isolating foreign updates",
    () =>
      Effect.gen(function* () {
        const harness = yield* openHarness();
        yield* harness.runtime.startTurn(yield* turnInput(harness));
        const events = yield* harness.runtime.events.pipe(
          Stream.takeUntil((e) => e.type === "turn.terminal"),
          Stream.runCollect,
        );
        expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        const serialized = encodeJson(events);
        const updates = events.flatMap((event) =>
          event.type === "provider_thread.updated" ? [event.providerThread] : [],
        );
        expect(
          updates.some(
            (thread) =>
              thread.contextUsage?.usedTokens === 420 && thread.contextUsage.maxTokens === 10000,
          ),
        ).toBe(true);
        expect(updates.some((thread) => thread.nativeMetadata?.title === "Native OMP title")).toBe(
          true,
        );
        const tasks = events.filter((event) => event.type === "subagent.updated");
        expect(tasks.length).toBeGreaterThan(0);
        expect(tasks.every((event) => event.subagent.providerThreadId === null)).toBe(true);
        expect(
          updates.every((thread) => thread.nativeThreadRef?.nativeId !== "native-agent-42"),
        ).toBe(true);
        expect(serialized).toContain("OMP response");
        expect(serialized).toContain("native-agent-42");
        expect(serialized).toContain("Found it");
        expect(serialized).not.toContain("FOREIGN");
        expect(serialized).not.toContain("unrelated-session");
        expect(harness.availableCommands.at(-1)).toEqual(["compact"]);
        const launch = harness.launches[0];
        expect(launch?.args).toEqual(["acp", "--approval-mode=yolo", "--profile", "work"]);
        expect(launch?.options.detached).toBe((yield* HostProcessPlatform) !== "win32");
        expect(
          harness.requests.filter(
            (r) => r.status === "started" && r.method === "session/set_config_option",
          ),
        ).toEqual([]);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live(
    "selects the exact native model first and gates thinking against the updated native values",
    () =>
      Effect.gen(function* () {
        const harness = yield* openHarness({
          selection: {
            instanceId,
            model: " OpenAI/CaseSensitive-v2:custom ",
            options: [
              { id: "thinking", value: "max" },
              { id: "unknown", value: "high" },
            ],
          },
        });
        const selections = harness.requests
          .filter((r) => r.status === "started" && r.method === "session/set_config_option")
          .map((r) => r.payload);
        expect(selections).toMatchObject([
          { configId: "model", value: "OpenAI/CaseSensitive-v2:custom" },
          { configId: "thinking", value: "max" },
        ]);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("keeps the native default and skips stale or boolean thinking values", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness({
        selection: {
          instanceId,
          model: "default",
          options: [
            { id: "thinking", value: "high" },
            { id: "thinking", value: true },
            { id: "model", value: "default" },
          ],
        },
      });
      expect(
        harness.requests.filter(
          (r) => r.status === "started" && r.method === "session/set_config_option",
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each(["fail", "exit"])("terminalizes provider %s without hanging", (outcome) =>
    Effect.gen(function* () {
      const harness = yield* openHarness({ environment: { OMP_TEST_PROMPT: outcome } });
      yield* harness.runtime.startTurn(yield* turnInput(harness));
      const events = yield* harness.runtime.events.pipe(
        Stream.takeUntil((e) => e.type === "turn.terminal"),
        Stream.runCollect,
      );
      expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "failed" });
      expect(encodeJson(events)).not.toContain("test-secret-value");
      if (outcome === "fail") expect(encodeJson(events)).toContain("Provider failed");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("fails visibly instead of adopting an unannounced native session relocation", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness({ environment: { OMP_TEST_PROMPT: "relocate" } });
      yield* harness.runtime.startTurn(yield* turnInput(harness));
      const events = yield* harness.runtime.events.pipe(
        Stream.takeUntil((e) => e.type === "turn.terminal"),
        Stream.runCollect,
      );
      expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "failed" });
      expect(encodeJson(events)).toContain("OMP replied under an unannounced session ID");
      expect(encodeJson(events)).not.toContain("FOREIGN");
      expect(encodeJson(events)).not.toContain("unrelated-session");
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each(["interleaved", "interleaved-messages"])(
    "retains complete native messages across stream boundaries (%s)",
    (outcome) =>
      Effect.gen(function* () {
        const harness = yield* openHarness({ environment: { OMP_TEST_PROMPT: outcome } });
        yield* harness.runtime.startTurn(yield* turnInput(harness));
        const events = yield* harness.runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const persistedItems = new Map(
          events.flatMap((event) =>
            event.type === "turn_item.updated"
              ? [[event.turnItem.id, event.turnItem] as const]
              : [],
          ),
        );
        const answers = [...persistedItems.values()].filter(
          (item) => item.type === "assistant_message",
        );
        const thoughts = [...persistedItems.values()].filter((item) => item.type === "reasoning");
        expect(answers).toHaveLength(outcome === "interleaved" ? 1 : 2);
        expect(answers[0]).toMatchObject({
          text: "Full explanation. Final sentences.",
          status: "completed",
        });
        expect(thoughts).toHaveLength(1);
        expect(thoughts[0]).toMatchObject({
          text: "Checking the conclusion. Done.",
          status: "completed",
        });
        expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        const snapshot = yield* harness.runtime.readThreadSnapshot({
          providerThread: harness.providerThread,
        });
        expect(snapshot.messages.map((message) => message.text)).toEqual(
          outcome === "interleaved"
            ? ["Inspect the repository", "Full explanation. Final sentences."]
            : ["Inspect the repository", "Full explanation. Final sentences.", "Separate message."],
        );
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("projects native compaction summary through the shared ACP timeline", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness({ environment: { OMP_TEST_PROMPT: "compact" } });
      yield* harness.runtime.startTurn(yield* turnInput(harness, "/compact"));
      const events = yield* harness.runtime.events.pipe(
        Stream.takeUntil((e) => e.type === "turn.terminal"),
        Stream.runCollect,
      );
      expect(
        events.find(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.type === "compaction" &&
            e.turnItem.status === "completed" &&
            e.turnItem.summary === "Native compaction summary",
        ),
      ).toMatchObject({
        turnItem: { type: "compaction", status: "completed", summary: "Native compaction summary" },
      });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("cancels a dispatched prompt and releases the owned runtime", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness({ environment: { OMP_TEST_PROMPT: "hang" } });
      const input = yield* turnInput(harness);
      yield* harness.runtime.startTurn(input);
      yield* Deferred.await(harness.promptSent);
      const started = yield* harness.runtime.events.pipe(
        Stream.filter((e) => e.type === "provider_turn.updated"),
        Stream.runHead,
      );
      if (started._tag !== "Some" || started.value.type !== "provider_turn.updated")
        return yield* Effect.die("Missing turn start");
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: started.value.providerTurn.id,
        requestRuntimeRestart: true,
      });
      const events = yield* harness.runtime.events.pipe(
        Stream.takeUntil((e) => e.type === "turn.terminal"),
        Stream.runCollect,
      );
      expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "interrupted" });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("reads native history after Stop restarts the owned ACP process", () =>
    Effect.gen(function* () {
      const harness = yield* openHarness({
        environment: { OMP_TEST_PROMPT: "hang", OMP_TEST_REPLAY: "1" },
      });
      yield* harness.runtime.startTurn(yield* turnInput(harness));
      yield* Deferred.await(harness.promptSent);
      const started = yield* harness.runtime.events.pipe(
        Stream.filter((event) => event.type === "provider_turn.updated"),
        Stream.runHead,
      );
      if (started._tag !== "Some" || started.value.type !== "provider_turn.updated")
        return yield* Effect.die("Missing turn start");
      yield* harness.runtime.interruptTurn({
        providerThread: harness.providerThread,
        providerTurnId: started.value.providerTurn.id,
        requestRuntimeRestart: true,
      });
      const snapshot = yield* harness.runtime.readThreadSnapshot({
        providerThread: harness.providerThread,
      });
      expect(snapshot.messages.map((message) => message.text)).toEqual([
        "Original question",
        "Original answer",
      ]);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each([true, false])(
    "gates snapshot/fork capabilities from the actual handshake (%s)",
    (enabled) =>
      Effect.gen(function* () {
        const harness = yield* openHarness({
          environment: { OMP_TEST_CAPABILITIES: enabled ? "1" : "0" },
        });
        expect(harness.runtime.providerSession.capabilities.threads.canReadThreadSnapshot).toBe(
          enabled,
        );
        expect(harness.runtime.providerSession.capabilities.threads.canForkThread).toBe(enabled);
        expect(harness.runtime.providerSession.capabilities.threads.canForkFromTurn).toBe(false);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each([
    "/fresh",
    "/fresh:",
    "/move /somewhere",
    "/move:/somewhere",
    "/wt",
    "/wt:clean",
    "/worktree",
    "/worktree:clean",
  ])("gates %s instead of adopting a foreign session or workspace", (command) =>
    Effect.gen(function* () {
      const harness = yield* openHarness();
      yield* harness.runtime.startTurn(yield* turnInput(harness, command));
      const events = yield* harness.runtime.events.pipe(
        Stream.takeUntil((e) => e.type === "turn.terminal"),
        Stream.runCollect,
      );
      expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "failed" });
      expect(encodeJson(events)).toContain("Start a new T3 thread");
      expect(harness.requests.some((r) => r.method === "session/prompt")).toBe(false);
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("opens tools-disabled unattended sessions without MCP or elicitation capabilities", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const runtime = yield* makeOmpAcpRuntime({
        cwd: process.cwd(),
        ompSettings: settings,
        childProcessSpawner: harness.options.childProcessSpawner,
        clientInfo: { name: "t3-test", version: "1" },
        disableTools: true,
        mcpServers: [{ name: "should-not-connect", command: "unused", args: [], env: [] }],
        clientCapabilities: { _meta: { elicitation: { form: {} } } },
        requestLogger: harness.options.nativeLogging().requestLogger,
      });
      yield* runtime.start();
      expect(harness.launches[0]?.args).toContain("--no-tools");
      expect(
        harness.requests.find((r) => r.method === "initialize" && r.status === "started")?.payload,
      ).toMatchObject({ clientCapabilities: {} });
      expect(
        harness.requests.find((r) => r.method === "session/new" && r.status === "started")?.payload,
      ).toMatchObject({ mcpServers: [] });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each(["load", "resume"] as const)(
    "activates saved sessions through native %s",
    (method) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const runtime = yield* makeOmpAcpRuntime({
          cwd: process.cwd(),
          ompSettings: settings,
          childProcessSpawner: harness.options.childProcessSpawner,
          environment: { OMP_TEST_CAPABILITIES: method },
          clientInfo: { name: "t3-test", version: "1" },
          resumeSessionId: "omp-session",
          resumeMethod: method,
          requestLogger: harness.options.nativeLogging().requestLogger,
        });
        const started = yield* runtime.start();
        expect(started.sessionId).toBe("omp-session");
        expect(
          harness.requests.some(
            (r) => r.method === `session/${method}` && r.status === "succeeded",
          ),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live(
    "refuses saved-session activation when the handshake advertises neither load nor resume",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ OMP_TEST_CAPABILITIES: "0" });
        const runtime = yield* makeOmpAcpRuntime({
          cwd: process.cwd(),
          ompSettings: settings,
          childProcessSpawner: harness.options.childProcessSpawner,
          environment: { OMP_TEST_CAPABILITIES: "0" },
          clientInfo: { name: "t3-test", version: "1" },
          resumeSessionId: "omp-session",
          requestLogger: harness.options.nativeLogging().requestLogger,
        });
        const failure = yield* runtime.start().pipe(Effect.flip);
        expect(failure).toMatchObject({ _tag: "AcpRequestError", code: -32601 });
        expect(
          harness.requests.some(
            (r) => r.method === "session/load" || r.method === "session/resume",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live("uses the advertised ACP fork to create a new whole-session identity", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const runtime = yield* makeOmpAcpRuntime({
        cwd: process.cwd(),
        ompSettings: settings,
        childProcessSpawner: harness.options.childProcessSpawner,
        clientInfo: { name: "t3-test", version: "1" },
        requestLogger: harness.options.nativeLogging().requestLogger,
      });
      yield* runtime.start();
      expect((yield* runtime.forkSession("omp-session")).sessionId).toBe("omp-fork");
      expect(
        harness.requests.find((r) => r.method === "session/fork" && r.status === "started")
          ?.payload,
      ).toMatchObject({ sessionId: "omp-session" });
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it.live.each([false, true])(
    "refuses unadvertised forks or arbitrary-turn forks (handshake enabled: %s)",
    (enabled) =>
      Effect.gen(function* () {
        const harness = yield* openHarness({
          environment: { OMP_TEST_CAPABILITIES: enabled ? "1" : "0" },
        });
        const failure = yield* harness.runtime
          .forkThread({
            sourceProviderThread: harness.providerThread,
            targetThreadId: ThreadId.make("omp-target"),
            ...(enabled ? { providerTurnId: ProviderTurnId.make("arbitrary-turn") } : {}),
          })
          .pipe(Effect.flip);
        expect(failure).toMatchObject({
          _tag: "ProviderAdapterForkThreadError",
          cause: { _tag: "ProviderAdapterProtocolError" },
        });
        expect(harness.requests.some((r) => r.method === "session/fork")).toBe(false);
      }).pipe(Effect.provide(testLayer), Effect.scoped),
  );

  it("forces native approval requests when a T3 policy override needs client enforcement", () => {
    expect(
      ompLaunchRuntimeMode(
        ProviderAdapterV2RuntimePolicy.make({ ...policy, approvalPolicy: "never" }),
      ),
    ).toBe("approval-required");
  });
});
