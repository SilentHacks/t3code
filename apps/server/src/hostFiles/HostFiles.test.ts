import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import {
  createHostDownloadUrl,
  createHostUploadUrl,
  deleteHostPaths,
  listHostDirectory,
  makeHostDirectory,
  renameHostPath,
  resolveHostPath,
  storeHostUpload,
  validateHostDownloadToken,
  validateHostUploadToken,
} from "./HostFiles.ts";

const layerTest = ServerSecretStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-host-files-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeTree = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-host-files-"));
  NodeFS.mkdirSync(NodePath.join(root, "dir"));
  NodeFS.writeFileSync(NodePath.join(root, "dir", "inner.txt"), "inner");
  NodeFS.writeFileSync(NodePath.join(root, "b.txt"), "hello");
  NodeFS.writeFileSync(NodePath.join(root, ".hidden"), "");
  NodeFS.symlinkSync(NodePath.join(root, "dir"), NodePath.join(root, "link-dir"));
  NodeFS.symlinkSync(NodePath.join(root, "missing"), NodePath.join(root, "dangling"));
  return root;
};

const uploadBody = (text: string) => Stream.make(new TextEncoder().encode(text));

describe("resolveHostPath", () => {
  it("expands ~ and normalizes .. while rejecting relative paths", () => {
    expect(resolveHostPath("~", "/home/me")).toBe("/home/me");
    expect(resolveHostPath("~/a/../b", "/home/me")).toBe("/home/me/b");
    expect(resolveHostPath("/etc/../var//log/", "/home/me")).toBe("/var/log");
    expect(resolveHostPath("/../..", "/home/me")).toBe("/");
    expect(resolveHostPath("relative/path", "/home/me")).toBeNull();
    expect(resolveHostPath("~other/x", "/home/me")).toBeNull();
    expect(resolveHostPath("/a\0b", "/home/me")).toBeNull();
  });
});

