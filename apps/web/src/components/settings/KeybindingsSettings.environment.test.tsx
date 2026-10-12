import type { EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { resolveChatShortcutCommand } from "../../keybindings";

const state = vi.hoisted(() => ({
  canOperate: false,
  canWriteSettings: true,
  canWriteSecondary: false,
  primaryConnected: true,
  searchTarget: "",
  primaryBindings: [] as ResolvedKeybindingsConfig,
  secondaryBindings: [] as ResolvedKeybindingsConfig,
  openEditor: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "config-path" ? "/fixture/keybindings.json" : []),
}));

vi.mock("@tanstack/react-router", () => ({ useLocation: () => state.searchTarget }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../state/server", () => ({
  primaryServerKeybindingsAtom: "keybindings",
  primaryServerKeybindingsConfigPathAtom: "config-path",
  primaryServerAvailableEditorsAtom: "editors",
  serverEnvironment: { upsertKeybinding: state.upsert, removeKeybinding: state.remove },
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => ({
    environmentId: "primary-settings",
    label: "Primary Mac",
    connection: { phase: state.primaryConnected ? "connected" : "disconnected" },
    serverConfig: {
      keybindings: state.primaryBindings,
      keybindingsConfigPath: "/fixture/keybindings.json",
      availableEditors: [],
    },
  }),
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => {
    const environment = {
      environmentId: "secondary-settings",
      serverConfig: {
        keybindings: state.secondaryBindings,
        keybindingsConfigPath: "/secondary/keybindings.json",
        availableEditors: [],
      },
    };
    return { environment, connectedEnvironments: [environment] };
  },
}));

vi.mock("../../state/session", () => {
  const hasScope = (environmentId: EnvironmentId | null, scope: string) =>
    environmentId === "primary-settings"
      ? scope === "orchestration:operate"
        ? state.canOperate
        : scope === "settings:write" && state.canWriteSettings
      : environmentId === "secondary-settings" &&
        scope === "settings:write" &&
        state.canWriteSecondary;
  return {
    useEnvironmentScope: hasScope,
    readEnvironmentScope: hasScope,
    useEnvironmentsWithScope: (environments: readonly { environmentId: EnvironmentId }[]) =>
      new Set(
        environments
          .filter((environment) => hasScope(environment.environmentId, "settings:write"))
          .map((environment) => environment.environmentId),
      ),
  };
});

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));

vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: (environmentId: EnvironmentId) => (path: string) =>
    state.openEditor({ environmentId, path }),
}));

import { KeybindingsSettingsPanel } from "./KeybindingsSettings";

function renderPanel() {
  hooks.beginRender();
  return KeybindingsSettingsPanel();
}

function openButton(panel: unknown) {
  const button = visitElements(
    panel,
    (element) => element.props["aria-label"] === "Open keybindings.json",
  );
  if (!button) throw new Error("Missing Open keybindings.json action.");
  return button;
}

