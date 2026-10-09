import {
  OmpSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeOmp = Schema.decodeUnknownSync(OmpSettings);

export function mobileOmpInstances(settings: ServerSettings) {
  const instances = Object.entries(settings.providerInstances).filter(
    ([, instance]) => instance.driver === "omp",
  );
  if (!Object.hasOwn(settings.providerInstances, "omp")) {
    instances.unshift(["omp", { driver: ProviderDriverKind.make("omp"), config: {} }]);
  }
  return instances.map(([id, instance]) => {
    let config;
    try {
      config = decodeOmp(instance.config);
    } catch {
      config = decodeOmp({});
    }
    return {
      id: ProviderInstanceId.make(id),
      displayName: instance.displayName ?? "Oh My Pi",
      config,
      enabled: resolveProviderInstanceEnabled(instance),
    };
  });
}

/** Promote only this instance; retain opaque config keys and account environment overrides. */
export function mobileOmpSettingsPatch(
  settings: ServerSettings,
  id: ProviderInstanceId,
  patch: Partial<OmpSettings>,
): ServerSettingsPatch {
  const existing = settings.providerInstances[id];
  if (existing && existing.driver !== "omp") throw new Error("Provider ID is already in use.");
  const config = existing?.config ?? {};
  const current = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  return {
    providerInstances: {
      [id]: {
        ...existing,
        driver: ProviderDriverKind.make("omp"),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        config: { ...current, ...patch },
      },
    },
  };
}

export function nextMobileOmpInstanceId(settings: ServerSettings): ProviderInstanceId {
  let suffix = 2;
  while (Object.hasOwn(settings.providerInstances, `omp_${suffix}`)) suffix++;
  return ProviderInstanceId.make(`omp_${suffix}`);
}
