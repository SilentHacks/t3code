import {
  ProviderDriverKind,
  type OmpSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";

import {
  discoverOmpCatalog,
  runOmpReadOnlyCommand,
  type OmpDiscovery,
  type OmpDiscoveryError,
} from "./Drivers/OmpDiscovery.ts";
import { probeOmpUsage } from "./Drivers/OmpUsage.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  type ProviderProbeResult,
} from "./providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";

const DRIVER = ProviderDriverKind.make("omp");
const NO_MODELS_MESSAGE =
  "Oh My Pi reports no available models. Run omp on the server as the service user, with this instance's profile, to configure an upstream account or API key.";
const DISCOVERY_FALLBACK = "The live ACP session will negotiate its own capabilities.";

function discoveryFailureMessage(error: OmpDiscoveryError): string {
  if (error.reason === "no-models") return NO_MODELS_MESSAGE;
  if (error.reason === "catalog-too-large")
    return `Oh My Pi's model/command catalog exceeded a transport or safety limit. Update OMP or reduce this profile's custom model/command catalog, then refresh. ${DISCOVERY_FALLBACK}`;
  if (error.reason === "rpc-command-failed")
    return `Oh My Pi rejected a model/command discovery request. Check this profile in omp on the server and update OMP if necessary. ${DISCOVERY_FALLBACK}`;
  switch (error.stage) {
    case "timeout":
      return `Oh My Pi model/command discovery timed out. Check the server's network and this profile's startup/extensions, then refresh. ${DISCOVERY_FALLBACK}`;
    case "exit":
      return `Oh My Pi exited before model/command discovery completed. Run omp on the server as the service user, with this instance's profile, to check its configuration. ${DISCOVERY_FALLBACK}`;
    case "spawn":
      return `Oh My Pi could not start its model/command probe. Check the executable, server environment and workspace permissions. ${DISCOVERY_FALLBACK}`;
    case "decode":
      return `Oh My Pi model/command discovery failed: the RPC catalog was invalid or incomplete. Update OMP and refresh the provider. ${DISCOVERY_FALLBACK}`;
  }
}

const PRESENTATION = {
  displayName: "Oh My Pi",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
  requiresNewThreadForModelChange: false,
  supportsConversationRollback: false,
} as const;
const EMPTY_CAPABILITIES = { optionDescriptors: [] };

/** `default` is a T3 sentinel, never a native model/config-option value. */
export function ompModelsFromSettings(
  settings: OmpSettings,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [
      {
        slug: "default",
        name: "Oh My Pi default",
        isCustom: false,
        ...(discovered.some((model) => model.isDefault) ? {} : { isDefault: true }),
        capabilities: EMPTY_CAPABILITIES,
      },
      ...discovered,
    ],
    settings.customModels,
    EMPTY_CAPABILITIES,
  );
}

function buildSnapshot(
  settings: OmpSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  catalog?: OmpDiscovery,
) {
  return {
    ...buildServerProvider({
      driver: DRIVER,
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: ompModelsFromSettings(settings, catalog?.models),
      slashCommands: catalog?.slashCommands ?? [],
      skills: catalog?.skills ?? [],
      probe,
    }),
    setup: {
      canInstall: false,
      canAuthenticate: false,
      documentationUrl: "https://github.com/can1357/oh-my-pi#installation",
    },
  };
}

export const buildInitialOmpProviderSnapshot = Effect.fnUntraced(function* (settings: OmpSettings) {
  return buildSnapshot(settings, DateTime.formatIso(yield* DateTime.now), {
    installed: settings.enabled,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Checking Oh My Pi CLI availability..."
      : "Oh My Pi is disabled in T3 Code settings.",
  });
});

/** Machine health and account state; catalogs are explicitly scoped to the supplied cwd. */
export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  discover: (
    cwd: string,
  ) => Effect.Effect<OmpDiscovery, OmpDiscoveryError> | ReturnType<typeof discoverOmpCatalog> = (
    workspace,
  ) => discoverOmpCatalog(settings, environment, workspace),
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled)
    return buildSnapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Oh My Pi is disabled in T3 Code settings.",
    });
  const versionResult = yield* runOmpReadOnlyCommand(settings, environment, ["--version"], {
    cwd,
    timeoutMs: 4_000,
    maxBytes: 16 * 1024,
  }).pipe(Effect.result);
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure.cause);
    return buildSnapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Oh My Pi CLI is not installed or not on PATH. Install using the official instructions at https://github.com/can1357/oh-my-pi#installation."
        : "Oh My Pi CLI availability check failed or timed out.",
    });
  }
  const version = parseGenericCliVersion(
    `${versionResult.success.stdout}\n${versionResult.success.stderr}`,
  );
  if (versionResult.success.code !== 0 || version === null)
    return buildSnapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Oh My Pi CLI did not return a valid version. Check the configured executable.",
    });
  const [discovery, usage] = yield* Effect.all(
    [discover(cwd).pipe(Effect.result), probeOmpUsage(settings, checkedAt, environment, cwd)],
    { concurrency: "unbounded" },
  );
  const catalog = Result.isSuccess(discovery) ? discovery.success : undefined;
  return buildSnapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version,
      status: catalog && catalog.models.length > 0 ? "ready" : "warning",
      auth: usage.auth,
      usageLimits: usage.usageLimits,
      ...(catalog && catalog.models.length > 0
        ? {}
        : {
            message: Result.isFailure(discovery)
              ? discoveryFailureMessage(discovery.failure)
              : NO_MODELS_MESSAGE,
          }),
    },
    catalog,
  );
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
  readonly enableProviderUpdateChecks: boolean;
}) =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
  );
