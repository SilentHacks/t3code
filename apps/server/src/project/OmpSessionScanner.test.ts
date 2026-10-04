import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { OmpSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Scanner from "./AgentSessionScanner.ts";
import { resolveOmpSessionsDirectory } from "./OmpSessionLayout.ts";

const instanceId = ProviderInstanceId.make("omp-work");
const decodeOmpSettings = Schema.decodeEffect(OmpSettings);
const stamp = "2026-09-01T10:00:00.000Z";
const journal = (cwd: string) => [
  { type: "title", v: 1, title: "Current OMP title", pad: "", updatedAt: stamp },
  {
    type: "session",
    version: 3,
    id: "Native/Session.ID",
    cwd,
    timestamp: stamp,
    title: "Original title",
  },
  {
    type: "model_change",
    id: "m",
    parentId: null,
    timestamp: stamp,
    model: "Provider/Native.Model",
    role: "default",
  },
  {
    type: "message",
    id: "u",
    parentId: "m",
    timestamp: stamp,
    message: {
      role: "user",
      content: [
        { type: "text", text: "Fix the bug" },
        { type: "image", data: "private-base64" },
      ],
    },
  },
  {
    type: "message",
    id: "old",
    parentId: "u",
    timestamp: stamp,
    message: { role: "assistant", content: [{ type: "text", text: "Old abandoned branch" }] },
  },
  {
    type: "thinking_level_change",
    id: "t",
    parentId: "u",
    timestamp: stamp,
    thinkingLevel: "high",
  },
  {
    type: "message",
    id: "a",
    parentId: "t",
    timestamp: stamp,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Fixed the bug" },
      ],
    },
  },
];
const encode = (records: readonly unknown[]) =>
  records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const parse = (contents: string) =>
  Scanner.parseAgentSessionTranscript({
    source: "omp",
    providerInstanceId: instanceId,
    fallbackSessionId: "filename-must-not-be-id",
    lastActiveAtMs: Date.parse(stamp),
    contents,
  });

describe("OMP v3 transcript parsing", () => {
  it("keeps native IDs and the current parent-chain text, excluding abandoned branches and private payloads", () => {
    expect(parse(encode(journal("/repo")))).toMatchObject({
      source: "omp",
      providerInstanceId: instanceId,
      providerSessionId: "Native/Session.ID",
      title: "Current OMP title",
      model: "Provider/Native.Model",
      messages: [
        { role: "user", text: "Fix the bug" },
        { role: "assistant", text: "Fixed the bug" },
      ],
    });
  });
  it("requires native metadata rather than guessing from filenames", () => {
    expect(
      parse(encode(journal("/repo").filter((record) => record.type !== "session"))),
    ).toBeNull();
    expect(
      parse(
        encode([
          { type: "session", version: 3, id: " padded ", cwd: "/repo" },
          ...journal("/repo").slice(2),
        ]),
      ),
    ).toBeNull();
  });
  it("rejects cycles, dangling parents, duplicate IDs and record-budget overflow", () => {
    const records = journal("/repo");
    expect(
      parse(encode([...records, { type: "message", id: "cycle", parentId: "cycle" }])),
    ).toBeNull();
    expect(
      parse(encode([...records, { type: "message", id: "bad", parentId: "missing" }])),
    ).toBeNull();
    expect(parse(encode([...records, records[3]]))).toBeNull();
    expect(parse(encode([...records, records[1]]))).toBeNull();
    expect(parse(encode(records) + "not json\n")).toBeNull();
    expect(parse(encode([...records, { type: "message", parentId: "a" }]))).toBeNull();
    expect(
      parse(
        encode([
          ...records,
          { type: "message", id: "future", parentId: "next" },
          { type: "message", id: "next", parentId: "future" },
          { type: "message", id: "good-leaf", parentId: "a" },
        ]),
      ),
    ).toBeNull();
    expect(parse(encode(records) + "{}\n".repeat(100_001))).toBeNull();
  });
});

