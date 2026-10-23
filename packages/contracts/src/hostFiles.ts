import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Host files: the environment host's whole filesystem, independent of any
 * project. Paths are absolute or `~`-relative and resolve on the server host.
 */
const HOST_FILES_PATH_MAX_LENGTH = 4096;
export const HOST_FILES_LIST_LIMIT = 5_000;
const HOST_FILES_DELETE_BATCH_LIMIT = 256;
export const HOST_FILES_TRANSFER_URL_TTL_MS = 15 * 60_000;
export const HOST_FILES_DOWNLOAD_ROUTE_PREFIX = "/api/host-files/download";
export const HOST_FILES_UPLOAD_ROUTE_PREFIX = "/api/host-files/upload";

export const HostFilesPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(HOST_FILES_PATH_MAX_LENGTH),
);

export const HostFileEntryKind = Schema.Literals(["file", "directory", "symlink", "other"]);
export type HostFileEntryKind = typeof HostFileEntryKind.Type;

export const HostFileEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  kind: HostFileEntryKind,
  /** For symlinks: what the link resolves to, or null when dangling. */
  targetKind: Schema.optionalKey(Schema.NullOr(Schema.Literals(["file", "directory", "other"]))),
  symlinkTarget: Schema.optionalKey(Schema.String),
  sizeBytes: Schema.optionalKey(NonNegativeInt),
  modifiedAt: Schema.optionalKey(Schema.String),
  /** Octal permission bits, e.g. "755". */
  mode: Schema.optionalKey(Schema.String),
});
export type HostFileEntry = typeof HostFileEntry.Type;

export const HostFilesListInput = Schema.Struct({ path: HostFilesPath });
export type HostFilesListInput = typeof HostFilesListInput.Type;

export const HostFilesListResult = Schema.Struct({
  /** Normalized absolute path that was listed. */
  path: TrimmedNonEmptyString,
  parentPath: Schema.NullOr(TrimmedNonEmptyString),
  homePath: TrimmedNonEmptyString,
  entries: Schema.Array(HostFileEntry),
  truncated: Schema.Boolean,
});
export type HostFilesListResult = typeof HostFilesListResult.Type;

export const HostFilesStatInput = Schema.Struct({ path: HostFilesPath });
export type HostFilesStatInput = typeof HostFilesStatInput.Type;

export const HostFilesMkdirInput = Schema.Struct({ path: HostFilesPath });
export type HostFilesMkdirInput = typeof HostFilesMkdirInput.Type;

export const HostFilesRenameInput = Schema.Struct({
  from: HostFilesPath,
  to: HostFilesPath,
});
export type HostFilesRenameInput = typeof HostFilesRenameInput.Type;

export const HostFilesDeleteInput = Schema.Struct({
  paths: Schema.Array(HostFilesPath).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(HOST_FILES_DELETE_BATCH_LIMIT),
  ),
});
export type HostFilesDeleteInput = typeof HostFilesDeleteInput.Type;

export const HostFilesCreateDownloadUrlInput = Schema.Struct({ path: HostFilesPath });
export type HostFilesCreateDownloadUrlInput = typeof HostFilesCreateDownloadUrlInput.Type;

export const HostFilesUploadConflict = Schema.Literals(["fail", "replace", "keep-both"]);
export type HostFilesUploadConflict = typeof HostFilesUploadConflict.Type;

export const HostFilesCreateUploadUrlInput = Schema.Struct({
  directory: HostFilesPath,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  sizeBytes: NonNegativeInt,
  conflict: HostFilesUploadConflict,
});
export type HostFilesCreateUploadUrlInput = typeof HostFilesCreateUploadUrlInput.Type;

export const HostFilesTransferUrl = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString,
  /** Download: suggested file name (directories download as `<name>.tar.gz`). Upload: final path. */
  name: TrimmedNonEmptyString,
  expiresAt: Schema.Number,
});
export type HostFilesTransferUrl = typeof HostFilesTransferUrl.Type;

export const HostFilesFailure = Schema.Literals([
  "invalid_path",
  "not_found",
  "permission_denied",
  "already_exists",
  "not_a_directory",
  "is_a_directory",
  "not_empty",
  "cross_device",
  "failed",
]);
export type HostFilesFailure = typeof HostFilesFailure.Type;

export class HostFilesError extends Schema.TaggedError<HostFilesError>()("HostFilesError", {
  failure: HostFilesFailure,
  path: Schema.optional(Schema.String),
  message: TrimmedNonEmptyString,
}) {}
