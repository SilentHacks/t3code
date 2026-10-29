import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  buildPendingUserInputAnswers,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/state/pending-user-input";
import { formatInlineContextReference } from "./lib/composerContextReferences";
import { threadContextReference } from "./lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";

import {
  carryDisplacedCustomAnswerIntoPrompt,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  projectPendingUserInputAnswer,
  threadContextsReferencedByAnswer,
} from "./pendingUserInput";

describe("projectPendingUserInputAnswer", () => {
  const record = threadContextRecord(
    {
      environmentId: EnvironmentId.make("env-answer"),
      threadId: ThreadId.make("reference-thread"),
    },
    "Reference work",
  );

  it("sends thread chips as readable links with the actual thread ID", () => {
    const answer = `Compare ${formatInlineContextReference(threadContextReference(record))}`;
    expect(projectPendingUserInputAnswer(answer, [record])).toBe(
      "Compare [Reference work](t3-thread://v2/env-answer/reference-thread)",
    );
  });

  // regression: #18789 answers to pending questions lost exact text and option values
  it("preserves option values and exact answer text", () => {
    const options = [" first\t", "second"];
    expect(projectPendingUserInputAnswer(options, [record])).toBe(options);
    expect(projectPendingUserInputAnswer("  Edited answer\n", [record])).toBe("  Edited answer\n");
  });
});

describe("threadContextsReferencedByAnswer", () => {
  const kept = threadContextRecord(
    { environmentId: EnvironmentId.make("env-answer"), threadId: ThreadId.make("kept-thread") },
    "Kept work",
  );
  const deleted = threadContextRecord(
    { environmentId: EnvironmentId.make("env-answer"), threadId: ThreadId.make("deleted-thread") },
    "Deleted work",
  );

  it("preserves remaining chips without restoring deleted thread records", () => {
    const answer = `Compare ${formatInlineContextReference(threadContextReference(kept))}`;
    expect(threadContextsReferencedByAnswer(answer, [deleted, kept])).toEqual([kept]);
  });
});

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
    },
  ],
  multiSelect: false,
} as const;

const nativeChoiceQuestion = {
  id: "result",
  header: "Result",
  question: "Which result should be used?",
  options: [
    { value: " first\t", label: "Result", description: "First result" },
    { value: "second", label: "Result", description: "Second result" },
  ],
  allowCustomAnswer: false,
  multiSelect: false,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("preserves exact editor text, including a deliberately cleared answer", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(resolvePendingUserInputAnswer(question, { customAnswer: question.initialAnswer })).toBe(
      question.initialAnswer,
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "  Edited message\n\n" })).toBe(
      "  Edited message\n\n",
    );
    expect(resolvePendingUserInputAnswer(question, { customAnswer: "" })).toBe("");
    expect(resolvePendingUserInputAnswer(question, { customAnswer: " \n" })).toBe(" \n");
    expect(
      setPendingUserInputCustomAnswer(
        question,
        { selectedOptionValues: ["Orchestration-first"] },
        "",
      ),
    ).toEqual({ customAnswer: "" });
    const drafts = { scope: { customAnswer: "" } };
    expect(derivePendingUserInputProgress([question], drafts, 0)).toMatchObject({
      customAnswer: "",
      resolvedAnswer: "",
      canAdvance: true,
      isComplete: true,
    });
  });

  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionValues: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("does not replace a required choice with a custom answer", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["second"],
        customAnswer: "Use another result",
      }),
    ).toBe("second");
  });

  it("does not submit labels or unknown values when an option has a value", () => {
    expect(
      resolvePendingUserInputAnswer(nativeChoiceQuestion, {
        selectedOptionValues: ["Result", "unknown"],
      }),
    ).toBeNull();
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("selects and removes options with the same label independently", () => {
    const question = { ...nativeChoiceQuestion, multiSelect: true };
    const firstSelected = togglePendingUserInputOptionSelection(question, undefined, " first\t");
    const bothSelected = togglePendingUserInputOptionSelection(question, firstSelected, "second");

    expect(buildPendingUserInputAnswers([question], { result: bothSelected })).toEqual({
      result: [" first\t", "second"],
    });

    const secondSelected = togglePendingUserInputOptionSelection(
      question,
      bothSelected,
      " first\t",
    );
    expect(buildPendingUserInputAnswers([question], { result: secondSelected })).toEqual({
      result: ["second"],
    });
  });
});