describe("KeybindingsSettings editor permission", () => {
  beforeEach(() => {
    hooks.reset();
    state.canOperate = false;
    state.canWriteSettings = true;
    state.canWriteSecondary = false;
    state.primaryConnected = true;
    state.searchTarget = "";
    state.primaryBindings = [];
    state.secondaryBindings = [];
    state.openEditor.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    state.upsert.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    state.remove.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  });

  it("rejects editor launches when settings writes are the only write grant", () => {
    const button = openButton(renderPanel());
    (button.props.onClick as () => void)();

    expect(state.openEditor).not.toHaveBeenCalled();
    expect(button.props.disabled).toBe(true);
  });

  it("opens the primary environment's file after operate is granted without settings writes", () => {
    state.canWriteSettings = false;
    renderPanel();
    state.canOperate = true;
    const button = openButton(renderPanel());
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();

    expect(state.openEditor).toHaveBeenCalledWith({
      environmentId: "primary-settings",
      path: "/fixture/keybindings.json",
    });
  });

  it("rejects a queued editor launch after operate is revoked", () => {
    state.canOperate = true;
    const open = openButton(renderPanel()).props.onClick as () => void;
    state.canOperate = false;
    open();

    expect(state.openEditor).not.toHaveBeenCalled();
    expect(openButton(renderPanel()).props.disabled).toBe(true);
  });

  function bindings(input: Parameters<typeof compileResolvedKeybindingsConfig>[0]) {
    return compileResolvedKeybindingsConfig(input);
  }

  function actions(panel = renderPanel()) {
    const groups = visitElements(panel, (element) => Array.isArray(element.props.groups));
    if (!groups) throw new Error("Missing keybinding groups.");
    return groups.props as unknown as {
      allRows: readonly import("./KeybindingsSettings.logic").KeybindingRow[];
      onSave: (input: import("@t3tools/contracts").ServerUpsertKeybindingInput) => void;
      onRemove: (row: import("./KeybindingsSettings.logic").KeybindingRow) => void;
      onReset: (row: import("./KeybindingsSettings.logic").KeybindingRow) => void;
    };
  }

  const remap = {
    key: "mod+shift+s",
    command: "thread.settleAndNew" as const,
    when: "!terminalFocus",
  };

  it("edits the runtime's application owner even when Settings selects a read-only secondary machine", async () => {
    state.secondaryBindings = bindings([remap]);
    const before = actions();
    expect(before.allRows.find((row) => row.command === remap.command)?.key).toBe(
      "mod+alt+shift+n",
    );
    state.upsert.mockImplementation(async (target) => {
      expect(target.environmentId).toBe("primary-settings");
      state.primaryBindings = bindings([{ key: "alt+ß", command: "thread.settle" }, target.input]);
      return { _tag: "Success", value: undefined };
    });

    before.onSave(remap);
    await vi.waitFor(() => expect(state.upsert).toHaveBeenCalledTimes(1));
    expect(state.upsert).toHaveBeenCalledWith({ environmentId: "primary-settings", input: remap });
    expect(actions().allRows.find((row) => row.command === remap.command)?.key).toBe("mod+shift+s");
    expect(
      resolveChatShortcutCommand(
        { key: "S", code: "KeyS", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false },
        mergeWithDefaultKeybindings(state.primaryBindings),
        mergeWithDefaultKeybindings(state.secondaryBindings),
        { platform: "MacIntel", context: { terminalFocus: false } },
      ),
    ).toBe("thread.settleAndNew");
  });

  it("removes and resets application overrides only on the primary connection", () => {
    state.primaryBindings = bindings([remap]);
    const current = actions();
    const row = current.allRows.find((row) => row.command === remap.command)!;
    current.onRemove(row);
    current.onReset(row);
    expect(state.remove).toHaveBeenCalledWith({ environmentId: "primary-settings", input: remap });
    expect(state.upsert).toHaveBeenCalledWith({
      environmentId: "primary-settings",
      input: { ...remap, key: "mod+alt+shift+n", replace: remap },
    });
  });

  it("does not use a writable secondary machine to bypass primary settings permissions", () => {
    state.canWriteSettings = false;
    state.canWriteSecondary = true;
    actions().onSave(remap);
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("rechecks the primary grant for queued writes", () => {
    const current = actions();
    const row = current.allRows.find((row) => row.command === remap.command)!;
    state.canWriteSettings = false;
    current.onSave(remap);
    current.onRemove(row);
    expect(state.upsert).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("never falls back to a secondary machine when the primary is disconnected", () => {
    state.primaryConnected = false;
    state.canWriteSecondary = true;
    const current = actions();
    current.onSave(remap);
    current.onRemove(current.allRows.find((row) => row.command === remap.command)!);
    expect(state.upsert).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
  });

  it("keeps script edits on the selected machine and excludes application commands", () => {
    const script = { key: "mod+r", command: "script.deploy.run" as const };
    state.secondaryBindings = bindings([script]);
    state.canWriteSecondary = true;
    state.searchTarget = "keybinding-script.deploy.run";
    const current = actions();
    expect(current.allRows.map((row) => row.command)).toEqual([script.command]);
    current.onSave(script);
    current.onRemove(current.allRows[0]!);
    expect(state.upsert).toHaveBeenCalledWith({
      environmentId: "secondary-settings",
      input: script,
    });
    expect(state.remove).toHaveBeenCalledWith({
      environmentId: "secondary-settings",
      input: script,
    });
  });
});