describe("HostFiles", () => {
  it.effect("lists hidden files, folders first, and describes symlinks without following", () =>
    Effect.gen(function* () {
      const root = makeTree();
      const result = yield* listHostDirectory({ path: `${root}/dir/..` });
      expect(result.path).toBe(root);
      expect(result.parentPath).toBe(NodePath.dirname(root));
      expect(result.truncated).toBe(false);
      expect(result.entries.map((entry) => entry.name)).toEqual([
        "dir",
        "link-dir",
        ".hidden",
        "b.txt",
        "dangling",
      ]);
      const link = result.entries.find((entry) => entry.name === "link-dir");
      expect(link).toMatchObject({ kind: "symlink", targetKind: "directory" });
      expect(result.entries.find((entry) => entry.name === "dangling")).toMatchObject({
        kind: "symlink",
        targetKind: null,
      });
      expect(result.entries.find((entry) => entry.name === "b.txt")).toMatchObject({
        kind: "file",
        sizeBytes: 5,
      });
    }),
  );

  it.effect("maps errno to typed failures", () =>
    Effect.gen(function* () {
      const root = makeTree();
      const missing = yield* Effect.flip(listHostDirectory({ path: `${root}/nope` }));
      expect(missing.failure).toBe("not_found");
      const notDir = yield* Effect.flip(listHostDirectory({ path: `${root}/b.txt` }));
      expect(notDir.failure).toBe("not_a_directory");
      const relative = yield* Effect.flip(listHostDirectory({ path: "etc" }));
      expect(relative.failure).toBe("invalid_path");
      const exists = yield* Effect.flip(makeHostDirectory({ path: `${root}/dir` }));
      expect(exists.failure).toBe("already_exists");
    }),
  );

  it.effect("renames without overwriting and refuses moving a folder into itself", () =>
    Effect.gen(function* () {
      const root = makeTree();
      const clash = yield* Effect.flip(
        renameHostPath({ from: `${root}/b.txt`, to: `${root}/dir/inner.txt` }),
      );
      expect(clash.failure).toBe("already_exists");
      expect(NodeFS.readFileSync(`${root}/dir/inner.txt`, "utf8")).toBe("inner");
      const intoSelf = yield* Effect.flip(
        renameHostPath({ from: `${root}/dir`, to: `${root}/dir/sub` }),
      );
      expect(intoSelf.failure).toBe("invalid_path");
      const moved = yield* renameHostPath({ from: `${root}/b.txt`, to: `${root}/dir/b.txt` });
      expect(moved).toMatchObject({ path: `${root}/dir/b.txt`, kind: "file" });
    }),
  );

  it.effect("deletes recursively and removes symlinks without touching their targets", () =>
    Effect.gen(function* () {
      const root = makeTree();
      yield* deleteHostPaths({ paths: [`${root}/link-dir`] });
      expect(NodeFS.existsSync(`${root}/link-dir`)).toBe(false);
      expect(NodeFS.readFileSync(`${root}/dir/inner.txt`, "utf8")).toBe("inner");
      yield* deleteHostPaths({ paths: [`${root}/dir`] });
      expect(NodeFS.existsSync(`${root}/dir`)).toBe(false);
      const rootDelete = yield* Effect.flip(deleteHostPaths({ paths: ["/"] }));
      expect(rootDelete.failure).toBe("invalid_path");
    }),
  );

  it.effect("signs download tokens and rejects tampered ones", () =>
    Effect.gen(function* () {
      const root = makeTree();
      const file = yield* createHostDownloadUrl({ path: `${root}/b.txt` });
      expect(file.name).toBe("b.txt");
      const token = file.relativeUrl.split("/").at(-1)!;
      expect(yield* validateHostDownloadToken(token)).toMatchObject({ path: `${root}/b.txt` });
      expect(yield* validateHostDownloadToken(`${token}x`)).toBeNull();
      expect(yield* validateHostUploadToken(token)).toBeNull();
      const dir = yield* createHostDownloadUrl({ path: `${root}/dir` });
      expect(dir.name).toBe("dir.tar.gz");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stores uploads atomically and applies the conflict policy", () =>
    Effect.gen(function* () {
      const root = makeTree();
      const issue = (conflict: "fail" | "replace" | "keep-both", sizeBytes: number) =>
        createHostUploadUrl({ directory: root, name: "b.txt", sizeBytes, conflict }).pipe(
          Effect.flatMap((url) => validateHostUploadToken(url.relativeUrl.split("/").at(-1)!)),
          Effect.map((claims) => claims!),
        );

      const failEarly = yield* Effect.flip(
        createHostUploadUrl({ directory: root, name: "b.txt", sizeBytes: 1, conflict: "fail" }),
      );
      expect(failEarly.failure).toBe("already_exists");
      const badName = yield* Effect.flip(
        createHostUploadUrl({ directory: root, name: "../x", sizeBytes: 1, conflict: "fail" }),
      );
      expect(badName.failure).toBe("invalid_path");

      const keepBoth = yield* storeHostUpload(yield* issue("keep-both", 3), uploadBody("new"));
      expect(keepBoth).toEqual({ ok: true, path: `${root}/b (1).txt` });
      expect(NodeFS.readFileSync(`${root}/b.txt`, "utf8")).toBe("hello");

      const replace = yield* storeHostUpload(yield* issue("replace", 3), uploadBody("new"));
      expect(replace).toEqual({ ok: true, path: `${root}/b.txt` });
      expect(NodeFS.readFileSync(`${root}/b.txt`, "utf8")).toBe("new");

      const short = yield* storeHostUpload(yield* issue("replace", 10), uploadBody("abc"));
      expect(short.ok).toBe(false);
      expect(NodeFS.readFileSync(`${root}/b.txt`, "utf8")).toBe("new");
      expect(NodeFS.readdirSync(root).filter((name) => name.endsWith(".t3part"))).toEqual([]);

      const interrupted = yield* storeHostUpload(
        yield* issue("replace", 6),
        Stream.concat(uploadBody("abc"), Stream.fail(new Error("socket closed"))),
      );
      expect(interrupted.ok).toBe(false);
      expect(NodeFS.readFileSync(`${root}/b.txt`, "utf8")).toBe("new");
      expect(NodeFS.readdirSync(root).filter((name) => name.endsWith(".t3part"))).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );
});
