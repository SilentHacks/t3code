import type { AcpRegistrySettings } from "../settings.ts";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { sha256 } from "@noble/hashes/sha2";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

// The Devin CLI reads its quota from this Windsurf seat-management RPC with its stored login.
const GET_USER_STATUS = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const CLI_VERSION = "3000.14.30821";

/** Protobuf JSON writes int64 as a string. */
const Int64 = Schema.Union([Schema.Number, Schema.String]);
const PlanInfo = Schema.Struct({
  planName: Schema.optional(Schema.String),
  hideDailyQuota: Schema.optional(Schema.Boolean),
  hideWeeklyQuota: Schema.optional(Schema.Boolean),
});
const UserStatusResponse = Schema.Struct({
  userStatus: Schema.Struct({
    userId: Schema.optional(Schema.String),
    planStatus: Schema.optional(
      Schema.Struct({
        planInfo: Schema.optional(PlanInfo),
        dailyQuotaRemainingPercent: Schema.optional(Schema.Number),
        weeklyQuotaRemainingPercent: Schema.optional(Schema.Number),
        dailyQuotaResetAtUnix: Schema.optional(Int64),
        weeklyQuotaResetAtUnix: Schema.optional(Int64),
      }),
    ),
  }),
  planInfo: Schema.optional(PlanInfo),
});
const decodeUserStatus = Schema.decodeUnknownEffect(UserStatusResponse);

export function isDevinAgent(settings: AcpRegistrySettings, basename: (path: string) => string) {
  return settings.source === "local"
    ? /^devin(\.exe)?$/i.test(basename(settings.commandPath ?? ""))
    : settings.agentId === "devin";
}

/**
 * Where the CLI keeps its login: the Roaming AppData known folder on Windows,
 * `$XDG_DATA_HOME` or `~/.local/share` elsewhere.
 */
export function devinCredentialsPath(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  join: (...segments: ReadonlyArray<string>) => string,
) {
  if (platform === "win32") {
    // Windows env keys are case-insensitive, but a merged copy of the environment is not.
    const read = (name: string) =>
      environment[name] ??
      Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1];
    const userProfile = read("USERPROFILE");
    const appData = read("APPDATA") || (userProfile && join(userProfile, "AppData", "Roaming"));
    return appData ? join(appData, "devin", "credentials.toml") : undefined;
  }
  const home = environment.HOME;
  const dataHome = environment.XDG_DATA_HOME || (home && join(home, ".local", "share"));
  return dataHome ? join(dataHome, "devin", "credentials.toml") : undefined;
}

/** Reads the `key = "value"` pairs of the CLI's flat credentials.toml. */
export function parseDevinCredentials(text: string) {
  const values = new Map<string, string>();
  for (const match of text.matchAll(/^\s*([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/gm)) {
    try {
      values.set(match[1]!, JSON.parse(`"${match[2]}"`) as string);
    } catch {
      // A value TOML escapes differently from JSON is not one this probe needs.
    }
  }
  const apiKey = values.get("windsurf_api_key");
  const apiServerUrl = values.get("api_server_url");
  return apiKey && apiServerUrl ? { apiKey, apiServerUrl } : undefined;
}

function window(
  id: "daily" | "weekly",
  remainingPercent: number | undefined,
  resetAtUnix: number | string | undefined,
): ServerProviderUsageWindow | undefined {
  const resetSeconds = Number(resetAtUnix);
  const resets = Number.isFinite(resetSeconds) && resetSeconds > 0;
  // Protobuf JSON omits zero, so an exhausted quota arrives as only its reset time.
  if (remainingPercent === undefined && !resets) return undefined;
  const remaining = Math.max(0, Math.min(100, remainingPercent ?? 0));
  return {
    id,
    kind: id === "daily" ? "session" : "weekly",
    label: id === "daily" ? "Daily" : "Weekly",
    usedPercent: 100 - remaining,
    windowDurationMins: id === "daily" ? 24 * 60 : 7 * 24 * 60,
    ...(resets ? { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetSeconds * 1000)) } : {}),
  };
}

/** Windows from a GetUserStatus answer; Devin hides the quotas a plan does not meter. */
export const devinUsageWindows = (response: unknown) =>
  decodeUserStatus(response).pipe(
    Effect.map(({ userStatus, planInfo: topPlanInfo }) => {
      const plan = userStatus.planStatus;
      const planInfo = plan?.planInfo ?? topPlanInfo;
      const windows = [
        planInfo?.hideDailyQuota
          ? undefined
          : window("daily", plan?.dailyQuotaRemainingPercent, plan?.dailyQuotaResetAtUnix),
        planInfo?.hideWeeklyQuota
          ? undefined
          : window("weekly", plan?.weeklyQuotaRemainingPercent, plan?.weeklyQuotaResetAtUnix),
      ].filter((entry) => entry !== undefined);
      return { windows, userId: userStatus.userId };
    }),
  );

export const makeDevinUsageProbe = Effect.fn("makeDevinUsageProbe")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const credentialsPath = devinCredentialsPath(environment, yield* HostProcess.Platform, path.join);
  const client = (yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer))).pipe(
    HttpClient.filterStatusOk,
  );

  return Effect.gen(function* (): Effect.fn.Return<ServerProviderUsageLimits> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const credentials = credentialsPath
      ? yield* fs.readFileString(credentialsPath).pipe(
          Effect.map(parseDevinCredentials),
          Effect.orElseSucceed(() => undefined),
        )
      : undefined;
    if (!credentials) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message: "Sign in to the Devin CLI on this environment to see Devin limits.",
      });
    }
    const result = yield* client
      .execute(
        HttpClientRequest.post(
          `${credentials.apiServerUrl.replace(/\/+$/, "")}${GET_USER_STATUS}`,
        ).pipe(
          HttpClientRequest.setHeaders({ "Connect-Protocol-Version": "1" }),
          HttpClientRequest.bodyJsonUnsafe({
            metadata: {
              apiKey: credentials.apiKey,
              ideName: "devin-cli",
              ideVersion: CLI_VERSION,
              extensionName: "devin-cli",
              extensionVersion: CLI_VERSION,
              locale: "en",
            },
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap(devinUsageWindows),
        Effect.timeout("10 seconds"),
        Effect.option,
      );
    if (result._tag === "None" || result.value.windows.length === 0) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Devin did not return usage limits.",
      });
    }
    const { windows, userId } = result.value;
    return {
      ...makeUsageLimits({ checkedAt, windows }),
      ...(userId
        ? {
            credentialFingerprint: Hex.encode(
              sha256(new TextEncoder().encode(`devin-user\0${userId}`)),
            ).slice(0, 16),
          }
        : {}),
    };
  });
});
