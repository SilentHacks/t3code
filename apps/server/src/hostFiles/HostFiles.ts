// @effect-diagnostics nodeBuiltinImport:off -- lstat/readlink/errno detail the Effect FileSystem does not expose.
/**
 * Host files: the environment host's whole filesystem, independent of any
 * project. Authorization happens at the RPC/route layer (terminal:operate);
 * this module resolves paths, maps errno to typed failures, and signs the
 * short-lived transfer URLs that move bytes over plain HTTP.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import {
  HOST_FILES_DOWNLOAD_ROUTE_PREFIX,
  HOST_FILES_LIST_LIMIT,
  HOST_FILES_TRANSFER_URL_TTL_MS,
  HOST_FILES_UPLOAD_ROUTE_PREFIX,
  type HostFileEntry,
  type HostFilesCreateDownloadUrlInput,
  type HostFilesCreateUploadUrlInput,
  type HostFilesDeleteInput,
  HostFilesError,
  type HostFilesFailure,
  type HostFilesListInput,
  type HostFilesListResult,
  type HostFilesMkdirInput,
  type HostFilesRenameInput,
  type HostFilesTransferUrl,
  HostFilesUploadConflict,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

// Shared with asset/attachment tokens; the signed claim kind keeps them apart.
const SIGNING_SECRET_NAME = "asset-access-signing-key";

const errnoFailure = (code: string | undefined): HostFilesFailure => {
  switch (code) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "permission_denied";
    case "EEXIST":
      return "already_exists";
    case "ENOTDIR":
      return "not_a_directory";
    case "EISDIR":
      return "is_a_directory";
    case "ENOTEMPTY":
      return "not_empty";
    case "EXDEV":
      return "cross_device";
    default:
      return "failed";
  }
};

const FAILURE_MESSAGES: Record<HostFilesFailure, string> = {
  invalid_path: "Enter an absolute path or a path starting with ~.",
  not_found: "No such file or folder.",
  permission_denied: "Permission denied.",
  already_exists: "Something with that name already exists.",
  not_a_directory: "Not a folder.",
  is_a_directory: "That is a folder.",
  not_empty: "The folder is not empty.",
  cross_device: "Cannot move across filesystems.",
  failed: "The filesystem operation failed.",
};

export const hostFilesError = (failure: HostFilesFailure, path?: string, detail?: string) =>
  new HostFilesError({
    failure,
    ...(path === undefined ? {} : { path }),
    message: detail ?? FAILURE_MESSAGES[failure],
  });

const fsCall = <A>(path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      hostFilesError(errnoFailure((cause as NodeJS.ErrnoException | undefined)?.code), path),
  });

/** Absolute or `~`-relative host path to a normalized absolute path. */
export function resolveHostPath(input: string, home = NodeOS.homedir()): string | null {
  const trimmed = input.trim();
  if (trimmed.includes("\0")) return null;
  let candidate = trimmed;
  if (candidate === "~") candidate = home;
  else if (candidate.startsWith("~/")) candidate = NodePath.join(home, candidate.slice(2));
  if (!NodePath.isAbsolute(candidate)) return null;
  return NodePath.resolve(candidate);
}

const requirePath = (input: string) => {
  const resolved = resolveHostPath(input);
  return resolved === null
    ? Effect.fail(hostFilesError("invalid_path", input))
    : Effect.succeed(resolved);
};

const isValidEntryName = (name: string) =>
  name.length > 0 && name !== "." && name !== ".." && !/[/\0]/.test(name);

const statKind = (stats: {
  isFile(): boolean;
  isDirectory(): boolean;
}): "file" | "directory" | "other" =>
  stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "other";

/** Describes a path without following it; symlinks report their target separately. */
export const describeEntry = (path: string) =>
  Effect.gen(function* () {
    const stats = yield* fsCall(path, () => NodeFSP.lstat(path));
    const base: {
      -readonly [K in keyof HostFileEntry]: HostFileEntry[K];
    } = {
      name: NodePath.basename(path) || path,
      path,
      kind: stats.isSymbolicLink() ? "symlink" : statKind(stats),
      modifiedAt: stats.mtime.toISOString(),
      mode: (stats.mode & 0o7777).toString(8),
    };
    if (stats.isFile()) base.sizeBytes = stats.size;
    if (stats.isSymbolicLink()) {
      base.symlinkTarget = yield* Effect.promise(() => NodeFSP.readlink(path).catch(() => ""));
      const target = yield* Effect.promise(() => NodeFSP.stat(path).catch(() => null));
      base.targetKind = target === null ? null : statKind(target);
      if (target?.isFile()) base.sizeBytes = target.size;
    }
    return base as HostFileEntry;
  });

