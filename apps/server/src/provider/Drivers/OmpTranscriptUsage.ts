import type { OmpSettings } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";

import { resolveOmpSessionsDirectory } from "../../project/OmpSessionLayout.ts";

const OmpScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });

function parseOmpRecord(parsed: unknown, sessionId: string): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "message") return null;
  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const native = message as Record<string, unknown>;
  if (native["role"] !== "assistant") return null;
  const usage = native["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const totals = usage as Record<string, unknown>;
  const orchestration = totals["orchestration"];
  const overhead =
    typeof orchestration === "object" && orchestration !== null
      ? (orchestration as Record<string, unknown>)
      : {};
  const timestampMs = parseTimestampMs(record["timestamp"]);
  const model = native["model"];
  const provider = native["provider"];
  if (timestampMs === null || typeof model !== "string" || model.length === 0) return null;
  const modelId =
    typeof provider === "string" && provider.length > 0 ? `${provider}/${model}` : model;
  const cost = totals["cost"];
  const reported =
    typeof cost === "object" && cost !== null ? (cost as Record<string, unknown>)["total"] : null;
  const entryId = record["id"];
  return {
    provider: "omp",
    timestampMs,
    model: modelId,
    rateModel: model,
    sessionId,
    totals: {
      uncachedInputTokens: tokenCount(totals["input"]) + tokenCount(overhead["input"]),
      cachedInputTokens: tokenCount(totals["cacheRead"]) + tokenCount(overhead["cacheRead"]),
      cacheCreationTokens: tokenCount(totals["cacheWrite"]),
      outputTokens: tokenCount(totals["output"]) + tokenCount(overhead["output"]),
      reasoningTokens: Math.min(
        tokenCount(totals["reasoningTokens"]),
        tokenCount(totals["output"]),
      ),
    },
    reportedCostUsd:
      typeof reported === "number" && Number.isFinite(reported) && reported >= 0 ? reported : null,
    speed: "standard",
    // Native forks copy journal entries; copied usage is not a new model request.
    dedupeKey:
      typeof entryId === "string" && entryId.length > 0
        ? `omp:${modelId}:${timestampMs}:${entryId}`
        : null,
  };
}

function parseRecord(parsed: unknown, state: typeof OmpScanState.Type): readonly UsageRecord[] {
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    parsed.type === "session"
  ) {
    if ("id" in parsed && typeof parsed.id === "string") state.sessionId = parsed.id;
    return [];
  }
  const record = parseOmpRecord(parsed, state.sessionId);
  return record === null ? [] : [record];
}

export const ompUsageFormat: TranscriptUsageFormat<typeof OmpScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    message: { role: true, model: true, provider: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), schema: OmpScanState },
};

export const ompUsageReader: ProviderUsageReader<OmpSettings, FileSystem.FileSystem | Path.Path> = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  directories: Effect.fn("ompUsageReader.directories")(function* ({ config, environment }) {
    if (config === undefined) return [];
    const path = yield* Path.Path;
    const directory = yield* resolveOmpSessionsDirectory({
      settings: config,
      environment,
      platform: yield* HostProcess.Platform,
      homeDirectory: yield* HostProcess.HomeDirectory,
    });
    return directory === null ? [] : [{ dir: path.resolve(directory) }];
  }),
};
