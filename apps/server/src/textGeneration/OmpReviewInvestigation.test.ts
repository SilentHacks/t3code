// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { runOmpReviewInvestigation } from "./OmpReviewInvestigation.ts";

const reviewCheckout = Effect.fn("reviewCheckout")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-review-" });
  const git = (args: readonly string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  git(["init", "-q"]);
  yield* fs.writeFileString(`${cwd}/source.ts`, "export const value = 1;\n");
  git(["add", "source.ts"]);
  git(["commit", "-qm", "Base"]);
  const baseCommit = git(["rev-parse", "HEAD"]);
  yield* fs.writeFileString(`${cwd}/source.ts`, "export const value = 2;\n");
  git(["commit", "-qam", "Change"]);
  yield* fs.writeFileString(`${cwd}/untracked-secret`, "do-not-read");
  const request = {
    operation: "generateReviewGuide" as const,
    cwd,
    prompt: "Investigate the change.",
    outputSchema: Schema.Struct({ stops: Schema.Array(Schema.String) }),
    modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "default" },
    investigate: { baseCommit, timeoutMs: 60_000 },
  };
  return { request, fs, cwd };
});

const answers = (responses: readonly unknown[], seen: string[] = []) => {
  let index = 0;
  return <S extends Schema.Top>(text: string, schema: S) => {
    seen.push(text);
    return Schema.decodeUnknownEffect(schema)(responses[index++]).pipe(Effect.orDie);
  };
};

it.layer(NodeServices.layer)("OMP read-only review evidence", (it) => {
  it.effect("reads pinned objects and diff evidence without consulting untracked files", () =>
    Effect.gen(function* () {
      const { request, fs, cwd } = yield* reviewCheckout();
      const seen: string[] = [];
      const guide = yield* runOmpReviewInvestigation(
        request,
        answers(
          [
            { action: "files" },
            { action: "read", path: "source.ts", revision: "base", start: 1, count: 200 },
            { action: "read", path: "source.ts", revision: "head", start: 1, count: 200 },
            { action: "diff", path: "source.ts", start: 1, count: 200 },
            { action: "finish", guide: { stops: ["The value changes."] } },
          ],
          seen,
        ),
      );
      expect(guide.stops).toEqual(["The value changes."]);
      expect(seen[1]).not.toContain("untracked-secret");
      expect(seen[2]).toContain("value = 1");
      expect(seen[3]).toContain("value = 2");
      expect(seen[4]).toContain("+export const value = 2");
      expect(yield* fs.readFileString(`${cwd}/source.ts`)).toBe("export const value = 2;\n");
    }).pipe(Effect.scoped),
  );
  it.effect("refuses a final answer without inspecting a nonempty diff", () =>
    Effect.gen(function* () {
      const { request } = yield* reviewCheckout();
      const error = yield* runOmpReviewInvestigation(
        request,
        answers([{ action: "finish", guide: { stops: [] } }]),
      ).pipe(Effect.flip);
      expect(error.detail).toContain("without inspecting the diff");
    }).pipe(Effect.scoped),
  );
  it.effect("fails closed on traversal, Git option injection and untracked-file reads", () =>
    Effect.gen(function* () {
      const { request } = yield* reviewCheckout();
      for (const path of [
        "../outside",
        "/etc/passwd",
        ".git/config",
        "a/../../outside",
        "untracked-secret",
        "--output=/tmp/write",
      ]) {
        const error = yield* runOmpReviewInvestigation(
          request,
          answers([{ action: "read", path, revision: "head", start: 1, count: 200 }]),
        ).pipe(Effect.flip);
        expect(error.operation).toBe("generateReviewGuide");
        expect(error.detail).not.toContain("do-not-read");
      }
    }).pipe(Effect.scoped),
  );
  it.effect("bounds repeated evidence requests", () =>
    Effect.gen(function* () {
      const { request } = yield* reviewCheckout();
      const error = yield* runOmpReviewInvestigation(
        request,
        answers(Array.from({ length: 48 }, () => ({ action: "files" }))),
      ).pipe(Effect.flip);
      expect(error.detail).toContain("step budget");
    }).pipe(Effect.scoped),
  );
  it.effect("does not follow tracked symlinks or run external diff commands", () =>
    Effect.gen(function* () {
      const { request, fs, cwd } = yield* reviewCheckout();
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-review-outside-" });
      yield* fs.writeFileString(`${outside}/secret`, "outside-secret-content");
      yield* fs.symlink(`${outside}/secret`, `${cwd}/link`);
      const git = (args: string[]) =>
        NodeChildProcess.execFileSync("git", args, {
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
          },
        });
      git(["add", "link"]);
      git(["commit", "-qm", "Add symlink"]);
      const seen: string[] = [];
      yield* runOmpReviewInvestigation(
        request,
        answers(
          [
            { action: "read", revision: "head", path: "link", start: 1, count: 200 },
            { action: "diff", path: "source.ts", start: 1, count: 200 },
            { action: "finish", guide: { stops: [] } },
          ],
          seen,
        ),
      ).pipe(
        Effect.provideService(HostProcess.Environment, {
          ...process.env,
          GIT_EXTERNAL_DIFF: "false",
          GIT_DIR: "/invalid/repo",
        }),
      );
      expect(seen.join(" ")).not.toContain("outside-secret-content");
    }).pipe(Effect.scoped),
  );
  it.effect(
    "rejects oversized and binary object content rather than returning partial evidence",
    () =>
      Effect.gen(function* () {
        const { request, fs, cwd } = yield* reviewCheckout();
        yield* fs.writeFileString(`${cwd}/large`, "x".repeat(1024 * 1024 + 1));
        yield* fs.writeFileString(`${cwd}/binary`, "x\u0000y");
        NodeChildProcess.execFileSync("git", ["add", "large", "binary"], { cwd });
        NodeChildProcess.execFileSync("git", ["commit", "-qm", "Large objects"], {
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
          },
        });
        for (const path of ["large", "binary"]) {
          const error = yield* runOmpReviewInvestigation(
            request,
            answers([{ action: "read", revision: "head", path, start: 1, count: 200 }]),
          ).pipe(Effect.flip);
          expect(error.detail).toContain("bounded text evidence");
        }
      }).pipe(Effect.scoped),
  );
});