describe("optional ACP questions", () => {
  const optionalOther = {
    id: "q0__other",
    header: "Other",
    question: "Other",
    options: [],
    required: false,
  } as const;
  const optionalMulti = {
    id: "areas",
    header: "Areas",
    question: "Which areas should this change cover?",
    options: [
      { label: "Server", description: "Server" },
      { label: "Web", description: "Web" },
    ],
    multiSelect: true,
    required: false,
    allowCustomAnswer: false,
  } as const;

  it("omits blank optional text and multi-select answers without weakening legacy requirements", () => {
    const questions = [singleSelectQuestion, optionalOther, optionalMulti];
    expect(buildPendingUserInputAnswers(questions, {})).toBeNull();
    const drafts = {
      scope: { selectedOptionValues: ["Orchestration-first"] },
      q0__other: { customAnswer: "   " },
    };
    expect(buildPendingUserInputAnswers(questions, drafts)).toEqual({
      scope: "Orchestration-first",
    });
    expect(derivePendingUserInputProgress(questions, drafts, 1)).toMatchObject({
      resolvedAnswer: null,
      canAdvance: true,
      isComplete: true,
    });
    expect(derivePendingUserInputProgress(questions, drafts, 2)).toMatchObject({
      canAdvance: true,
      isComplete: true,
    });
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex([optionalOther, singleSelectQuestion], {}),
    ).toBe(1);
  });

  it("still includes answered optional questions and the exact native multi-select values", () => {
    expect(
      buildPendingUserInputAnswers([optionalOther, optionalMulti], {
        q0__other: { customAnswer: "Custom answer" },
        areas: { selectedOptionValues: ["Server", "Web"] },
      }),
    ).toEqual({ q0__other: "Custom answer", areas: ["Server", "Web"] });
    const draft = togglePendingUserInputOptionSelection(optionalMulti, undefined, "Server");
    const cleared = togglePendingUserInputOptionSelection(optionalMulti, draft, "Server");
    expect(buildPendingUserInputAnswers([optionalMulti], { areas: cleared })).toEqual({});
  });

  it("does not silently skip an optional answer with blocked attachments", () => {
    const drafts = { q0__other: { attachmentsBlocked: true, attachmentCount: 1 } };
    expect(buildPendingUserInputAnswers([optionalOther], drafts)).toBeNull();
    expect(derivePendingUserInputProgress([optionalOther], drafts, 0)).toMatchObject({
      canAdvance: false,
      isComplete: false,
      answeredQuestionCount: 0,
    });
  });

  it("treats a provider's empty option value as an answer during navigation", () => {
    const question = {
      ...nativeChoiceQuestion,
      options: [{ value: "", label: "Empty", description: "Explicit empty answer" }],
    };
    const drafts = { result: { selectedOptionValues: [""] } };
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex([question, singleSelectQuestion], drafts),
    ).toBe(1);
  });
});

describe("pending user input question progress", () => {
  const questions = [
    singleSelectQuestion,
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
      multiSelect: false,
    },
  ] as const;

  it("counts a deliberately cleared answer as answered", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    const drafts = { scope: { customAnswer: "" } };
    expect(derivePendingUserInputProgress([question], drafts, 0)).toMatchObject({
      customAnswer: "",
      resolvedAnswer: "",
      canAdvance: true,
      isComplete: true,
    });
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionValues: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionValues: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });
});

describe("carryDisplacedCustomAnswerIntoPrompt", () => {
  // regression: #12577 clicking a question option discarded typed text
  it("keeps the thread draft when nothing was typed into the answer", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", undefined)).toBe("draft");
    expect(carryDisplacedCustomAnswerIntoPrompt("draft", "   ")).toBe("draft");
  });

  // regression: #12577 clicking a question option discarded typed text
  it("moves the typed answer into an empty thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("", "also rename the flag ")).toBe(
      "also rename the flag",
    );
  });

  it("appends the typed answer after an existing thread draft", () => {
    expect(carryDisplacedCustomAnswerIntoPrompt("first half\n", "second half")).toBe(
      "first half\n\nsecond half",
    );
  });
});
