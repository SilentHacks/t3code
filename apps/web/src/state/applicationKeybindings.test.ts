import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { resolveChatShortcutCommand } from "../keybindings";
import {
  createApplicationKeybindingsAtom,
  createApplicationKeybindingsEnvironmentIdAtom,
} from "./applicationKeybindings";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");
const OTHER = EnvironmentId.make("other");
const chord = {
  key: "S",
  code: "KeyS",
  metaKey: true,
  ctrlKey: false,
  shiftKey: true,
  altKey: false,
};
const options = { platform: "MacIntel", context: { terminalFocus: false } };
const remap = compileResolvedKeybindingsConfig([
  { key: "mod+shift+s", command: "thread.settleAndNew", when: "!terminalFocus" },
]);

function catalogState(
  ids: readonly EnvironmentId[],
  disabled: readonly EnvironmentId[] = [],
): EnvironmentCatalogState {
  return {
    isReady: true,
    entries: new Map(
      ids.map((environmentId) => [
        environmentId,
        {
          target:
            environmentId === LOCAL
              ? new PrimaryConnectionTarget({
                  environmentId,
                  label: "Local Mac",
                  httpBaseUrl: "http://local",
                  wsBaseUrl: "ws://local",
                })
              : new BearerConnectionTarget({
                  environmentId,
                  connectionId: environmentId,
                  label: environmentId,
                }),
          profile: Option.none(),
          enabled: !disabled.includes(environmentId),
        },
      ]),
    ),
  };
}

function harness(requiresPrimaryEnvironment = false) {
  const catalog = Atom.make<EnvironmentCatalogState>({ isReady: false, entries: new Map() });
  const configs = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<Pick<ServerConfig, "keybindings"> | null>(null),
  );
  const owner = createApplicationKeybindingsEnvironmentIdAtom({
    catalogValueAtom: catalog,
    requiresPrimaryEnvironment,
  });
  const bindings = createApplicationKeybindingsAtom({
    environmentIdAtom: owner,
    serverConfigValueAtom: configs,
  });
  const registry = AtomRegistry.make();
  return { catalog, configs, owner, bindings, registry };
}

describe("application shortcut ownership", () => {
  it("dispatches a remote-only custom chord using the same owner exposed to Settings", () => {
    const { catalog, configs, owner, bindings, registry } = harness();
    registry.set(catalog, catalogState([REMOTE]));
    registry.set(configs(REMOTE), { keybindings: remap });
    expect(registry.get(owner)).toBe(REMOTE);
    expect(
      resolveChatShortcutCommand(
        chord,
        registry.get(bindings),
        mergeWithDefaultKeybindings([]),
        options,
      ),
    ).toBe("thread.settleAndNew");
    registry.dispose();
  });

  it("keeps application commands on the first saved remote while scripts follow the active project", () => {
    const { catalog, configs, owner, bindings, registry } = harness();
    registry.set(catalog, catalogState([REMOTE, OTHER]));
    registry.set(configs(REMOTE), { keybindings: remap });
    const active = mergeWithDefaultKeybindings(
      compileResolvedKeybindingsConfig([{ key: "mod+r", command: "script.deploy.run" }]),
    );
    expect(registry.get(owner)).toBe(REMOTE);
    expect(resolveChatShortcutCommand(chord, registry.get(bindings), active, options)).toBe(
      "thread.settleAndNew",
    );
    expect(
      resolveChatShortcutCommand(
        { ...chord, key: "r", code: "KeyR", shiftKey: false },
        registry.get(bindings),
        active,
        options,
      ),
    ).toBe("script.deploy.run");
    // A late configuration or a new connection must not take ownership from the saved first one.
    registry.set(configs(OTHER), { keybindings: [] });
    registry.set(catalog, catalogState([REMOTE, OTHER, EnvironmentId.make("third")]));
    expect(registry.get(owner)).toBe(REMOTE);
    registry.dispose();
  });

  it("does not switch owners when its config is loading or disconnected", () => {
    const { catalog, configs, owner, bindings, registry } = harness();
    registry.set(catalog, catalogState([REMOTE, OTHER]));
    registry.set(configs(OTHER), { keybindings: remap });
    expect(registry.get(owner)).toBe(REMOTE);
    expect(
      resolveChatShortcutCommand(
        chord,
        registry.get(bindings),
        mergeWithDefaultKeybindings(remap),
        options,
      ),
    ).toBe("thread.settle");
    registry.set(configs(REMOTE), { keybindings: remap });
    expect(
      resolveChatShortcutCommand(
        chord,
        registry.get(bindings),
        mergeWithDefaultKeybindings([]),
        options,
      ),
    ).toBe("thread.settleAndNew");
    registry.dispose();
  });

  it("uses the next saved remote only when the owner is disabled or removed", () => {
    const { catalog, owner, registry } = harness();
    registry.set(catalog, catalogState([REMOTE, OTHER]));
    expect(registry.get(owner)).toBe(REMOTE);
    registry.set(catalog, catalogState([REMOTE, OTHER], [REMOTE]));
    expect(registry.get(owner)).toBe(OTHER);
    registry.set(catalog, catalogState([OTHER]));
    expect(registry.get(owner)).toBe(OTHER);
    registry.set(catalog, catalogState([OTHER], [OTHER]));
    expect(registry.get(owner)).toBeNull();
    registry.dispose();
  });

  it("preserves defaults without an owner and observes changes to its config", () => {
    const { catalog, configs, bindings, registry } = harness();
    expect(
      resolveChatShortcutCommand(
        chord,
        registry.get(bindings),
        mergeWithDefaultKeybindings([]),
        options,
      ),
    ).toBe("thread.settle");
    registry.set(catalog, catalogState([REMOTE]));
    registry.set(configs(REMOTE), { keybindings: remap });
    expect(
      resolveChatShortcutCommand(
        chord,
        registry.get(bindings),
        mergeWithDefaultKeybindings([]),
        options,
      ),
    ).toBe("thread.settleAndNew");
    registry.set(configs(REMOTE), { keybindings: [] });
    expect(
      resolveChatShortcutCommand(
        chord,
        registry.get(bindings),
        mergeWithDefaultKeybindings([]),
        options,
      ),
    ).toBe("thread.settle");
    registry.dispose();
  });

  it("waits for primary discovery on local-enabled clients instead of borrowing remote bindings", () => {
    const { catalog, configs, owner, bindings, registry } = harness(true);
    registry.set(catalog, catalogState([REMOTE]));
    registry.set(configs(REMOTE), { keybindings: remap });
    expect(registry.get(owner)).toBeNull();
    expect(
      resolveChatShortcutCommand(
        chord,
        registry.get(bindings),
        mergeWithDefaultKeybindings(remap),
        options,
      ),
    ).toBe("thread.settle");
    registry.set(catalog, catalogState([REMOTE, LOCAL]));
    expect(registry.get(owner)).toBe(LOCAL);
    registry.set(configs(LOCAL), { keybindings: remap });
    expect(
      resolveChatShortcutCommand(
        chord,
        registry.get(bindings),
        mergeWithDefaultKeybindings([]),
        options,
      ),
    ).toBe("thread.settleAndNew");
    registry.set(configs(LOCAL), null);
    expect(registry.get(owner)).toBe(LOCAL);
    registry.dispose();
  });
});
