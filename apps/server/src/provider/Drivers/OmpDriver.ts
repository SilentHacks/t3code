import { OmpSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  OmpAdapterV2Driver,
  type OmpAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/OmpAdapterV2.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  enrichOmpSnapshot,
  ompModelsFromSettings,
} from "../OmpProvider.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import {
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeOmpDiscoveryCache } from "./OmpDiscovery.ts";
import { makeOmpMaintenanceResolver } from "./OmpMaintenance.ts";

const DRIVER = ProviderDriverKind.make("omp");
const decodeSettings = Schema.decodeSync(OmpSettings);

export type OmpDriverEnv =
  | OmpAdapterV2DriverEnv
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderLatestVersions.ProviderLatestVersions;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Oh My Pi", supportsMultipleInstances: true },
  configSchema: OmpSettings,
  defaultConfig: () => decodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const { instanceId, displayName, accentColor, enabled, config, environment } = input;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const {
        paths: { cwd },
      } = yield* ProviderHost.ProviderHost;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const settings = { ...config, enabled };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const cache = yield* makeOmpDiscoveryCache(settings, processEnv);
      const visited = new Set<string>();
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        enabled
          ? resolveProviderMaintenanceCapabilitiesEffect(
              makeOmpMaintenanceResolver(settings.profile),
              {
                binaryPath: settings.binaryPath,
                env: processEnv,
              },
            ).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            )
          : Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: DRIVER,
                packageName: null,
              }),
            ),
      );
      const orchestrationAdapter = yield* OmpAdapterV2Driver.create(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Failed to build Oh My Pi orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeOmpTextGeneration(settings, processEnv);
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(settings);
      const checkProvider = Effect.gen(function* () {
        const machine = yield* checkOmpProviderStatus(settings, processEnv, cwd, cache.get).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        if (machine.enabled && machine.installed && machine.status !== "error") {
          // Each visited workspace owns its model overlays, skills and commands.
          // Failures retain the last catalog with its old age, never an empty hit.
          yield* Effect.forEach(
            [...visited],
            (workspace) => cache.get(workspace).pipe(Effect.ignore),
            { concurrency: 2 },
          );
        }
        return stamp({ ...machine, workspaceSnapshots: cache.workspaceSnapshots() });
      });
      const managed = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (current) =>
          buildInitialOmpProviderSnapshot(current.provider).pipe(Effect.map(stamp)),
        checkProvider,
        enrichSnapshot: ({ settings: current, snapshot, publishSnapshot }) =>
          !snapshot.enabled || !snapshot.installed || !current.enableProviderUpdateChecks
            ? Effect.void
            : resolveMaintenance().pipe(
                Effect.flatMap((maintenanceCapabilities) =>
                  enrichOmpSnapshot({
                    snapshot,
                    maintenanceCapabilities,
                    publishSnapshot,
                    httpClient,
                    enableProviderUpdateChecks: current.enableProviderUpdateChecks,
                  }).pipe(
                    Effect.provideService(
                      ProviderLatestVersions.ProviderLatestVersions,
                      latestVersions,
                    ),
                  ),
                ),
              ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Failed to build Oh My Pi snapshot.",
              cause,
            }),
        ),
      );
      const snapshot = {
        ...managed,
        getSnapshot: managed.getSnapshot.pipe(
          Effect.map((machine) => ({ ...machine, workspaceSnapshots: cache.workspaceSnapshots() })),
        ),
        streamChanges: managed.streamChanges.pipe(
          Stream.map((machine) => ({ ...machine, workspaceSnapshots: cache.workspaceSnapshots() })),
        ),
      };
      const snapshotForCwd = Effect.fn("OmpDriver.snapshotForCwd")(function* (workspace: string) {
        let machine = yield* snapshot.getSnapshot;
        if (!enabled) return machine;
        if (machine.version === null && machine.status !== "error") {
          const refreshed = yield* snapshot.refresh;
          machine = { ...refreshed, workspaceSnapshots: cache.workspaceSnapshots() };
        }
        if (!machine.installed || machine.status === "error") return machine;
        visited.add(workspace);
        if (visited.size > 32) {
          const oldest = visited.values().next().value;
          if (oldest !== undefined) visited.delete(oldest);
        }
        const discovered = yield* cache.get(workspace).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: "Failed to discover Oh My Pi workspace catalog.",
                cause,
              }),
          ),
        );
        return {
          ...machine,
          models: ompModelsFromSettings(settings, discovered.models),
          slashCommands: discovered.slashCommands,
          skills: discovered.skills,
          workspaceSnapshots: cache.workspaceSnapshots(),
        };
      });
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        orchestrationAdapter,
        textGeneration,
        invalidateCaches: cache.invalidate,
        refreshModels: () =>
          cache.invalidate.pipe(
            Effect.andThen(managed.refresh),
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER,
                  instanceId,
                  detail: "Failed to refresh Oh My Pi catalog.",
                  cause,
                }),
            ),
          ),
      } satisfies ProviderInstance;
    }),
};