const sortEntries = (left: HostFileEntry, right: HostFileEntry) => {
  const leftDir = left.kind === "directory" || left.targetKind === "directory";
  const rightDir = right.kind === "directory" || right.targetKind === "directory";
  if (leftDir !== rightDir) return leftDir ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
};

export const listHostDirectory = Effect.fn("HostFiles.list")(function* (input: HostFilesListInput) {
  const path = yield* requirePath(input.path);
  const target = yield* fsCall(path, () => NodeFSP.stat(path));
  if (!target.isDirectory()) return yield* hostFilesError("not_a_directory", path);
  const names = yield* fsCall(path, () => NodeFSP.readdir(path));
  const truncated = names.length > HOST_FILES_LIST_LIMIT;
  const entries = yield* Effect.forEach(
    names.slice(0, HOST_FILES_LIST_LIMIT),
    (name) =>
      describeEntry(NodePath.join(path, name)).pipe(
        // Entries can vanish or deny lstat between readdir and lstat.
        Effect.orElseSucceed((): HostFileEntry => ({
          name,
          path: NodePath.join(path, name),
          kind: "other",
        })),
      ),
    { concurrency: 32 },
  );
  const parent = NodePath.dirname(path);
  return {
    path,
    parentPath: parent === path ? null : parent,
    homePath: NodeOS.homedir(),
    entries: entries.toSorted(sortEntries),
    truncated,
  } satisfies HostFilesListResult;
});

export const statHostPath = Effect.fn("HostFiles.stat")(function* (input: {
  readonly path: string;
}) {
  return yield* describeEntry(yield* requirePath(input.path));
});

export const makeHostDirectory = Effect.fn("HostFiles.mkdir")(function* (
  input: HostFilesMkdirInput,
) {
  const path = yield* requirePath(input.path);
  yield* fsCall(path, () => NodeFSP.mkdir(path));
  return yield* describeEntry(path);
});

const pathExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.lstat(path).then(
      () => true,
      () => false,
    ),
  );

export const renameHostPath = Effect.fn("HostFiles.rename")(function* (
  input: HostFilesRenameInput,
) {
  const from = yield* requirePath(input.from);
  const to = yield* requirePath(input.to);
  if (from === "/" || to === "/") return yield* hostFilesError("invalid_path", from);
  if (to === from) return yield* describeEntry(from);
  if (to.startsWith(`${from}/`)) {
    return yield* hostFilesError("invalid_path", to, "Cannot move a folder into itself.");
  }
  // rename(2) silently replaces files; moves never overwrite.
  if (yield* pathExists(to)) return yield* hostFilesError("already_exists", to);
  yield* fsCall(from, () => NodeFSP.rename(from, to)).pipe(
    Effect.catchIf(
      (error) => error.failure === "cross_device",
      () =>
        fsCall(from, async () => {
          await NodeFSP.cp(from, to, {
            recursive: true,
            errorOnExist: true,
            force: false,
            verbatimSymlinks: true,
            preserveTimestamps: true,
          });
          await NodeFSP.rm(from, { recursive: true });
        }),
    ),
  );
  return yield* describeEntry(to);
});

export const deleteHostPaths = Effect.fn("HostFiles.delete")(function* (
  input: HostFilesDeleteInput,
) {
  const paths = yield* Effect.forEach(input.paths, requirePath);
  for (const path of paths) {
    if (path === "/") return yield* hostFilesError("invalid_path", path, "Refusing to delete /.");
  }
  // rm never follows symlinks: deleting a link removes only the link.
  yield* Effect.forEach(
    paths,
    (path) => fsCall(path, () => NodeFSP.rm(path, { recursive: true })),
    {
      discard: true,
    },
  );
});

