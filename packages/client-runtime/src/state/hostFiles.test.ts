import { describe, expect, it } from "vite-plus/test";

import {
  displayHostPath,
  formatHostFileSize,
  hostFilesFailureMessage,
  hostPathCrumbs,
  isHostDirectoryEntry,
  joinHostPath,
} from "./hostFiles.ts";

describe("host files helpers", () => {
  it("splits absolute paths into navigable crumbs", () => {
    expect(hostPathCrumbs("/")).toEqual([{ name: "/", path: "/" }]);
    expect(hostPathCrumbs("/home/me")).toEqual([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "me", path: "/home/me" },
    ]);
  });

  it("joins and abbreviates paths the way a shell prints them", () => {
    expect(joinHostPath("/", "etc")).toBe("/etc");
    expect(joinHostPath("/home/me", "a b")).toBe("/home/me/a b");
    expect(displayHostPath("/home/me", "/home/me")).toBe("~");
    expect(displayHostPath("/home/me/src", "/home/me")).toBe("~/src");
    expect(displayHostPath("/home/meow", "/home/me")).toBe("/home/meow");
    expect(displayHostPath("/etc", null)).toBe("/etc");
  });

  it("treats links to folders as folders", () => {
    expect(
      isHostDirectoryEntry({ name: "l", path: "/l", kind: "symlink", targetKind: "directory" }),
    ).toBe(true);
    expect(isHostDirectoryEntry({ name: "f", path: "/f", kind: "file" })).toBe(false);
  });

  it("formats sizes and failures", () => {
    expect(formatHostFileSize(undefined)).toBe("");
    expect(formatHostFileSize(512)).toBe("512 B");
    expect(formatHostFileSize(1536)).toBe("1.5 KB");
    expect(formatHostFileSize(50 * 1024 * 1024)).toBe("50 MB");
    expect(hostFilesFailureMessage({ _tag: "HostFilesError", message: "nope" }, "x")).toBe("nope");
    expect(hostFilesFailureMessage(new Error("boom"), "fallback")).toBe("fallback");
  });
});
