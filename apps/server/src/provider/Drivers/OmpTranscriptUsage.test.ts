import { describe, expect, it } from "@effect/vitest";
import { totalTokens } from "@t3tools/provider-core/server/usage";
import { ompUsageFormat } from "./OmpTranscriptUsage.ts";

const parseOmpLine = (line: string, sessionId: string) =>
  ompUsageFormat.parseLine(line, { sessionId })[0] ?? null;

describe("parseOmpLine", () => {
  const native = {
    type: "message",
    id: "8847372c",
    timestamp: "2026-08-01T10:00:00Z",
    message: {
      role: "assistant",
      provider: "Provider",
      model: "Custom-v1",
      usage: { input: 150, output: 25, cacheRead: 20, cacheWrite: 5, cost: { total: 0.03 } },
    },
  };
  it("reads disjoint native tokens, native cost and exact model identity", () => {
    const record = parseOmpLine(JSON.stringify(native), "journal");
    expect(record).toMatchObject({
      provider: "omp",
      model: "Provider/Custom-v1",
      rateModel: "Custom-v1",
      sessionId: "journal",
      timestampMs: Date.parse(native.timestamp),
      totals: {
        uncachedInputTokens: 150,
        cachedInputTokens: 20,
        cacheCreationTokens: 5,
        outputTokens: 25,
        reasoningTokens: 0,
      },
      reportedCostUsd: 0.03,
    });
    expect(totalTokens(record!.totals)).toBe(200);
  });
  it("keeps session state across header-only scans and projected streaming records", () => {
    const state = ompUsageFormat.state!.initial();
    expect(ompUsageFormat.parseLine('{"type":"session","id":"native-session"}', state)).toEqual([]);
    expect(ompUsageFormat.parseProjected(native, state)[0]?.sessionId).toBe("native-session");
  });
  it("deduplicates copied fork entries without collapsing new requests", () => {
    const original = parseOmpLine(JSON.stringify(native), "original");
    const fork = parseOmpLine(JSON.stringify(native), "fork");
    expect(fork?.dedupeKey).toBe(original?.dedupeKey);
    expect(
      parseOmpLine(JSON.stringify({ ...native, id: "next-entry" }), "fork")?.dedupeKey,
    ).not.toBe(original?.dedupeKey);
  });
  it("includes billable orchestration tokens without double-counting reasoning or context", () => {
    const record = parseOmpLine(
      JSON.stringify({
        ...native,
        message: {
          ...native.message,
          usage: {
            ...native.message.usage,
            reasoningTokens: 10,
            contextTokens: 2000,
            orchestration: { input: 5, cacheRead: 2, output: 3 },
          },
        },
      }),
      "journal",
    );
    expect(record?.totals).toEqual({
      uncachedInputTokens: 155,
      cachedInputTokens: 22,
      cacheCreationTokens: 5,
      outputTokens: 28,
      reasoningTokens: 10,
    });
    expect(totalTokens(record!.totals)).toBe(210);
  });
  it("ignores non-assistant, malformed, missing-usage and invalid-timestamp entries", () => {
    for (const record of [
      { ...native, type: "session" },
      { ...native, message: { ...native.message, role: "user" } },
      { ...native, message: { role: "assistant", model: "model" } },
      { ...native, timestamp: "invalid" },
      { ...native, message: { ...native.message, model: "" } },
    ])
      expect(parseOmpLine(JSON.stringify(record), "journal")).toBeNull();
    expect(parseOmpLine("not json", "journal")).toBeNull();
  });
  it("does not turn missing or invalid costs into free usage", () => {
    expect(
      parseOmpLine(
        JSON.stringify({
          ...native,
          message: { ...native.message, usage: { input: -1, output: "25", cost: { total: -1 } } },
        }),
        "journal",
      ),
    ).toMatchObject({ reportedCostUsd: null, totals: { uncachedInputTokens: 0, outputTokens: 0 } });
  });
});