// --- Signed transfer URLs ---------------------------------------------------

const DownloadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("host-file-download"),
  path: Schema.String,
  expiresAt: Schema.Number,
});
const UploadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("host-file-upload"),
  directory: Schema.String,
  name: Schema.String,
  sizeBytes: Schema.Number,
  conflict: HostFilesUploadConflict,
  expiresAt: Schema.Number,
});
export type HostFileUploadClaims = typeof UploadClaims.Type;
const downloadJson = Schema.fromJsonString(DownloadClaims);
const uploadJson = Schema.fromJsonString(UploadClaims);
const encodeDownload = Schema.encodeSync(downloadJson);
const encodeUpload = Schema.encodeSync(uploadJson);
const decodeDownload = Schema.decodeUnknownOption(downloadJson);
const decodeUpload = Schema.decodeUnknownOption(uploadJson);

const loadSecret = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  return yield* store.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
}).pipe(Effect.mapError(() => hostFilesError("failed", undefined, "Signing key unavailable.")));

const signToken = (encodedPayload: string, secret: Uint8Array) =>
  `${encodedPayload}.${signPayload(encodedPayload, secret)}`;

const verifyToken = <A extends { readonly expiresAt: number }>(
  token: string,
  decode: (input: string) => Option.Option<A>,
) =>
  Effect.gen(function* () {
    const [encodedPayload, signature, extra] = token.split(".");
    if (!encodedPayload || !signature || extra !== undefined) return null;
    const secret = yield* loadSecret.pipe(Effect.orElseSucceed(() => null));
    if (!secret || !timingSafeEqualBase64Url(signature, signPayload(encodedPayload, secret))) {
      return null;
    }
    const claims = yield* Effect.try(() =>
      Option.getOrNull(decode(base64UrlDecodeUtf8(encodedPayload))),
    ).pipe(Effect.orElseSucceed(() => null));
    if (!claims || claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
    return claims;
  });

export const createHostDownloadUrl = Effect.fn("HostFiles.createDownloadUrl")(function* (
  input: HostFilesCreateDownloadUrlInput,
) {
  const path = yield* requirePath(input.path);
  const target = yield* fsCall(path, () => NodeFSP.stat(path));
  if (!target.isFile() && !target.isDirectory()) return yield* hostFilesError("failed", path);
  const secret = yield* loadSecret;
  const expiresAt = (yield* Clock.currentTimeMillis) + HOST_FILES_TRANSFER_URL_TTL_MS;
  const payload = base64UrlEncode(
    encodeDownload({ version: 1, kind: "host-file-download", path, expiresAt }),
  );
  const baseName = NodePath.basename(path) || "root";
  return {
    relativeUrl: `${HOST_FILES_DOWNLOAD_ROUTE_PREFIX}/${signToken(payload, secret)}`,
    name: target.isDirectory() ? `${baseName}.tar.gz` : baseName,
    expiresAt,
  } satisfies HostFilesTransferUrl;
});

export const createHostUploadUrl = Effect.fn("HostFiles.createUploadUrl")(function* (
  input: HostFilesCreateUploadUrlInput,
) {
  const directory = yield* requirePath(input.directory);
  if (!isValidEntryName(input.name)) {
    return yield* hostFilesError("invalid_path", input.name, "Invalid file name.");
  }
  const target = yield* fsCall(directory, () => NodeFSP.stat(directory));
  if (!target.isDirectory()) return yield* hostFilesError("not_a_directory", directory);
  const finalPath = NodePath.join(directory, input.name);
  if (input.conflict === "fail" && (yield* pathExists(finalPath))) {
    return yield* hostFilesError("already_exists", finalPath);
  }
  const secret = yield* loadSecret;
  const expiresAt = (yield* Clock.currentTimeMillis) + HOST_FILES_TRANSFER_URL_TTL_MS;
  const payload = base64UrlEncode(
    encodeUpload({
      version: 1,
      kind: "host-file-upload",
      directory,
      name: input.name,
      sizeBytes: input.sizeBytes,
      conflict: input.conflict,
      expiresAt,
    }),
  );
  return {
    relativeUrl: `${HOST_FILES_UPLOAD_ROUTE_PREFIX}/${signToken(payload, secret)}`,
    name: finalPath,
    expiresAt,
  } satisfies HostFilesTransferUrl;
});

export const validateHostDownloadToken = (token: string) => verifyToken(token, decodeDownload);
export const validateHostUploadToken = (token: string) => verifyToken(token, decodeUpload);

/** `name (1).ext`, `name (2).ext`, ... — the first free sibling. */
export const keepBothPath = (directory: string, name: string) =>
  Effect.gen(function* () {
    const extension = NodePath.extname(name);
    const stem =
      extension.length > 0 && extension !== name ? name.slice(0, -extension.length) : name;
    for (let index = 1; index < 10_000; index += 1) {
      const candidate = NodePath.join(directory, `${stem} (${index})${extension}`);
      if (!(yield* pathExists(candidate))) return candidate;
    }
    return yield* hostFilesError("already_exists", NodePath.join(directory, name));
  });

export type HostUploadResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly status: number; readonly detail: string };

