import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { OmpDriver } from "./OmpDriver.ts";

const layerDeps = ServerConfig.layerTest(process.cwd(), { prefix: "t3-omp-driver-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("OMP native discovery must not make server HTTP requests")),
    ),
  ),
);
const testLayer = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(layerDeps),
);
const noSpawner = ChildProcessSpawner.make(() => Effect.die("Disabled OMP must not spawn"));

it.layer(testLayer)("OmpDriver", (it) => {
  it.effect(
    "is disabled by default and keeps snapshots, refreshes, and maintenance side-effect free",
    () =>
      Effect.gen(function* () {
        expect(OmpDriver.defaultConfig().enabled).toBe(false);
        const instance = yield* OmpDriver.create({
          instanceId: ProviderInstanceId.make("disabled-omp"),
          displayName: "Disabled OMP",
          enabled: false,
          environment: [],
          config: OmpDriver.defaultConfig(),
        });
        expect((yield* instance.snapshot.refresh).status).toBe("disabled");
        if (!instance.refreshModels || !instance.snapshotForCwd)
          return yield* Effect.die("OMP must expose explicit refresh and workspace snapshots");
        yield* instance.refreshModels();
        expect((yield* instance.snapshotForCwd("/missing-project")).status).toBe("disabled");
        expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
        expect(instance.continuationIdentity?.continuationKey).toContain("disabled-omp");
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
        Effect.scoped,
      ),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
    "isolates profiles/environments and retains rich catalogs for all visited workspaces",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-instances-" });
        const binaryPath = `${directory}/omp`;
        yield* fs.makeDirectory(`${directory}/one`);
        yield* fs.makeDirectory(`${directory}/two`);
        yield* fs.writeFileString(
          binaryPath,
          `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('omp/18.6.0');process.exit(0);}
if(args.includes('usage')) {console.log(JSON.stringify({reports:[]}));process.exit(0);}
if(args.includes('update')) {console.log('Current version: 18.6.0');console.log('Already up to date');process.exit(0);}
const model={provider:process.env.UPSTREAM,id:args.find(arg=>arg.startsWith('--profile=')),name:process.env.UPSTREAM};
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{for(const line of input.trim().split('\\n')){
const req=JSON.parse(line);const data=req.type==='get_state'?{model}:req.type==='get_available_models'?{models:[model]}:{commands:[{name:'skill:'+require('node:path').basename(process.cwd())},{name:'compact',input:{hint:process.env.UPSTREAM}}]};
console.log(JSON.stringify({type:'response',success:true,id:req.id,command:req.type,data}));
}});
`,
        );
        yield* fs.chmod(binaryPath, 0o755);
        const make = (profile: string, upstream: string) =>
          OmpDriver.create({
            instanceId: ProviderInstanceId.make(`omp-${profile}`),
            displayName: profile,
            accentColor: "#123456",
            enabled: true,
            environment: [{ name: "UPSTREAM", value: upstream, sensitive: false }],
            config: { ...OmpDriver.defaultConfig(), enabled: true, binaryPath, profile },
          });
        const work = yield* make("work", "WorkCorp");
        const personal = yield* make("personal", "PersonalCorp");
        const workMachine = yield* work.snapshot.refresh;
        const personalMachine = yield* personal.snapshot.refresh;
        expect(workMachine.instanceId).toBe("omp-work");
        expect(workMachine.models.some((model) => model.slug === "WorkCorp/--profile=work")).toBe(
          true,
        );
        expect(
          personalMachine.models.some((model) => model.slug === "PersonalCorp/--profile=personal"),
        ).toBe(true);
        expect(personalMachine.models.some((model) => model.slug.startsWith("WorkCorp/"))).toBe(
          false,
        );
        if (!work.snapshotForCwd) return yield* Effect.die("OMP must expose workspace snapshots");
        const first = yield* work.snapshotForCwd(`${directory}/one`);
        const second = yield* work.snapshotForCwd(`${directory}/two`);
        expect(first?.skills[0]?.name).toBe("one");
        expect(second?.skills[0]?.name).toBe("two");
        expect(
          second?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === `${directory}/one`),
        ).toBe(true);
        expect(
          second?.workspaceSnapshots?.some((snapshot) => snapshot.cwd === `${directory}/two`),
        ).toBe(true);
        const maintenance = yield* work.snapshot.resolveMaintenance();
        expect(maintenance.update?.args).toEqual(["--profile=work", "update"]);
        expect(maintenance.update?.env?.UPSTREAM).toBe("WorkCorp");
      }).pipe(Effect.scoped),
  );
});
