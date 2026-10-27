import type { VcsStatusResult } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Native header item factories are only read when options are applied, so the fake
// navigation snapshots the right items at each setOptions, as native-stack does.
const harness = vi.hoisted(() => ({
  setOptionsCalls: 0,
  renderedRightItems: [] as Array<ReadonlyArray<Record<string, unknown>>>,
  navigatedRoutes: [] as string[],
}));

vi.mock("@react-navigation/native", async () => {
  const { createContext } = await import("react");
  const navigation = {
    canGoBack: () => true,
    dispatch: () => {},
    goBack: () => {},
    navigate: (route: string) => {
      harness.navigatedRoutes.push(route);
    },
    addListener: () => () => {},
    setOptions: (options: { unstable_headerRightItems?: () => Array<Record<string, unknown>> }) => {
      harness.setOptionsCalls += 1;
      harness.renderedRightItems.push(options.unstable_headerRightItems?.() ?? []);
    },
  };
  return {
    NavigationContext: createContext(navigation),
    NavigationRouteContext: createContext({ key: "thread-1" }),
    StackActions: { replace: () => ({}) },
    useNavigation: () => navigation,
  };
});
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => () => {} }));
vi.mock("../../native/native-layout-metrics", () => ({ useDeviceType: () => "phone" }));
vi.mock("../../components/ui/Toolbar", () => ({ Toolbar: { Button: () => null } }));
vi.mock("../../components/ui/Dialog", () => ({ confirm: async () => true }));
vi.mock("../workspace/useAndroidWorkspaceNavigation", () => ({
  useWorkspaceBackNavigation: () => () => {},
}));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../components/ui/AppBar", async () => {
  const { NativeStackScreenOptions } = await import("../../native/StackHeader");
  return {
    AppBar: (props: import("../../components/ui/AppBar.types").AppBarProps) => (
      <NativeStackScreenOptions options={props.options} optionsVersion={props.optionsVersion} />
    ),
  };
});
vi.mock("react-native", () => ({ Alert: { alert: () => {} }, Linking: {}, Platform: {} }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: false },
    panes: { primarySidebarVisible: false, auxiliaryPaneVisible: false },
    togglePrimarySidebar: () => {},
    toggleAuxiliaryPane: () => {},
  }),
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: true,
  createNativeMailSearchToolbarItem: () => ({}),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeVariables: {} }),
}));

import { ThreadHeader } from "./ThreadHeader";

const projectScripts: never[] = [];

function status(
  files: ReadonlyArray<string>,
  overrides: Partial<VcsStatusResult> = {},
): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "master",
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files: files.map((path) => ({ path, insertions: 0, deletions: 0 })),
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  } as unknown as VcsStatusResult;
}

function Header(props: {
  readonly gitStatus: VcsStatusResult | null;
  readonly title?: string;
  readonly onSettleAndNewThread?: () => void;
}) {
  return (
    <ThreadHeader
      title={props.title ?? "Thread"}
      subtitle=""
      headerColor="#000"
      usesNativeHeaderGlass
      onSettleAndNewThread={props.onSettleAndNewThread}
      gitControls={{
        environmentId: "environment-1",
        threadId: "thread-1",
        currentBranch: "master",
        gitStatus: props.gitStatus,
        gitOperationLabel: null,
        onPull: async () => {},
        onRunAction: async () => null,
        canOpenTerminal: true,
        canOperateTerminal: true,
        canOpenFiles: true,
        projectScripts,
        terminalSessions: [],
        onOpenTerminal: () => {},
        onOpenNewTerminal: () => {},
        onRunProjectScript: async () => {},
      }}
      hasThreadCwd
      hasWorkspaceRoot
      fileInspectorSupported={false}
      inspectorMode={null}
      onToggleInspector={() => {}}
      onOpenGitInspector={() => {}}
      onOpenFilesInspector={() => {}}
    />
  );
}

let root: Root | null = null;

function render(element: React.ReactElement) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.setOptionsCalls = 0;
  harness.renderedRightItems = [];
  harness.navigatedRoutes = [];
});

describe("ThreadHeader", () => {
  it("refreshes the settle-and-new menu when settlement becomes available or unavailable", () => {
    const renderedThreadActions = () =>
      harness.renderedRightItems
        .at(-1)
        ?.find((item) => item.accessibilityLabel === "Thread actions");

    render(<Header gitStatus={status([])} />);
    expect(renderedThreadActions()).toBeUndefined();

    render(<Header gitStatus={status([])} onSettleAndNewThread={() => {}} />);
    expect(renderedThreadActions()).toMatchObject({
      menu: { items: [{ label: "Settle and start new thread" }] },
    });
    const applied = harness.setOptionsCalls;
    render(<Header gitStatus={status([])} onSettleAndNewThread={() => {}} />);
    expect(harness.setOptionsCalls).toBe(applied);

    render(<Header gitStatus={status([])} />);
    expect(renderedThreadActions()).toBeUndefined();
  });
});