/**
 * Streams into a hidden sibling, then renames into place, so readers never
 * see a partial file and an aborted upload leaves nothing behind.
 */
export const storeHostUpload = Effect.fn("HostFiles.storeUpload")(function* (
  claims: HostFileUploadClaims,
  body: Stream.Stream<Uint8Array, unknown>,
) {
  const crypto = yield* Crypto.Crypto;
  const partId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
  const partPath = NodePath.join(claims.directory, `.${claims.name}.${partId}.t3part`);
  let received = 0;
  const result = yield* Effect.gen(function* () {
    const handle = yield* fsCall(partPath, () => NodeFSP.open(partPath, "wx", 0o644));
    const chunks = body.pipe(
      Stream.mapError(() => hostFilesError("failed", partPath, "The upload was interrupted.")),
    );
    yield* Stream.runForEach(chunks, (chunk) =>
      Effect.gen(function* () {
        received += chunk.byteLength;
        if (received > claims.sizeBytes) {
          return yield* hostFilesError("failed", partPath, "Upload exceeded its declared size.");
        }
        yield* fsCall(partPath, () => handle.write(chunk));
      }),
    ).pipe(Effect.ensuring(Effect.promise(() => handle.close().catch(() => undefined))));
    if (received !== claims.sizeBytes) {
      return {
        ok: false,
        status: 400,
        detail: `Body was ${received} bytes, expected ${claims.sizeBytes}.`,
      } satisfies HostUploadResult;
    }
    let finalPath = NodePath.join(claims.directory, claims.name);
    const existing = yield* Effect.promise(() => NodeFSP.lstat(finalPath).catch(() => null));
    if (existing !== null) {
      if (claims.conflict === "fail") {
        return { ok: false, status: 409, detail: "A file with that name already exists." } as const;
      }
      if (claims.conflict === "keep-both")
        finalPath = yield* keepBothPath(claims.directory, claims.name);
      else if (existing.isDirectory()) {
        return {
          ok: false,
          status: 409,
          detail: "A folder with that name already exists.",
        } as const;
      }
    }
    yield* fsCall(finalPath, () => NodeFSP.rename(partPath, finalPath));
    return { ok: true, path: finalPath } satisfies HostUploadResult;
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ok: false,
        status: error.failure === "permission_denied" ? 403 : 500,
        detail: error.message,
      } satisfies HostUploadResult),
    ),
    Effect.ensuring(
      Effect.promise(() => NodeFSP.rm(partPath, { force: true }).catch(() => undefined)),
    ),
  );
  return result;
});

/** Streams a directory as gzip'd tar; symlinks are archived as links. */
export const streamDirectoryArchive = (path: string): Stream.Stream<Uint8Array, HostFilesError> =>
  Stream.fromReadableStream({
    evaluate: () => {
      const child = NodeChildProcess.spawn(
        "tar",
        ["-czf", "-", "-C", NodePath.dirname(path), NodePath.basename(path)],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      return NodeStream.Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    },
    onError: () => hostFilesError("failed", path, "Failed to archive the folder."),
  });

export const statForDownload = (path: string) =>
  Effect.promise(() => NodeFSP.stat(path).catch(() => null));
