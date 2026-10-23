import {
  CommandId,
  EnvironmentId,
  NodeId,
  OrchestrationV2Command,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";

const command = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => command.run) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));

import { act, render } from "../../../test/render";
import {
  changeQuestionAttachmentPreparation,
  questionAttachmentDraftId,
} from "../../questionAttachments";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { usePendingThreadRequests } from "./usePendingThreadRequests";

const encodeCommand = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2Command));

type Requests = ReturnType<typeof usePendingThreadRequests>;

function Probe({
  environmentId,
  projection,
  onState,
  onError,
}: {
  environmentId: EnvironmentId;
  projection: OrchestrationV2ThreadProjection;
  onState: (state: Requests) => void;
  onError: (threadId: ThreadId, error: string | null) => void;
}) {
  const promptRef = useRef("");
  const composerRef = useRef(null);
  const state = usePendingThreadRequests({
    environmentId,
    activeThreadId: projection.thread.id,
    activeThread: projection.thread,
    serverProjection: projection,
    supportsQuestionAttachments: true,
    composerDraftTarget: { environmentId, threadId: projection.thread.id },
    setComposerDraftPrompt: () => {},
    promptRef,
    composerRef,
    setThreadError: onError,
  });
  useLayoutEffect(() => onState(state));
  return null;
}

function setup(id: string, multiSelect = false, required = false) {
  command.run.mockReset().mockImplementation(async ({ input }) => {
    try {
      const encoded = encodeCommand({
        type: "runtime-request.respond",
        commandId: CommandId.make("answer-command"),
        ...input,
      });
      return AsyncResult.success(encoded);
    } catch (error) {
      return AsyncResult.failure(Cause.fail(error));
    }
  });
  const environmentId = EnvironmentId.make(id);
  const threadId = ThreadId.make(id);
  const requestId = RuntimeRequestId.make(id);
  const base = makeThreadProjectionFixture();
  const questions: OrchestrationV2UserInputQuestion[] = [
    {
      id: "q0",
      header: "Target",
      question: "Which target?",
      options: [
        { label: "First", value: " first\t", description: "First target" },
        { label: "Second", value: "second", description: "Second target" },
      ],
      allowCustomAnswer: false,
      multiSelect,
      required,
    },
    {
      id: "q0__other",
      header: "Other",
      question: "Other (type your own)",
      options: [],
      required: false,
    },
  ];
  const projection: OrchestrationV2ThreadProjection = {
    ...base,
    thread: { ...base.thread, id: threadId },
    runtimeRequests: [
      {
        id: requestId,
        nodeId: NodeId.make(id),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: base.updatedAt,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make(id),
        threadId,
        runId: null,
        nodeId: NodeId.make(id),
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: base.updatedAt,
        completedAt: base.updatedAt,
        updatedAt: base.updatedAt,
        type: "user_input_request",
        requestId,
        questions,
      },
    ],
  };
  let requests: Requests;
  const onError = vi.fn();
  return {
    environmentId,
    threadId,
    requestId,
    onError,
    get requests() {
      return requests;
    },
    probe: (
      <Probe
        environmentId={environmentId}
        projection={projection}
        onState={(state) => {
          requests = state;
        }}
        onError={onError}
      />
    ),
  };
}

// The hook does not navigate; exercise its submission with a real RPC JSON codec.
const options = { router: false } as const;

it.each(["", "  \t"])("submits a choice with blank Other (%j) as valid JSON", async (other) => {
  const fixture = setup(`choice-${other.length}`);
  await using _screen = await render(fixture.probe, options);
  await act(() => fixture.requests.onSelectActivePendingUserInputOption("q0", " first\t"));
  await act(() => fixture.requests.onChangeActivePendingUserInputCustomAnswer("q0__other", other));
  await act(() => fixture.requests.onAdvanceActivePendingUserInput());
  await act(() => fixture.requests.onAdvanceActivePendingUserInput());

  expect(command.run).toHaveBeenCalledOnce();
  expect(command.run.mock.calls[0]![0].input.answers).toEqual({ q0: " first\t" });
  expect(Object.hasOwn(command.run.mock.calls[0]![0].input.answers, "q0__other")).toBe(false);
  expect(fixture.onError).not.toHaveBeenCalledWith(fixture.threadId, expect.any(String));
});

it("submits only Other without adding an undefined choice", async () => {
  const fixture = setup("custom-only");
  await using _screen = await render(fixture.probe, options);
  await act(() =>
    fixture.requests.onChangeActivePendingUserInputCustomAnswer("q0__other", "Custom target"),
  );
  await act(() => fixture.requests.onAdvanceActivePendingUserInput());
  await act(() => fixture.requests.onAdvanceActivePendingUserInput());

  expect(command.run).toHaveBeenCalledOnce();
  expect(command.run.mock.calls[0]![0].input.answers).toEqual({ q0__other: "Custom target" });
  expect(Object.hasOwn(command.run.mock.calls[0]![0].input.answers, "q0")).toBe(false);
  expect(fixture.onError).not.toHaveBeenCalledWith(fixture.threadId, expect.any(String));
});

it("preserves multi-select values while omitting Other", async () => {
  const fixture = setup("multi-select", true);
  await using _screen = await render(fixture.probe, options);
  await act(() => fixture.requests.onSelectActivePendingUserInputOption("q0", " first\t"));
  await act(() => fixture.requests.onSelectActivePendingUserInputOption("q0", "second"));
  await act(() => fixture.requests.onAdvanceActivePendingUserInput());
  await act(() => fixture.requests.onAdvanceActivePendingUserInput());

  expect(command.run).toHaveBeenCalledOnce();
  expect(command.run.mock.calls[0]![0].input.answers).toEqual({ q0: [" first\t", "second"] });
  expect(fixture.onError).not.toHaveBeenCalledWith(fixture.threadId, expect.any(String));
});

it("still checks attachment preparation for an omitted answer before dispatch", async () => {
  const fixture = setup("attachment-preparation");
  await using _screen = await render(fixture.probe, options);
  await act(() => fixture.requests.onSelectActivePendingUserInputOption("q0", " first\t"));
  await act(() => fixture.requests.onAdvanceActivePendingUserInput());
  const advance = fixture.requests.onAdvanceActivePendingUserInput;
  const key = questionAttachmentDraftId(
    fixture.environmentId,
    fixture.threadId,
    fixture.requestId,
    "q0__other",
  );
  await act(() => changeQuestionAttachmentPreparation(key, 1));
  await act(() => advance());
  expect(command.run).not.toHaveBeenCalled();
  await act(() => changeQuestionAttachmentPreparation(key, -1));
  await act(() => fixture.requests.onAdvanceActivePendingUserInput());
  expect(command.run).toHaveBeenCalledOnce();
  expect(fixture.onError).not.toHaveBeenCalledWith(fixture.threadId, expect.any(String));
});

it("does not submit a missing required answer", async () => {
  const fixture = setup("required-answer", false, true);
  await using _screen = await render(fixture.probe, options);
  await act(() => fixture.requests.onAdvanceActivePendingUserInput());
  await act(() => fixture.requests.onAdvanceActivePendingUserInput());
  expect(command.run).not.toHaveBeenCalled();
});