it.layer(NodeServices.layer)("OMP session discovery", (it) => {
  it.effect("honors profile precedence, agent overrides and profile-specific XDG existence", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "omp-layout-test-" });
      const xdg = path.join(home, "data");
      const settings = yield* decodeOmpSettings({ profile: "work" });
      const input = {
        settings,
        environment: {
          HOME: home,
          PI_CODING_AGENT_DIR: "/override",
          OMP_PROFILE: "other",
          XDG_DATA_HOME: xdg,
        },
        platform: "linux" as const,
        homeDirectory: home,
      };
      expect(yield* resolveOmpSessionsDirectory(input)).toBe(
        path.join(home, ".omp/profiles/work/agent/sessions"),
      );
      yield* fs.makeDirectory(path.join(xdg, "omp/profiles/work"), { recursive: true });
      expect(yield* resolveOmpSessionsDirectory(input)).toBe(
        path.join(xdg, "omp/profiles/work/sessions"),
      );
      expect(
        yield* resolveOmpSessionsDirectory({
          ...input,
          settings: { ...settings, profile: "../unsafe" },
        }),
      ).toBeNull();
      expect(
        yield* resolveOmpSessionsDirectory({
          ...input,
          settings: { ...settings, profile: "default" },
        }),
      ).toBe("/override/sessions");
      expect(
        yield* resolveOmpSessionsDirectory({
          ...input,
          settings: { ...settings, profile: "" },
          environment: { HOME: home, OMP_PROFILE: "", PI_PROFILE: "ignored" },
        }),
      ).toBe(path.join(home, ".omp/agent/sessions"));
    }),
  );
  it.effect("discovers instance-local native journals and records stable import identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "omp-scan-test-" });
      const workspace = path.join(root, "workspace");
      yield* fs.makeDirectory(path.join(workspace, ".git"), { recursive: true });
      const sessionPath = path.join(
        root,
        ".omp/profiles/work/agent/sessions/-lossy-directory-name/does-not-match-session.jsonl",
      );
      yield* fs.makeDirectory(path.dirname(sessionPath), { recursive: true });
      yield* fs.writeFileString(sessionPath, encode(journal(workspace)));
      yield* fs.utimes(sessionPath, Date.parse(stamp) / 1000, Date.parse(stamp) / 1000);
      const malformedPath = path.join(path.dirname(sessionPath), "malformed.jsonl");
      const oversizedPath = path.join(path.dirname(sessionPath), "oversized.jsonl");
      yield* fs.writeFileString(
        malformedPath,
        encode([
          ...journal(workspace),
          { type: "message", id: "bad", parentId: "a", message: { content: 42 } },
        ]),
      );
      yield* fs.writeFileString(
        oversizedPath,
        encode([
          ...journal(workspace),
          {
            type: "message",
            id: "big",
            parentId: "a",
            timestamp: stamp,
            message: { role: "assistant", content: "x".repeat(32 * 1024 * 1024 + 1) },
          },
        ]),
      );
      for (const filePath of [malformedPath, oversizedPath])
        yield* fs.utimes(filePath, Date.parse(stamp) / 1000, Date.parse(stamp) / 1000);
      yield* TestClock.setTime(Date.parse(stamp) + 1000);
      const layer = Scanner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              providers: { claudeAgent: { enabled: false }, codex: { enabled: false } },
              providerInstances: {
                [instanceId]: {
                  driver: ProviderDriverKind.make("omp"),
                  config: { enabled: true, profile: "work" },
                  environment: [{ name: "HOME", value: root }],
                },
              },
            }),
            ServerConfig.layerTest(root, { prefix: "omp-config-test-" }),
            Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
            Layer.succeed(HostProcessEnvironment, {}),
            Layer.succeed(HostProcessPlatform, "linux"),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const scanner = yield* Scanner.AgentSessionScanner;
        const result = yield* scanner.scan;
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]).toMatchObject({
          path: workspace,
          sources: ["omp"],
          threadCount: 3,
        });
        const outcomes = Array.from(
          yield* scanner.recentThreads(workspace).pipe(Stream.runCollect),
        );
        expect(outcomes).toHaveLength(3);
        expect(outcomes.filter((outcome) => outcome._tag === "Skipped")).toHaveLength(2);
        const imported = outcomes.find((outcome) => outcome._tag === "Importable");
        expect(imported).toMatchObject({
          _tag: "Importable",
          thread: { providerSessionId: "Native/Session.ID", providerInstanceId: instanceId },
          source: {
            filePath: sessionPath,
            providerSessionId: "Native/Session.ID",
            providerInstanceId: instanceId,
          },
        });
        if (!imported) return;
        const repeated = Array.from(
          yield* scanner.recentThreads(workspace, [imported.source]).pipe(Stream.runCollect),
        );
        expect(repeated.filter((outcome) => outcome._tag === "AlreadyImported")).toHaveLength(1);
        expect(repeated.filter((outcome) => outcome._tag === "Skipped")).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    }),
  );
});
