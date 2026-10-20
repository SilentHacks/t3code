import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  displayHostPath,
  formatHostFileSize,
  hostFilesFailureMessage,
  isHiddenHostEntry,
  isHostDirectoryEntry,
  joinHostPath,
} from "@t3tools/client-runtime/state/hostFiles";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type HostFileEntry,
  type HostFilesListResult,
  type HostFilesUploadConflict,
} from "@t3tools/contracts";
import type { StaticScreenProps } from "@react-navigation/native";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog, showTextInputDialog } from "../../components/ConfirmDialogHost";
import { EmptyState } from "../../components/EmptyState";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ListSection } from "../../components/ListSection";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { hostFilesEnvironment } from "../../state/hostFiles";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;

export function ServerFilesRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId; readonly path?: string }>) {
  return (
    <ServerFiles
      key={route.params.environmentId}
      environmentId={route.params.environmentId}
      initialPath={route.params.path ?? "~"}
    />
  );
}

function ServerFiles(props: {
  readonly environmentId: EnvironmentId;
  readonly initialPath: string;
}) {
  const { environmentId } = props;
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const list = useAtomCommand(hostFilesEnvironment.list, COMMAND_OPTIONS);
  const mkdir = useAtomCommand(hostFilesEnvironment.mkdir, COMMAND_OPTIONS);
  const rename = useAtomCommand(hostFilesEnvironment.rename, COMMAND_OPTIONS);
  const remove = useAtomCommand(hostFilesEnvironment.remove, COMMAND_OPTIONS);
  const createDownloadUrl = useAtomCommand(hostFilesEnvironment.createDownloadUrl, COMMAND_OPTIONS);
  const createUploadUrl = useAtomCommand(hostFilesEnvironment.createUploadUrl, COMMAND_OPTIONS);
  const [listing, setListing] = useState<HostFilesListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const generation = useRef(0);
  const allowed = useEnvironmentScope(environmentId, AuthTerminalOperateScope);

  const navigate = useCallback(
    async (path: string) => {
      const current = ++generation.current;
      setLoading(true);
      const result = await list({ environmentId, input: { path } });
      if (current !== generation.current) return;
      setLoading(false);
      if (result._tag === "Success") {
        setListing(result.value);
        setError(null);
      } else {
        setError(
          hostFilesFailureMessage(squashAtomCommandFailure(result), "Could not open folder."),
        );
      }
    },
    [environmentId, list],
  );

  useEffect(() => {
    if (allowed) void navigate(props.initialPath);
  }, [allowed, navigate, props.initialPath]);

  const currentPath = listing?.path ?? null;
  const refresh = useCallback(() => {
    if (currentPath) void navigate(currentPath);
  }, [currentPath, navigate]);

  const entries = useMemo(
    () => (listing?.entries ?? []).filter((entry) => showHidden || !isHiddenHostEntry(entry)),
    [listing, showHidden],
  );

  const reportFailure = (title: string, result: Parameters<typeof squashAtomCommandFailure>[0]) =>
    Alert.alert(title, hostFilesFailureMessage(squashAtomCommandFailure(result), "Try again."));

  const share = async (entry: HostFileEntry) => {
    if (httpBaseUrl === null) {
      Alert.alert("Not connected", "Reconnect to the environment and try again.");
      return;
    }
    setBusy(entry.path);
    try {
      const result = await createDownloadUrl({ environmentId, input: { path: entry.path } });
      if (result._tag !== "Success") {
        reportFailure("Could not download", result);
        return;
      }
      const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
      if (url === null) throw new Error("Reconnect to the environment and try again.");
      await downloadAndShareAttachment({
        url,
        attachment: {
          name: result.value.name,
          mimeType: isHostDirectoryEntry(entry) ? "application/gzip" : "application/octet-stream",
        },
        signal: new AbortController().signal,
      });
    } catch (cause) {
      Alert.alert("Could not download", cause instanceof Error ? cause.message : "Try again.");
    } finally {
      setBusy(null);
    }
  };

  const promptRename = (entry: HostFileEntry) =>
    showTextInputDialog({
      title: "Rename or move",
      initialValue: entry.name,
      confirmText: "Rename",
      onConfirm: (value) => {
        const name = value.trim();
        if (!currentPath || name.length === 0 || name === entry.name) return;
        const to =
          name.startsWith("/") || name.startsWith("~") ? name : joinHostPath(currentPath, name);
        void rename({ environmentId, input: { from: entry.path, to } }).then((result) => {
          if (result._tag !== "Success") reportFailure("Could not rename", result);
          refresh();
        });
      },
    });

  const promptDelete = (entry: HostFileEntry) =>
    showConfirmDialog({
      title: `Delete "${entry.name}" permanently?`,
      message:
        entry.kind === "directory"
          ? "The folder and everything inside it will be deleted. This cannot be undone."
          : "This cannot be undone.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        void remove({ environmentId, input: { paths: [entry.path] } }).then((result) => {
          if (result._tag !== "Success") reportFailure("Could not delete", result);
          refresh();
        });
      },
    });

  const showActions = (entry: HostFileEntry) => {
    const directory = isHostDirectoryEntry(entry);
    // Android dialogs hold at most three buttons, so secondary actions nest.
    Alert.alert(
      entry.name,
      displayHostPath(entry.path, listing?.homePath ?? null),
      [
        { text: directory ? "Download .tar.gz" : "Share", onPress: () => void share(entry) },
        { text: "Copy path", onPress: () => copyTextWithHaptic(entry.path) },
        {
          text: "More…",
          onPress: () =>
            Alert.alert(entry.name, undefined, [
              { text: "Rename or move", onPress: () => promptRename(entry) },
              { text: "Delete", style: "destructive", onPress: () => promptDelete(entry) },
              { text: "Cancel", style: "cancel" },
            ]),
        },
      ],
      { cancelable: true },
    );
  };

  const promptNewFolder = () =>
    showTextInputDialog({
      title: "New folder",
      initialValue: "",
      confirmText: "Create",
      onConfirm: (value) => {
        const name = value.trim();
        if (!currentPath || name.length === 0) return;
        void mkdir({ environmentId, input: { path: joinHostPath(currentPath, name) } }).then(
          (result) => {
            if (result._tag !== "Success") reportFailure("Could not create folder", result);
            refresh();
          },
        );
      },
    });

  const promptGoTo = () =>
    showTextInputDialog({
      title: "Go to path",
      initialValue: displayHostPath(currentPath ?? "~", listing?.homePath ?? null),
      confirmText: "Open",
      onConfirm: (value) => void navigate(value.trim() || "~"),
    });

  const askConflict = (names: ReadonlyArray<string>) =>
    new Promise<HostFilesUploadConflict | null>((resolve) =>
      Alert.alert(
        names.length === 1 ? `"${names[0]}" already exists` : `${names.length} files already exist`,
        "Replace them, or keep both with a numbered name.",
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(null) },
          { text: "Keep both", onPress: () => resolve("keep-both") },
          { text: "Replace", style: "destructive", onPress: () => resolve("replace") },
        ],
        { cancelable: true, onDismiss: () => resolve(null) },
      ),
    );

  const upload = async () => {
    if (!currentPath || httpBaseUrl === null) return;
    const directory = currentPath;
    const { getDocumentAsync } = await import("expo-document-picker");
    const picked = await getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (picked.canceled || picked.assets.length === 0) return;
    const existing = new Set(listing?.entries.map((entry) => entry.name) ?? []);
    const clashes = picked.assets.filter((asset) => existing.has(asset.name)).map((a) => a.name);
    let conflict: HostFilesUploadConflict = "fail";
    if (clashes.length > 0) {
      const choice = await askConflict(clashes);
      if (choice === null) return;
      conflict = choice;
    }
    const { File, UploadType } = await import("expo-file-system");
    for (const [index, asset] of picked.assets.entries()) {
      setBusy(`Uploading ${index + 1} of ${picked.assets.length}…`);
      const file = new File(asset.uri);
      const issued = await createUploadUrl({
        environmentId,
        input: { directory, name: asset.name, sizeBytes: asset.size ?? file.size, conflict },
      });
      if (issued._tag !== "Success") {
        reportFailure(`Could not upload ${asset.name}`, issued);
        continue;
      }
      const uploadUrl = resolveAssetUrl(httpBaseUrl, issued.value.relativeUrl);
      if (uploadUrl === null) continue;
      try {
        const result = await file.upload(uploadUrl, {
          httpMethod: "POST",
          uploadType: UploadType.BINARY_CONTENT,
          headers: { "Content-Type": "application/octet-stream" },
        });
        if (result.status < 200 || result.status >= 300) {
          Alert.alert(`Could not upload ${asset.name}`, result.body || `Status ${result.status}`);
        }
      } catch (cause) {
        Alert.alert(`Could not upload ${asset.name}`, cause instanceof Error ? cause.message : "");
      }
    }
    setBusy(null);
    refresh();
  };

  const homePath = listing?.homePath ?? null;
  const title = currentPath ? displayHostPath(currentPath, homePath) : "Server files";

  return (
    <SettingsScreen
      title={title}
      actions={
        allowed
          ? [
              {
                accessibilityLabel: "Up one folder",
                icon: "arrow.up",
                disabled: !listing?.parentPath,
                onPress: () => listing?.parentPath && void navigate(listing.parentPath),
              },
              { accessibilityLabel: "Go to path", icon: "magnifyingglass", onPress: promptGoTo },
              {
                accessibilityLabel: showHidden ? "Hide hidden files" : "Show hidden files",
                icon: showHidden ? "eye" : "eye.slash",
                onPress: () => setShowHidden((value) => !value),
              },
              {
                accessibilityLabel: "New folder",
                icon: "folder.badge.plus",
                disabled: !currentPath,
                onPress: promptNewFolder,
              },
              {
                accessibilityLabel: "Upload files",
                icon: "tray.and.arrow.up",
                disabled: !currentPath || busy !== null,
                loading: busy !== null,
                onPress: () => void upload(),
              },
            ]
          : undefined
      }
    >
      {!allowed ? (
        <EmptyState
          title="Server files unavailable"
          detail="This connection needs terminal access on the environment to browse its files."
        />
      ) : (
        <ListSection
          title={currentPath ?? undefined}
          {...(listing?.truncated
            ? { footer: `Showing the first ${listing.entries.length} entries.` }
            : {})}
        >
          {error ? <Text className="px-2 text-sm text-destructive">{error}</Text> : null}
          {loading && listing === null ? <ActivityIndicator /> : null}
          {listing && entries.length === 0 && !error ? (
            <Text className="px-2 py-4 text-center text-sm text-foreground-muted">
              This folder is empty.
            </Text>
          ) : null}
          {entries.map((entry) => {
            const directory = isHostDirectoryEntry(entry);
            return (
              <Pressable
                key={entry.path}
                accessibilityRole="button"
                accessibilityLabel={entry.name}
                accessibilityHint={directory ? "Opens the folder" : "Shows file actions"}
                onPress={() => (directory ? void navigate(entry.path) : showActions(entry))}
                onLongPress={() => showActions(entry)}
              >
                <ListRowLayout
                  icon={directory ? "folder" : entry.kind === "symlink" ? "link" : "doc"}
                  label={entry.name}
                  {...(entry.kind === "symlink" && entry.symlinkTarget
                    ? { description: `→ ${entry.symlinkTarget}` }
                    : {})}
                  {...(directory ? {} : { detail: formatHostFileSize(entry.sizeBytes) })}
                  accessory={busy === entry.path ? <ActivityIndicator /> : undefined}
                />
              </Pressable>
            );
          })}
          {listing ? <View className="h-2" /> : null}
        </ListSection>
      )}
    </SettingsScreen>
  );
}
