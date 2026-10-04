import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { makeOmpMaintenanceResolver } from "./OmpMaintenance.ts";

const windows = HostProcessPlatform.defaultValue() === "win32";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
describe("OmpMaintenance", () => {
  it.live.skipIf(windows)(
    "targets the resolved install/profile/environment and parses the actual updater's channel",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-maintenance-" });
        const executable = `${directory}/omp`;
        yield* fs.writeFileString(
          executable,
          `#!${process.execPath}
if(process.argv.slice(2).join(' ')!=='--profile=work update --check') process.exit(9);
if(!process.env.PATH.startsWith(${encodeJson(directory)})) process.exit(8);
console.log('Current version: 18.5.0');console.log('New version available: 18.6.0');
`,
        );
        yield* fs.chmod(executable, 0o755);
        const capabilities = yield* makeOmpMaintenanceResolver("work").resolve({
          binaryPath: executable,
          resolvedCommandPath: executable,
          realCommandPath: executable,
          env: { ...process.env, OMP_HOME: `${directory}/home` },
          platform: HostProcessPlatform.defaultValue(),
        });
        assert.equal(capabilities.latestVersion, "18.6.0");
        assert.equal(capabilities.update?.executable, executable);
        assert.deepEqual(capabilities.update?.args, ["--profile=work", "update"]);
        assert.equal(capabilities.update?.env?.OMP_HOME, `${directory}/home`);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("is manual-only for missing installs, Nix, or ambiguously named wrappers", () =>
    Effect.gen(function* () {
      const resolver = makeOmpMaintenanceResolver("");
      assert.equal((yield* resolver.resolve(null)).update, null);
      for (const binary of ["/nix/store/hash/bin/omp", "/custom/wrapper"]) {
        assert.equal(
          (yield* resolver.resolve({
            binaryPath: binary,
            resolvedCommandPath: binary,
            realCommandPath: binary,
            env: {},
            platform: "linux",
          })).update,
          null,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(windows)(
    "does not call an update current merely because it printed Current version",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-update-unknown-" });
        const executable = `${directory}/omp`;
        yield* fs.writeFileString(
          executable,
          `#!${process.execPath}\nconsole.log('Current version: 18.6.0');\n`,
        );
        yield* fs.chmod(executable, 0o755);
        const capabilities = yield* makeOmpMaintenanceResolver("").resolve({
          binaryPath: executable,
          resolvedCommandPath: executable,
          realCommandPath: executable,
          env: process.env,
          platform: HostProcessPlatform.defaultValue(),
        });
        assert.equal(capabilities.latestVersion, null);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
