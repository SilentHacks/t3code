import {
  displayHostPath,
  formatHostFileSize,
  hostFilesFailureKind,
  hostFilesFailureMessage,
  hostPathCrumbs,
  isHiddenHostEntry,
  isHostDirectoryEntry,
  joinHostPath,
} from "@t3tools/client-runtime/state/hostFiles";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  HostFileEntry,
  HostFilesListResult,
  HostFilesUploadConflict,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ArrowUp,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FileSymlink,
  Folder,
  FolderPlus,
  FolderSymlink,
  Home,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { hostFilesEnvironment, useHostFilesAccess } from "~/state/hostFiles";
import { readPreparedConnection } from "~/state/session";

let uploadSequence = 0;
function nextUploadId(name: string): string {
  uploadSequence += 1;
  return `${name}:${uploadSequence}`;
}

/** Resolves to the failure message, or null when the upload finished or was cancelled. */
async function settleUpload(done: Promise<unknown>): Promise<string | null> {
  try {
    await done;
    return null;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Upload failed";
    return message === "Upload cancelled" ? null : message;
  }
}
const SHOW_HIDDEN_STORAGE_KEY = "t3code:host-files:show-hidden";
const LAST_PATH_STORAGE_KEY = "t3code:host-files:last-path";

interface HostFilesBrowserProps {
  environmentId: EnvironmentId;
  /** Path to open first; defaults to the last visited folder, then `~`. */
  initialPath?: string | null;
  /** Bumped to navigate to `initialPath` again while mounted. */
  initialPathRevealId?: number;
  selectedPath?: string | null;
  onOpenFile: (absolutePath: string) => void;
}

interface UploadItem {
  readonly id: string;
  readonly name: string;
  readonly progress: number;
  readonly abort: () => void;
}

interface ConflictPrompt {
  readonly names: ReadonlyArray<string>;
  readonly resolve: (choice: HostFilesUploadConflict | null) => void;
}

const runCommand = <W, A, E>(command: Parameters<typeof runAtomCommand<W, A, E>>[1], input: W) =>
  runAtomCommand(appAtomRegistry, command, input, { reportFailure: false, reportDefect: false });

function resolveTransferUrl(environmentId: EnvironmentId, relativeUrl: string): string | null {
  const connection = readPreparedConnection(environmentId);
  return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
}

function entryIcon(entry: HostFileEntry) {
  if (entry.kind === "symlink") {
    return entry.targetKind === "directory" ? FolderSymlink : FileSymlink;
  }
  return entry.kind === "directory" ? Folder : File;
}

function formatModified(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? { hour: "2-digit", minute: "2-digit" } : { year: "numeric" }),
  });
}

function postUpload(
  url: string,
  file: globalThis.File,
  onProgress: (progress: number) => void,
): { readonly done: Promise<void>; readonly abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    });
    xhr.addEventListener("load", () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(xhr.responseText || `Upload rejected (${xhr.status})`)),
    );
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

