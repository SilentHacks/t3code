import { createHostFilesEnvironmentAtoms } from "@t3tools/client-runtime/state/hostFiles";

import { connectionAtomRuntime } from "../connection/runtime";

export const hostFilesEnvironment = createHostFilesEnvironmentAtoms(connectionAtomRuntime);
