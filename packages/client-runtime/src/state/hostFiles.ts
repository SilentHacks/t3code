import { WS_METHODS, type HostFileEntry } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * RPC commands for the environment host's whole filesystem ("Server files").
 * Each client instantiates them with its own connection runtime.
 */
export function createHostFilesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:host-files:list",
      tag: WS_METHODS.hostFilesList,
    }),
    stat: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:host-files:stat",
      tag: WS_METHODS.hostFilesStat,
    }),
    mkdir: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:host-files:mkdir",
      tag: WS_METHODS.hostFilesMkdir,
    }),
    rename: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:host-files:rename",
      tag: WS_METHODS.hostFilesRename,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:host-files:delete",
      tag: WS_METHODS.hostFilesDelete,
    }),
    createDownloadUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:host-files:create-download-url",
      tag: WS_METHODS.hostFilesCreateDownloadUrl,
    }),
    createUploadUrl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:host-files:create-upload-url",
      tag: WS_METHODS.hostFilesCreateUploadUrl,
    }),
  };
}

export interface HostPathCrumb {
  readonly name: string;
  readonly path: string;
}

/** `/home/me/src` -> `/`, `home`, `me`, `src`, each with its absolute path. */
export function hostPathCrumbs(path: string): ReadonlyArray<HostPathCrumb> {
  const parts = path.split("/").filter((part) => part.length > 0);
  const crumbs: HostPathCrumb[] = [{ name: "/", path: "/" }];
  let current = "";
  for (const part of parts) {
    current = `${current}/${part}`;
    crumbs.push({ name: part, path: current });
  }
  return crumbs;
}

export function joinHostPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/** Shows `~` for the home directory so paths read the way the terminal prints them. */
export function displayHostPath(path: string, homePath: string | null): string {
  if (homePath === null || homePath === "/") return path;
  if (path === homePath) return "~";
  return path.startsWith(`${homePath}/`) ? `~${path.slice(homePath.length)}` : path;
}

export function isHostDirectoryEntry(entry: HostFileEntry): boolean {
  return entry.kind === "directory" || entry.targetKind === "directory";
}

export function isHiddenHostEntry(entry: Pick<HostFileEntry, "name">): boolean {
  return entry.name.startsWith(".");
}

export function hostFilesFailureMessage(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "HostFilesError" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "EnvironmentAuthorizationError") {
      return "This connection is not allowed to manage server files.";
    }
  }
  return fallback;
}

export function hostFilesFailureKind(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "HostFilesError" &&
    "failure" in error &&
    typeof error.failure === "string"
    ? error.failure
    : null;
}

export function formatHostFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
