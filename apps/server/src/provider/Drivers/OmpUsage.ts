import type {
  OmpSettings,
  ServerProviderAuth,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { sha256 } from "@noble/hashes/sha2";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { makeUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import { runOmpReadOnlyCommand } from "./OmpDiscovery.ts";

const Timestamp = Schema.Union([Schema.Number, Schema.String]);
const Payload = Schema.Struct({ reports: Schema.Array(Schema.Unknown) });
const Report = Schema.Struct({
  provider: Schema.String,
  limits: Schema.Array(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
  metadata: Schema.optional(
    Schema.Struct({
      accountId: Schema.optional(Schema.String),
      email: Schema.optional(Schema.String),
    }),
  ),
});
const Limit = Schema.Struct({
  id: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.Struct({ windowId: Schema.optional(Schema.String) })),
  window: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      label: Schema.optional(Schema.String),
      durationMs: Schema.optional(Schema.Number),
      resetsAt: Schema.optional(Timestamp),
    }),
  ),
  amount: Schema.optional(
    Schema.Struct({
      usedFraction: Schema.optional(Schema.Number),
      remainingFraction: Schema.optional(Schema.Number),
      used: Schema.optional(Schema.Number),
      remaining: Schema.optional(Schema.Number),
      limit: Schema.optional(Schema.Number),
    }),
  ),
});

const decodePayload = Schema.decodeOption(Schema.fromJsonString(Payload));
const decodeReport = Schema.decodeUnknownOption(Report);
const decodeLimit = Schema.decodeUnknownOption(Limit);

export interface OmpUsageProbeResult {
  readonly auth: ServerProviderAuth;
  readonly usageLimits: ServerProviderUsageLimits;
}

function unavailable(
  checkedAt: string,
  reason: "probeFailed" | "unsupported",
): OmpUsageProbeResult {
  return {
    auth: { status: "unknown" },
    usageLimits: { checkedAt, windows: [], unavailable: { reason } },
  };
}

function timestamp(value: number | string | undefined): number | undefined {
  const parsed = typeof value === "number" ? value : value === undefined ? NaN : Date.parse(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 8.64e15 ? parsed : undefined;
}

/** Reports prove a usage credential worked; stored accounts and ACP authenticate do not. */
function parseUsage(stdout: string, checkedAt: string): OmpUsageProbeResult {
  const payload = decodePayload(stdout);
  if (Option.isNone(payload)) return unavailable(checkedAt, "probeFailed");
  const reports = payload.value.reports.flatMap((raw) => {
    const decoded = decodeReport(raw);
    return Option.isSome(decoded) &&
      decoded.value.provider.trim() &&
      decoded.value.error === undefined
      ? [decoded.value]
      : [];
  });
  const providers = [...new Set(reports.map((report) => report.provider.trim()))];
  const windows = new Map<string, ServerProviderUsageWindow>();
  for (const [index, report] of reports.entries()) {
    const provider = report.provider.trim();
    const identity = report.metadata?.accountId?.trim() || report.metadata?.email?.trim();
    const account = identity
      ? Hex.encode(sha256(new TextEncoder().encode(identity))).slice(0, 16)
      : String(index);
    for (const raw of report.limits) {
      const decoded = decodeLimit(raw);
      if (Option.isNone(decoded)) continue;
      const limit = decoded.value;
      const nativeId =
        limit.id?.trim() || limit.window?.id?.trim() || limit.scope?.windowId?.trim();
      const amount = limit.amount;
      const fraction =
        amount?.usedFraction ??
        (amount?.remainingFraction === undefined ? undefined : 1 - amount.remainingFraction) ??
        (amount?.limit !== undefined && amount.limit > 0
          ? (amount.used ??
              (amount.remaining === undefined ? NaN : amount.limit - amount.remaining)) /
            amount.limit
          : undefined);
      if (!nativeId || fraction === undefined || !Number.isFinite(fraction)) continue;
      const resetsAt = timestamp(limit.window?.resetsAt);
      if (resetsAt !== undefined && resetsAt <= Date.parse(checkedAt)) continue;
      const duration = limit.window?.durationMs;
      const mins =
        duration !== undefined && Number.isFinite(duration) && duration > 0
          ? Math.round(duration / 60_000)
          : undefined;
      const windowId = limit.window?.id ?? limit.scope?.windowId ?? nativeId;
      const kind =
        mins !== undefined
          ? mins >= 30 * 24 * 60
            ? "monthly"
            : mins >= 7 * 24 * 60
              ? "weekly"
              : "session"
          : /month|30d/i.test(windowId)
            ? "monthly"
            : /week|7d/i.test(windowId)
              ? "weekly"
              : /hour|session|\dh/i.test(windowId)
                ? "session"
                : "other";
      const label = limit.label?.trim() || limit.window?.label?.trim() || nativeId;
      const id = `${provider}:${account}:${nativeId}:${windowId}`;
      windows.set(id, {
        id,
        kind,
        label: reports.length > 1 ? `${provider} (${index + 1}) · ${label}` : label,
        usedPercent: Math.max(0, Math.min(100, fraction * 100)),
        ...(resetsAt === undefined
          ? {}
          : { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAt)) }),
        ...(mins === undefined ? {} : { windowDurationMins: mins }),
      });
    }
  }
  const email = reports.map((report) => report.metadata?.email?.trim()).find(Boolean);
  return {
    auth:
      providers.length > 0
        ? {
            status: "authenticated",
            type: "agent",
            label: providers.join(", "),
            ...(email ? { email } : {}),
          }
        : { status: "unknown" },
    usageLimits:
      windows.size > 0
        ? makeUsageLimits({ checkedAt, windows: [...windows.values()] })
        : {
            checkedAt,
            windows: [],
            unavailable: { reason: "unsupported" },
          },
  };
}

/** Read only usage --json, bounded to ten seconds; never print remote payloads. */
export const probeOmpUsage = Effect.fn("probeOmpUsage")(function* (
  settings: OmpSettings,
  checkedAt: string,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) {
  if (!settings.enabled) return unavailable(checkedAt, "unsupported");
  return yield* runOmpReadOnlyCommand(settings, environment, ["usage", "--json"], {
    ...(cwd === undefined ? {} : { cwd }),
    timeoutMs: 10_000,
    maxBytes: 1024 * 1024,
  }).pipe(
    Effect.map((result) =>
      result.code === 0
        ? parseUsage(result.stdout, checkedAt)
        : unavailable(checkedAt, "probeFailed"),
    ),
    Effect.orElseSucceed(() => unavailable(checkedAt, "probeFailed")),
  );
});
