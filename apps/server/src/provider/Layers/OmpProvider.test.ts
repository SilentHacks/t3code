import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { OmpSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { checkOmpProviderStatus, buildInitialOmpProviderSnapshot } from "./OmpProvider.ts";

const decodeSettings = Schema.decodeEffect(OmpSettings);
const makeFixture = Effect.fnUntraced(function* (rpcFails: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-provider-" });
  const binaryPath = `${directory}/omp`;
  yield* fs.writeFileString(
    binaryPath,
    `#!${process.execPath}
(() => {
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('omp/18.6.0');return;}
if(args.includes('usage')) { console.log(JSON.stringify({reports:[]}));return; }
if(${rpcFails}) { process.stderr.write('secret startup failure');process.exit(1); }
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{for(const line of input.trim().split('\\n')){
 const req=JSON.parse(line);const model={provider:'Acme',id:'Native:V2'};
 const data=req.type==='get_state'?{model}:req.type==='get_available_models'?{models:[model]}:{commands:[{name:'skill:review'}]};
 console.log(JSON.stringify({type:'response',success:true,command:req.type,id:req.id,data}));
}});
})();
`,
  );
  yield* fs.chmod(binaryPath, 0o755);
  return {
    directory,
    settings: yield* decodeSettings({
      enabled: true,
      binaryPath,
      profile: "work",
    }),
  };
});
const windows = HostProcessPlatform.defaultValue() === "win32";
describe("OmpProvider", () => {
  it.effect("disabled defaults never invoke the CLI", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({});
      const initial = yield* buildInitialOmpProviderSnapshot(settings);
      const snapshot = yield* checkOmpProviderStatus(settings, process.env, process.cwd()).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("must not spawn")),
        ),
      );
      assert.equal(initial.status, "disabled");
      assert.equal(snapshot.status, "disabled");
      assert.equal(snapshot.supportsConversationRollback, false);
      assert.equal(snapshot.models[0]?.slug, "default");
    }),
  );

  it.live.skipIf(windows)(
    "reports a real version and native default while not inferring auth from catalog availability",
    () =>
      Effect.gen(function* () {
        const { settings, directory } = yield* makeFixture(false);
        const snapshot = yield* checkOmpProviderStatus(settings, process.env, directory);
        assert.equal(snapshot.version, "18.6.0");
        assert.equal(snapshot.status, "ready");
        assert.equal(snapshot.auth.status, "unknown");
        assert.equal(snapshot.models.find((model) => model.isDefault)?.slug, "Acme/Native:V2");
        assert.equal(snapshot.skills[0]?.name, "review");
        assert.equal(snapshot.models.filter((model) => model.isDefault).length, 1);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.skipIf(windows)(
    "keeps CLI availability honest when discovery fails and hides raw startup payloads",
    () =>
      Effect.gen(function* () {
        const { settings, directory } = yield* makeFixture(true);
        const snapshot = yield* checkOmpProviderStatus(settings, process.env, directory);
        assert.equal(snapshot.installed, true);
        assert.equal(snapshot.status, "warning");
        assert.equal(snapshot.auth.status, "unknown");
        assert.ok(!snapshot.message?.includes("secret"));
        assert.equal(snapshot.models[0]?.slug, "default");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live("does not attempt usage or RPC after a missing executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-missing-" });
      const settings = yield* decodeSettings({
        enabled: true,
        binaryPath: `${directory}/missing`,
      });
      const snapshot = yield* checkOmpProviderStatus(settings, process.env, directory);
      assert.equal(snapshot.installed, false);
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.auth.status, "unknown");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
