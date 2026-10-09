import { createBrowserHistory, createMemoryHistory } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { withNavigationGuard } from "./navigationGuard";

describe("navigation guard", () => {
  it("survives a real browser-history reparse of the same entry", async () => {
    const window = {
      location: { pathname: "/environment/thread", search: "", hash: "" },
      history: {
        state: { __TSR_key: "thread", key: "thread", __TSR_index: 0 },
        length: 1,
        pushState: vi.fn(),
        replaceState(state: typeof this.state) {
          this.state = state;
        },
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const history = createBrowserHistory({ window });
    try {
      await withNavigationGuard(history, async (isCurrent) => {
        const location = history.location;
        window.history.replaceState({ ...window.history.state });
        expect(history.location).not.toBe(location);
        expect(isCurrent()).toBe(true);
      });
      expect(history.subscribers.size).toBe(0);
    } finally {
      history.destroy();
    }
  });

  it("remembers navigation away even after returning to the original entry", async () => {
    const history = createMemoryHistory({ initialEntries: ["/environment/thread"] });
    await withNavigationGuard(history, async (isCurrent) => {
      const key = history.location.state.__TSR_key;
      history.push("/elsewhere");
      history.back();
      expect(history.location.state.__TSR_key).toBe(key);
      expect(isCurrent()).toBe(false);
    });
    expect(history.subscribers.size).toBe(0);
  });

  it("cancels a new navigation entry even at the same URL", async () => {
    const history = createMemoryHistory({ initialEntries: ["/environment/thread"] });
    await withNavigationGuard(history, async (isCurrent) => {
      history.push(history.location.href);
      expect(isCurrent()).toBe(false);
    });
  });

  it("unsubscribes if the operation fails", async () => {
    const history = createMemoryHistory();
    await expect(
      withNavigationGuard(history, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    expect(history.subscribers.size).toBe(0);
  });
});
