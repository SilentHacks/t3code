import type { OmpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** OMP 18.6 utils/dirs.ts: named profiles ignore agent overrides; XDG data is opt-in by existence. */
export const resolveOmpSessionsDirectory = Effect.fn("resolveOmpSessionsDirectory")(
  function* (input: {
    readonly settings: OmpSettings;
    readonly environment: NodeJS.ProcessEnv;
    readonly platform: NodeJS.Platform;
    readonly homeDirectory: string;
  }) {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = input.environment;
    const profile = (
      input.settings.profile.trim() ||
      (env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE) ||
      ""
    ).trim();
    const named = profile !== "" && profile !== "default";
    if (
      named &&
      (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile) ||
        profile === "." ||
        profile === ".." ||
        profile.endsWith(".") ||
        /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(profile))
    )
      return null;
    const home = (input.platform === "win32" ? env.USERPROFILE : env.HOME) || input.homeDirectory;
    const root = path.join(home, env.PI_CONFIG_DIR || ".omp");
    const configRoot = named ? path.join(root, "profiles", profile) : root;
    const defaultAgent = path.join(configRoot, "agent");
    const agent =
      !named && env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : defaultAgent;
    if (
      (input.platform === "linux" || input.platform === "darwin") &&
      agent === defaultAgent &&
      env.XDG_DATA_HOME
    ) {
      const xdg = named
        ? path.join(env.XDG_DATA_HOME, "omp", "profiles", profile)
        : path.join(env.XDG_DATA_HOME, "omp");
      if (yield* fs.exists(xdg).pipe(Effect.orElseSucceed(() => false)))
        return path.join(xdg, "sessions");
    }
    return path.join(agent, "sessions");
  },
);
