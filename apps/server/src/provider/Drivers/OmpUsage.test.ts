import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { OmpSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { probeOmpUsage } from "./OmpUsage.ts";

const decodeSettings = Schema.decodeEffect(OmpSettings);
const checkedAt = "2026-10-03T00:00:00.000Z";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const makeProbe = Effect.fnUntraced(function* (output: unknown, exitCode = 0) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-usage-" });
  const binaryPath = `${directory}/omp`;
  yield* fs.writeFileString(
    binaryPath,
    `#!${process.execPath}
const args=process.argv.slice(2);
if(args.join(' ')!=='--profile=work usage --json' || process.env.SCOPE!=='scoped') process.exit(8);
process.stdin.resume();
process.stdin.on('end',()=>{console.log(${encodeJson(encodeJson(output))});process.exitCode=${exitCode};});
`,
  );
  yield* fs.chmod(binaryPath, 0o755);
  const settings = yield* decodeSettings({
    enabled: true,
    binaryPath,
    profile: "work",
  });
  return yield* probeOmpUsage(settings, checkedAt, { ...process.env, SCOPE: "scoped" }, directory);
});

const windows = HostProcessPlatform.defaultValue() === "win32";
describe("OmpUsage", () => {
  it.effect.skipIf(windows)(
    "keeps windows distinct even when they share the same native pool ID",
    () =>
      Effect.gen(function* () {
        const result = yield* makeProbe({
          reports: [
            {
              provider: "openai-codex",
              metadata: { accountId: "one" },
              limits: [
                { id: "chat", window: { id: "5h" }, amount: { usedFraction: 0.2 } },
                { id: "chat", window: { id: "7d" }, amount: { remainingFraction: 0.6 } },
              ],
            },
          ],
        });
        assert.equal(result.usageLimits.windows.length, 2);
        assert.deepEqual(
          result.usageLimits.windows.map((window) => window.id),
          ["openai-codex:7692c3ad3540bb80:chat:5h", "openai-codex:7692c3ad3540bb80:chat:7d"],
        );
        assert.deepEqual(
          result.usageLimits.windows.map((window) => window.kind),
          ["session", "weekly"],
        );
        assert.equal(new Set(result.usageLimits.windows.map((window) => window.id)).size, 2);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect.skipIf(windows)(
    "maps successful usage, expires stale windows and retains distinct pools/accounts",
    () =>
      Effect.gen(function* () {
        const limit = {
          id: "chat",
          window: {
            id: "5h",
            durationMs: 5 * 60 * 60 * 1000,
            resetsAt: Date.parse(checkedAt) + 60000,
          },
          amount: { usedFraction: 0.4 },
        };
        const result = yield* makeProbe({
          reports: [
            {
              provider: "openai-codex",
              metadata: { accountId: "first", email: "one@example.com" },
              limits: [
                limit,
                { ...limit, id: "spark" },
                { ...limit, id: "expired", window: { id: "7d", resetsAt: checkedAt } },
              ],
            },
            { provider: "openai-codex", metadata: { accountId: "second" }, limits: [limit] },
          ],
        });
        assert.equal(result.auth.status, "authenticated");
        assert.equal(result.auth.email, "one@example.com");
        assert.equal(result.usageLimits.windows.length, 3);
        assert.equal(new Set(result.usageLimits.windows.map((window) => window.id)).size, 3);
        assert.ok(
          result.usageLimits.windows.every(
            (window) => window.usedPercent === 40 && window.kind === "session",
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(windows)(
    "never treats stored accounts, malformed reports or a failed exit as usable authentication",
    () =>
      Effect.gen(function* () {
        for (const [payload, code] of [
          [{ accounts: [{ provider: "openai", email: "stored@example.com" }], reports: [] }, 0],
          [{ reports: [{ provider: "openai" }] }, 0],
          [{ reports: [{ provider: "openai", limits: [] }] }, 1],
        ] as const) {
          const result = yield* makeProbe(payload, code);
          assert.equal(result.auth.status, "unknown");
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not spawn for disabled settings", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({});
      const result = yield* probeOmpUsage(settings, checkedAt, process.env).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("must not spawn")),
        ),
      );
      assert.equal(result.auth.status, "unknown");
    }),
  );
});