function ToolbarButton(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function HostFilesBrowser(props: HostFilesBrowserProps) {
  const { environmentId, onOpenFile } = props;
  const canManage = useHostFilesAccess(environmentId);
  const [showHidden, setShowHidden] = useLocalStorage(
    SHOW_HIDDEN_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [lastPath, setLastPath] = useLocalStorage(LAST_PATH_STORAGE_KEY, "~", Schema.String);
  const [listing, setListing] = useState<HostFilesListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<HostFileEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<ReadonlyArray<HostFileEntry> | null>(null);
  const [uploads, setUploads] = useState<ReadonlyArray<UploadItem>>([]);
  const [conflict, setConflict] = useState<ConflictPrompt | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const generation = useRef(0);

  const navigate = async (path: string, options: { keepSelection?: boolean } = {}) => {
    const current = ++generation.current;
    setLoading(true);
    const result = await runCommand(hostFilesEnvironment.list, {
      environmentId,
      input: { path },
    });
    if (current !== generation.current) return false;
    setLoading(false);
    if (result._tag === "Success") {
      setListing(result.value);
      setError(null);
      setPathDraft(null);
      setLastPath(result.value.path);
      if (!options.keepSelection) {
        setSelection(new Set());
        setAnchor(null);
      }
      return true;
    }
    setError(hostFilesFailureMessage(squashAtomCommandFailure(result), "Could not open folder."));
    return false;
  };

  const currentPath = listing?.path ?? null;
  const refresh = () => (currentPath ? navigate(currentPath, { keepSelection: true }) : undefined);

  // Navigate on mount and when asked to reveal a path; not on every visit.
  const openStartPath = useEffectEvent(
    (initialPath: string | null | undefined, _revealId: number | undefined) => {
      const startPath = initialPath ?? lastPath;
      void navigate(startPath).then((ok) => {
        if (!ok && startPath !== "~") void navigate("~");
      });
    },
  );
  const revealId = props.initialPathRevealId;
  useEffect(() => {
    if (!canManage) return;
    // oxlint-disable-next-line react/set-state-in-effect -- loading a listing is an async server fetch that must start after mount.
    openStartPath(props.initialPath, revealId);
  }, [canManage, props.initialPath, revealId]);

  const visibleEntries = (listing?.entries ?? []).filter(
    (entry) => showHidden || !isHiddenHostEntry(entry),
  );
  const selectedEntries = visibleEntries.filter((entry) => selection.has(entry.path));

  const openEntry = (entry: HostFileEntry) => {
    if (isHostDirectoryEntry(entry)) void navigate(entry.path);
    else if (entry.kind === "symlink" && entry.targetKind === null) {
      toastManager.add({ type: "error", title: "Broken link", description: entry.symlinkTarget });
    } else onOpenFile(entry.path);
  };

  const download = async (entry: HostFileEntry) => {
    const result = await runCommand(hostFilesEnvironment.createDownloadUrl, {
      environmentId,
      input: { path: entry.path },
    });
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: "Download failed",
        description: hostFilesFailureMessage(squashAtomCommandFailure(result), entry.path),
      });
      return;
    }
    const url = resolveTransferUrl(environmentId, result.value.relativeUrl);
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = result.value.name;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  };

  const copyPath = async (path: string) => {
    await writeTextToClipboard(path);
    toastManager.add({ type: "success", title: "Path copied", description: path });
  };

  const confirmDelete = async () => {
    const targets = pendingDelete;
    setPendingDelete(null);
    if (!targets || targets.length === 0) return;
    const result = await runCommand(hostFilesEnvironment.remove, {
      environmentId,
      input: { paths: targets.map((entry) => entry.path) },
    });
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: "Delete failed",
        description: hostFilesFailureMessage(squashAtomCommandFailure(result), "Delete failed."),
      });
    }
    void refresh();
  };

  const submitRename = async () => {
    const entry = renaming;
    const name = renameDraft.trim();
    setRenaming(null);
    if (!entry || !currentPath || name.length === 0 || name === entry.name) return;
    const to =
      name.startsWith("/") || name.startsWith("~") ? name : joinHostPath(currentPath, name);
    const result = await runCommand(hostFilesEnvironment.rename, {
      environmentId,
      input: { from: entry.path, to },
    });
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: "Rename failed",
        description: hostFilesFailureMessage(squashAtomCommandFailure(result), "Rename failed."),
      });
      return;
    }
    await refresh();
    setSelection(new Set([result.value.path]));
  };

  const submitNewFolder = async () => {
    const name = folderDraft.trim();
    setCreatingFolder(false);
    setFolderDraft("");
    if (!currentPath || name.length === 0) return;
    const result = await runCommand(hostFilesEnvironment.mkdir, {
      environmentId,
      input: { path: joinHostPath(currentPath, name) },
    });
    if (result._tag !== "Success") {
      toastManager.add({
        type: "error",
        title: "Could not create folder",
        description: hostFilesFailureMessage(squashAtomCommandFailure(result), name),
      });
      return;
    }
    await refresh();
    setSelection(new Set([result.value.path]));
  };

  const askConflict = (names: ReadonlyArray<string>) =>
    new Promise<HostFilesUploadConflict | null>((resolve) => setConflict({ names, resolve }));

  const uploadFiles = async (files: ReadonlyArray<globalThis.File>) => {
    if (!currentPath || files.length === 0) return;
    const directory = currentPath;
    const existing = new Set(listing?.entries.map((entry) => entry.name) ?? []);
    const clashes = files.filter((file) => existing.has(file.name)).map((file) => file.name);
    let policy: HostFilesUploadConflict = "fail";
    if (clashes.length > 0) {
      const choice = await askConflict(clashes);
      if (choice === null) return;
      policy = choice;
    }
    await Promise.all(
      files.map(async (file) => {
        const issued = await runCommand(hostFilesEnvironment.createUploadUrl, {
          environmentId,
          input: { directory, name: file.name, sizeBytes: file.size, conflict: policy },
        });
        if (issued._tag !== "Success") {
          const failure = squashAtomCommandFailure(issued);
          toastManager.add({
            type: "error",
            title: `Could not upload ${file.name}`,
            description:
              hostFilesFailureKind(failure) === "already_exists"
                ? "A file with that name already exists."
                : hostFilesFailureMessage(failure, "Upload failed."),
          });
          return;
        }
        const url = resolveTransferUrl(environmentId, issued.value.relativeUrl);
        if (!url) return;
        const id = nextUploadId(file.name);
        const transfer = postUpload(url, file, (progress) =>
          setUploads((items) =>
            items.map((item) => (item.id === id ? { ...item, progress } : item)),
          ),
        );
        setUploads((items) => [
          ...items,
          { id, name: file.name, progress: 0, abort: transfer.abort },
        ]);
        const uploadError = await settleUpload(transfer.done);
        setUploads((items) => items.filter((item) => item.id !== id));
        if (uploadError !== null) {
          toastManager.add({
            type: "error",
            title: `Could not upload ${file.name}`,
            description: uploadError,
          });
        }
      }),
    );
    if (generation.current > 0 && listing?.path === directory) void refresh();
  };

  const selectEntry = (
    entry: HostFileEntry,
    event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => {
    if (event.shiftKey && anchor) {
      const from = visibleEntries.findIndex((item) => item.path === anchor);
      const to = visibleEntries.findIndex((item) => item.path === entry.path);
      if (from >= 0 && to >= 0) {
        const [start, end] = from < to ? [from, to] : [to, from];
        setSelection(new Set(visibleEntries.slice(start, end + 1).map((item) => item.path)));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      setSelection((previous) => {
        const next = new Set(previous);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
    } else {
      setSelection(new Set([entry.path]));
    }
    setAnchor(entry.path);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const focusIndex = anchor ? visibleEntries.findIndex((entry) => entry.path === anchor) : -1;
    const focusEntry = focusIndex >= 0 ? visibleEntries[focusIndex] : undefined;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (event.key === "ArrowUp" && (event.metaKey || event.altKey) && listing?.parentPath) {
        event.preventDefault();
        void navigate(listing.parentPath);
        return;
      }
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next =
        visibleEntries[Math.min(Math.max(focusIndex + delta, 0), visibleEntries.length - 1)];
      if (next) {
        setSelection(new Set([next.path]));
        setAnchor(next.path);
        listRef.current
          ?.querySelector(`[data-path="${CSS.escape(next.path)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      }
    } else if (event.key === "Enter" && focusEntry) {
      event.preventDefault();
      openEntry(focusEntry);
    } else if (event.key === "Backspace" && !event.metaKey && listing?.parentPath) {
      event.preventDefault();
      void navigate(listing.parentPath);
    } else if (
      (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) &&
      selectedEntries.length > 0
    ) {
      event.preventDefault();
      setPendingDelete(selectedEntries);
    } else if (event.key === "F2" && focusEntry) {
      event.preventDefault();
      setRenaming(focusEntry);
      setRenameDraft(focusEntry.name);
    } else if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      setSelection(new Set(visibleEntries.map((entry) => entry.path)));
    } else if (event.key === "Escape") {
      setSelection(new Set());
    }
  };

  if (!canManage) {
    return (
      <div className="p-4 text-xs leading-relaxed text-muted-foreground">
        This connection cannot browse server files. Server files need terminal access on this
        environment.
      </div>
    );
  }

  const homePath = listing?.homePath ?? null;
  const crumbs = currentPath ? hostPathCrumbs(currentPath) : [];

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-1 flex-col bg-background",
        dragging && "ring-2 ring-primary/60 ring-inset",
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        void uploadFiles([...event.dataTransfer.files]);
      }}
    >
      <div className="flex h-10 min-h-10 shrink-0 items-center gap-0.5 border-b border-border/60 px-2">
        <ToolbarButton
          label="Up one folder"
          disabled={!listing?.parentPath}
          onClick={() => listing?.parentPath && void navigate(listing.parentPath)}
        >
          <ArrowUp />
        </ToolbarButton>
        <ToolbarButton label="Home folder" onClick={() => void navigate("~")}>
          <Home />
        </ToolbarButton>
        <ToolbarButton label="Refresh" onClick={() => void refresh()}>
          <RefreshCw className={cn(loading && "animate-spin")} />
        </ToolbarButton>
        <div className="min-w-0 flex-1" />
        <ToolbarButton
          label={showHidden ? "Hide hidden files" : "Show hidden files"}
          onClick={() => setShowHidden(!showHidden)}
        >
          {showHidden ? <Eye /> : <EyeOff />}
        </ToolbarButton>
        <ToolbarButton
          label="New folder"
          disabled={!currentPath}
          onClick={() => setCreatingFolder(true)}
        >
          <FolderPlus />
        </ToolbarButton>
        <ToolbarButton
          label="Upload files"
          disabled={!currentPath}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload />
        </ToolbarButton>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const files = [...(event.currentTarget.files ?? [])];
            event.currentTarget.value = "";
            void uploadFiles(files);
          }}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1">
        {pathDraft === null ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center overflow-x-auto rounded-md px-1 py-0.5 text-left font-mono text-xs text-muted-foreground hover:bg-accent/60"
            aria-label="Edit path"
            onClick={(event) => {
              if (event.target === event.currentTarget)
                setPathDraft(displayHostPath(currentPath ?? "~", homePath));
            }}
            onDoubleClick={() => setPathDraft(displayHostPath(currentPath ?? "~", homePath))}
          >
            {crumbs.map((crumb, index) => (
              <span key={crumb.path} className="flex shrink-0 items-center">
                {index > 1 ? <span className="px-0.5 text-muted-foreground/60">/</span> : null}
                <span
                  role="link"
                  tabIndex={-1}
                  className={cn(
                    "rounded px-0.5 hover:text-foreground hover:underline",
                    index === crumbs.length - 1 && "text-foreground",
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    void navigate(crumb.path);
                  }}
                >
                  {crumb.name}
                </span>
              </span>
            ))}
            <span
              className="ml-1 min-w-4 flex-1 self-stretch"
              onClick={(event) => {
                event.stopPropagation();
                setPathDraft(displayHostPath(currentPath ?? "~", homePath));
              }}
            />
          </button>
        ) : (
          <form
            className="flex min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              void navigate(pathDraft.trim() || "~");
            }}
          >
            <Input
              autoFocus
              size="sm"
              aria-label="Go to path"
              value={pathDraft}
              placeholder="/path/to/folder or ~/folder"
              onChange={(event) => setPathDraft(event.currentTarget.value)}
              onBlur={() => setPathDraft(null)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setPathDraft(null);
              }}
            />
          </form>
        )}
      </div>
      {error ? (
        <div role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {listing?.truncated ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          Showing the first {listing.entries.length.toLocaleString()} entries.
        </div>
      ) : null}
      <div
        ref={listRef}
        role="listbox"
        aria-label="Server files"
        aria-multiselectable
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
        onKeyDown={onListKeyDown}
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelection(new Set());
        }}
      >
        {listing && visibleEntries.length === 0 && !error ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {listing.entries.length > 0 ? "Only hidden files here." : "This folder is empty."}
            <div className="mt-1">Drop files here to upload.</div>
          </div>
        ) : null}
        {visibleEntries.map((entry) => {
          const Icon = entryIcon(entry);
          const selected = selection.has(entry.path) || entry.path === props.selectedPath;
          const directory = isHostDirectoryEntry(entry);
          return (
            <div
              key={entry.path}
              role="option"
              aria-selected={selected}
              data-path={entry.path}
              className={cn(
                "group flex h-7 cursor-default items-center gap-2 px-2 text-sm select-none",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                isHiddenHostEntry(entry) && "opacity-70",
              )}
              onClick={(event) => {
                listRef.current?.focus();
                selectEntry(entry, event);
                // Files preview on a plain click like the project tree; folders open on
                // double-click so they can still be selected for actions.
                if (!directory && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
                  openEntry(entry);
                }
              }}
              onDoubleClick={() => openEntry(entry)}
              onContextMenu={() => {
                if (!selection.has(entry.path)) setSelection(new Set([entry.path]));
                setAnchor(entry.path);
              }}
            >
              <Icon
                className={cn(
                  "size-4 shrink-0",
                  directory ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="min-w-0 flex-1 truncate">
                {entry.name}
                {entry.kind === "symlink" ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    → {entry.symlinkTarget}
                  </span>
                ) : null}
              </span>
              <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums @[22rem]:inline sm:inline">
                {directory ? "" : formatHostFileSize(entry.sizeBytes)}
              </span>
              <span className="hidden w-24 shrink-0 truncate text-right text-xs text-muted-foreground md:inline">
                {formatModified(entry.modifiedAt)}
              </span>
              <span
                className="flex opacity-0 group-hover:opacity-100 has-aria-expanded:opacity-100"
                // Menu items render in a portal, but React still bubbles their events to this row.
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-micro"
                        aria-label={`Actions for ${entry.name}`}
                        onClick={(event) => event.stopPropagation()}
                      />
                    }
                  >
                    <MoreHorizontal />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => openEntry(entry)}>
                      {directory ? <Folder /> : <File />}
                      Open
                    </MenuItem>
                    <MenuItem onClick={() => void download(entry)}>
                      <Download />
                      {directory ? "Download as .tar.gz" : "Download"}
                    </MenuItem>
                    <MenuItem onClick={() => void copyPath(entry.path)}>
                      <Copy />
                      Copy path
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      onClick={() => {
                        setRenaming(entry);
                        setRenameDraft(entry.name);
                      }}
                    >
                      <Pencil />
                      Rename or move…
                    </MenuItem>
                    <MenuItem
                      variant="destructive"
                      onClick={() =>
                        setPendingDelete(
                          selection.has(entry.path) && selectedEntries.length > 1
                            ? selectedEntries
                            : [entry],
                        )
                      }
                    >
                      <Trash2 />
                      {selection.has(entry.path) && selectedEntries.length > 1
                        ? `Delete ${selectedEntries.length} items…`
                        : "Delete…"}
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </span>
            </div>
          );
        })}
      </div>
      {uploads.length > 0 ? (
        <div className="shrink-0 border-t border-border/60 px-2 py-1.5">
          {uploads.map((upload) => (
            <div key={upload.id} className="flex items-center gap-2 py-0.5 text-xs">
              <Upload className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{upload.name}</span>
              <div className="h-1 w-20 overflow-hidden rounded bg-muted">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${Math.round(upload.progress * 100)}%` }}
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-micro"
                aria-label={`Cancel ${upload.name}`}
                onClick={upload.abort}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete{" "}
              {pendingDelete?.length === 1
                ? `"${pendingDelete[0]?.name}"`
                : `${pendingDelete?.length ?? 0} items`}{" "}
              permanently?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Folders are deleted with everything inside them; links are
              removed without touching what they point to.
            </AlertDialogDescription>
            <ul className="max-h-40 overflow-y-auto rounded-md border border-border/60 px-2 py-1 font-mono text-xs">
              {pendingDelete?.map((entry) => (
                <li key={entry.path} className="truncate">
                  {displayHostPath(entry.path, homePath)}
                  {isHostDirectoryEntry(entry) && entry.kind === "directory" ? "/" : ""}
                </li>
              ))}
            </ul>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <AlertDialogPopup initialFocus={renameInputRef}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitRename();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>Rename or move</AlertDialogTitle>
              <AlertDialogDescription>
                Enter a new name, or an absolute path to move it. Existing files are never replaced.
              </AlertDialogDescription>
              <Input
                autoFocus
                ref={renameInputRef}
                aria-label="New name"
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.currentTarget.value)}
              />
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </AlertDialogClose>
              <Button type="submit">Rename</Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog open={creatingFolder} onOpenChange={(open) => !open && setCreatingFolder(false)}>
        <AlertDialogPopup initialFocus={folderInputRef}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitNewFolder();
            }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>New folder</AlertDialogTitle>
              <AlertDialogDescription>
                In {displayHostPath(currentPath ?? "~", homePath)}
              </AlertDialogDescription>
              <Input
                autoFocus
                ref={folderInputRef}
                aria-label="Folder name"
                value={folderDraft}
                placeholder="untitled folder"
                onChange={(event) => setFolderDraft(event.currentTarget.value)}
              />
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button type="button" variant="outline" />}>
                Cancel
              </AlertDialogClose>
              <Button type="submit">Create</Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogPopup>
      </AlertDialog>

      <AlertDialog
        open={conflict !== null}
        onOpenChange={(open) => {
          if (!open && conflict) {
            conflict.resolve(null);
            setConflict(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {conflict?.names.length === 1
                ? `"${conflict.names[0]}" already exists`
                : `${conflict?.names.length ?? 0} files already exist`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Replace the existing {conflict?.names.length === 1 ? "file" : "files"}, or keep both
              by saving the upload with a numbered name.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="outline"
              onClick={() => {
                conflict?.resolve("keep-both");
                setConflict(null);
              }}
            >
              Keep both
            </Button>
            <Button
              onClick={() => {
                conflict?.resolve("replace");
                setConflict(null);
              }}
            >
              Replace
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
