import { createHostFilesEnvironmentAtoms } from "@t3tools/client-runtime/state/hostFiles";
import { AuthTerminalOperateScope, type EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentScope } from "./session";

export const hostFilesEnvironment = createHostFilesEnvironmentAtoms(connectionAtomRuntime);

/** Server files reach the whole host, so they need the same grant as a terminal. */
export function useHostFilesAccess(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentScope(environmentId, AuthTerminalOperateScope);
}
