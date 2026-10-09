import type { RouterHistory } from "@tanstack/react-router";

/** History entry identity survives browser state refreshes; leaving and returning does not. */
export async function withNavigationGuard<T>(
  history: RouterHistory,
  run: (isCurrent: () => boolean) => Promise<T>,
): Promise<T> {
  const { href, state } = history.location;
  const key = state.__TSR_key;
  let navigated = false;
  const isCurrent = () => {
    const current = history.location;
    if (current.href !== href || current.state.__TSR_key !== key) navigated = true;
    return !navigated;
  };
  const unsubscribe = history.subscribe(() => isCurrent());
  try {
    return await run(isCurrent);
  } finally {
    unsubscribe();
  }
}
