import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { OmpSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  discoverOmpCatalog,
  makeOmpDiscoveryCache,
  runOmpReadOnlyCommand,
} from "./OmpDiscovery.ts";

const decodeSettings = Schema.decodeEffect(OmpSettings);
const fixture = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('--no-tools') || !args.includes('--no-session') || !args.includes('--no-ui') || !args.includes('--approval-mode=always-ask')) process.exit(9);
if (process.env.MARKER) fs.appendFileSync(process.env.MARKER, 'probe\\n');
const profile = args.find(arg => arg.startsWith('--profile='));
const model = {provider:'Acme', id: profile || 'Native/V2:Preview', name:'Native model', reasoning:true, thinking:{efforts:['low','Future-Level'], defaultLevel:'low'}, contextWindow:1000000, maxTokens:16384, input:['text','image']};
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 for (const line of input.trim().split('\\n')) {
  const request = JSON.parse(line);
  if (request.type === 'negotiate_protocol') {
   process.stdout.write(JSON.stringify({type:'response',id:request.id,command:request.type,success:!process.env.LEGACY_RPC,data:{protocolVersion:2}})+'\\n');
   continue;
  }
  if (!['get_state','get_available_models','get_available_commands'].includes(request.type)) process.exit(8);
  const data = request.type === 'get_state' ? {model, thinkingLevel:'Future-Level'} : request.type === 'get_available_models' ? {models:[model, model, {provider:'Other',id:'plain',reasoning:false}]} : {commands:[{name:'compact',input:{hint:'Optional instructions'}},{name:'skill:'+require('node:path').basename(process.cwd()),description:process.env.SCOPE}]};
  if (process.env.CHUNK_MODE && request.type !== 'get_state') {
   if (request.type === 'get_available_models') data.models.push(...Array.from({length:1800},(_,i)=>({provider:'Acme',id:'large-'+i,name:'Model '+i,description:'🚀'.repeat(256)})));
   else data.commands.push(...Array.from({length:1700},(_,i)=>({name:'native-'+i,description:'🧩'.repeat(256)})));
   const bytes=Buffer.from(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data}));
   if(process.env.CHUNK_MODE==='legacy') { process.stdout.write(bytes.toString()+'\\n'); continue; }
   const size=256*1024,count=Math.ceil(bytes.length/size);
   const chunks=Array.from({length:count},(_,index)=>({type:'rpc_chunk',chunkId:request.id,index,count,byteLength:bytes.length,data:bytes.subarray(index*size,(index+1)*size).toString('base64')}));
   const mode=process.env.CHUNK_MODE;
   if(mode==='order') chunks.reverse();
   if(mode==='missing') chunks.pop();
   if(mode==='duplicate') chunks.splice(1,0,chunks[0]);
   if(mode==='mismatch') chunks[1].chunkId='unrelated';
   if(mode==='size') chunks[0].byteLength=9*1024*1024;
   if(mode==='base64') chunks[0].data='!not-base64!';
   if(mode==='metadata') chunks[0].count=NaN;
   if(mode==='length') for(const chunk of chunks) chunk.byteLength++;
   if(mode==='utf8') chunks[0].data=Buffer.from([255,...bytes.subarray(1,size)]).toString('base64');
   if(mode==='interrupted') chunks.splice(1,0,{type:'ready'});
   for(const chunk of chunks) process.stdout.write(JSON.stringify(chunk)+'\\n');
   continue;
  }
  process.stdout.write(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data})+'\\n');
 }
});
`;

const makeFixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-discovery-" });
  const binaryPath = `${directory}/omp`;
  yield* fs.writeFileString(binaryPath, fixture);
  yield* fs.chmod(binaryPath, 0o755);
  yield* fs.makeDirectory(`${directory}/one`);
  yield* fs.makeDirectory(`${directory}/two`);
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

describe("OmpDiscovery", () => {
  it.live.skipIf(windows)("reassembles large negotiated model and command catalogs", () =>
    Effect.gen(function* () {
      const { directory, settings } = yield* makeFixture();
      const catalog = yield* discoverOmpCatalog(
        settings,
        { ...process.env, CHUNK_MODE: "valid" },
        directory,
      );
      assert.equal(catalog.models.length, 1802);
      assert.equal(catalog.models.find((model) => model.isDefault)?.slug, "Acme/--profile=work");
      assert.equal(catalog.metadataBySlug.get("Acme/--profile=work")?.contextWindow, 1000000);
      assert.equal(catalog.slashCommands.length, 1701);
      assert.equal(catalog.skills.length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.skipIf(windows)("keeps plain catalogs working when older OMP rejects negotiation", () =>
    Effect.gen(function* () {
      const { directory, settings } = yield* makeFixture();
      const catalog = yield* discoverOmpCatalog(
        settings,
        { ...process.env, LEGACY_RPC: "1", CHUNK_MODE: "legacy" },
        directory,
      );
      assert.equal(catalog.models.length, 1802);
      assert.equal(catalog.skills.length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.skipIf(windows)(
    "rejects invalid, incomplete, unnegotiated and oversized chunk sequences",
    () =>
      Effect.gen(function* () {
        const { directory, settings } = yield* makeFixture();
        for (const mode of [
          "order",
          "missing",
          "duplicate",
          "mismatch",
          "size",
          "base64",
          "metadata",
          "length",
          "utf8",
          "interrupted",
          "unnegotiated",
        ]) {
          const result = yield* discoverOmpCatalog(
            settings,
            {
              ...process.env,
              CHUNK_MODE: mode,
              ...(mode === "unnegotiated" ? { LEGACY_RPC: "1" } : {}),
            },
            directory,
          ).pipe(Effect.result);
          assert.equal(result._tag, "Failure", mode);
          if (result._tag === "Failure") {
            assert.equal(result.failure.stage, "decode", mode);
            if (mode === "size") assert.equal(result.failure.reason, "catalog-too-large");
          }
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windows)(
    "times out and tears down a stuck subprocess without a real-time sleep",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const { settings } = yield* makeFixture();
        yield* fs.writeFileString(
          settings.binaryPath,
          `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>setInterval(()=>{},1000));\n`,
        );
        const spawned = yield* Deferred.make<void>();
        const result = yield* runOmpReadOnlyCommand(settings, process.env, ["--version"], {
          timeoutMs: 1000,
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              spawner.spawn(command).pipe(Effect.tap(() => Deferred.succeed(spawned, undefined))),
            ),
          ),
          Effect.result,
          Effect.forkScoped,
        );
        yield* Deferred.await(spawned);
        yield* TestClock.adjust("2 seconds");
        const settled = yield* Fiber.join(result);
        assert.equal(settled._tag, "Failure");
        if (settled._tag === "Failure") assert.equal(settled.failure.stage, "timeout");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windows)(
    "retains stale workspace observations on refresh failure without giving them a fresh age",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { directory, settings } = yield* makeFixture();
        const cache = yield* makeOmpDiscoveryCache(settings, process.env);
        const first = yield* cache.get(directory);
        yield* TestClock.adjust("6 minutes");
        yield* fs.writeFileString(settings.binaryPath, `#!${process.execPath}\nprocess.exit(1);\n`);
        const failed = yield* cache.get(directory).pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        assert.equal(cache.workspaceSnapshots()[0]?.checkedAt, first.checkedAt);
        yield* fs.writeFileString(settings.binaryPath, fixture);
        const recovered = yield* cache.get(directory);
        assert.notEqual(recovered.checkedAt, first.checkedAt);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windows)(
    "preserves native model IDs, defaults, context and per-model thinking without inference",
    () =>
      Effect.gen(function* () {
        const { directory, settings } = yield* makeFixture();
        const catalog = yield* discoverOmpCatalog(
          settings,
          { ...process.env, SCOPE: "instance environment" },
          `${directory}/one`,
        );
        assert.equal(catalog.models.length, 2);
        assert.equal(catalog.models[0]?.slug, "Acme/--profile=work");
        assert.equal(catalog.models[0]?.isDefault, true);
        assert.deepEqual(catalog.models[0]?.capabilities?.optionDescriptors, [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            currentValue: "Future-Level",
            options: [
              { id: "off", label: "off" },
              { id: "auto", label: "auto" },
              { id: "low", label: "low" },
              { id: "Future-Level", label: "Future-Level", isDefault: true },
            ],
          },
        ]);
        assert.equal(catalog.metadataBySlug.get("Acme/--profile=work")?.contextWindow, 1000000);
        assert.equal(catalog.skills[0]?.name, "one");
        assert.equal(catalog.skills[0]?.description, "instance environment");
        assert.equal(catalog.slashCommands[0]?.input?.hint, "Optional instructions");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windows)(
    "keys caches by workspace, retains all visited catalogs and does not refresh age on hits",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { directory, settings } = yield* makeFixture();
        const marker = `${directory}/probes`;
        const cache = yield* makeOmpDiscoveryCache(settings, { ...process.env, MARKER: marker });
        const first = yield* cache.get(`${directory}/one`);
        yield* TestClock.adjust("4 minutes");
        const hit = yield* cache.get(`${directory}/one`);
        assert.strictEqual(first, hit);
        yield* cache.get(`${directory}/two`);
        assert.equal(cache.workspaceSnapshots().length, 2);
        assert.equal(cache.workspaceSnapshots()[0]?.checkedAt, first.checkedAt);
        yield* TestClock.adjust("2 minutes");
        const fresh = yield* cache.get(`${directory}/one`);
        assert.notEqual(fresh.checkedAt, first.checkedAt);
        assert.equal((yield* fs.readFileString(marker)).trim().split("\n").length, 3);
        yield* cache.invalidate;
        assert.equal(cache.workspaceSnapshots().length, 0);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windows)(
    "rejects malformed or failed protocol responses rather than caching empty success",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { directory, settings } = yield* makeFixture();
        yield* fs.writeFileString(
          settings.binaryPath,
          `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'response',id:'get_state',command:'get_state',success:false,error:'secret'})));\n`,
        );
        const result = yield* discoverOmpCatalog(settings, process.env, directory).pipe(
          Effect.result,
        );
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "rpc-command-failed");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.live.skipIf(windows)(
    "recognizes OMP's legacy RPC transport overflow without leaking payloads",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { directory, settings } = yield* makeFixture();
        yield* fs.writeFileString(
          settings.binaryPath,
          `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'response',id:'get_available_models',command:'get_available_models',success:false,error:'RPC response exceeded the transport limit'})));\n`,
        );
        const result = yield* discoverOmpCatalog(settings, process.env, directory).pipe(
          Effect.result,
        );
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure") assert.equal(result.failure.reason, "catalog-too-large");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windows)("enforces output bounds on subprocesses", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { settings } = yield* makeFixture();
      yield* fs.writeFileString(
        settings.binaryPath,
        `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(2048)));\n`,
      );
      const result = yield* runOmpReadOnlyCommand(settings, process.env, ["--version"], {
        maxBytes: 1024,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
