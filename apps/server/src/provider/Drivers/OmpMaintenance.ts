import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
} from "../providerMaintenance.ts";
import { ompProfileArgs, runOmpReadOnlyCommand } from "./OmpDiscovery.ts";

const DRIVER = ProviderDriverKind.make("omp");

/** OMP's updater delegates to its owning installer and respects its configured channel. */
export function makeOmpMaintenanceResolver(
  profile: string,
): ProviderMaintenanceCapabilitiesResolver {
  return {
    resolve: (context) =>
      Effect.gen(function* () {
        const manual = makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER,
          packageName: null,
        });
        if (!context) return manual;
        const path = yield* Path.Path;
        // Nix owns these files. A differently named wrapper cannot establish what
        // `omp update` would target, since OMP locates the active `omp` on PATH.
        if (
          context.realCommandPath.startsWith("/nix/store/") ||
          !/^omp(?:\.exe|\.cmd|\.bat)?$/i.test(path.basename(context.resolvedCommandPath))
        )
          return manual;
        const env = {
          ...context.env,
          PATH: `${path.dirname(context.resolvedCommandPath)}${context.platform === "win32" ? ";" : ":"}${context.env.PATH ?? context.env.Path ?? ""}`,
          NO_COLOR: "1",
        };
        const output = yield* runOmpReadOnlyCommand(
          { binaryPath: context.resolvedCommandPath, profile },
          env,
          ["update", "--check"],
          { timeoutMs: 10_000, maxBytes: 64 * 1024 },
        ).pipe(
          Effect.map((result) => (result.code === 0 ? `${result.stdout}\n${result.stderr}` : "")),
          Effect.orElseSucceed(() => ""),
        );
        const current = /Current version:\s*v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i.exec(output)?.[1];
        const latest =
          /New version available:\s*v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/i.exec(output)?.[1] ??
          (/Already up to date/i.test(output) ? current : undefined);
        return makeProviderMaintenanceCapabilities({
          provider: DRIVER,
          packageName: null,
          updateExecutable: context.resolvedCommandPath,
          updateArgs: [...ompProfileArgs({ profile }), "update"],
          updateLockKey: `omp:${context.realCommandPath}`,
          platform: context.platform,
          env,
          latestVersion: latest ?? null,
        });
      }),
  };
}
