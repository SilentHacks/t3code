import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProviderInstanceId, ServerSettings, ServerSettingsPatch } from "@t3tools/contracts";
import {
  mobileOmpInstances,
  mobileOmpSettingsPatch,
  nextMobileOmpInstanceId,
} from "./omp-settings";

const decode = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const id = ProviderInstanceId.make("omp_work");

describe("mobile OMP configuration", () => {
  it("keeps OMP opt-in and exposes the default profile without enabling it", () => {
    expect(mobileOmpInstances(decode({}))).toEqual([
      {
        id: "omp",
        displayName: "Oh My Pi",
        enabled: false,
        config: { enabled: false, binaryPath: "omp", profile: "", customModels: [] },
      },
    ]);
  });
  it("updates only the selected account and retains opaque config and environment", () => {
    const settings = decode({
      providerInstances: {
        omp_work: {
          driver: "omp",
          enabled: true,
          environment: [{ name: "ANTHROPIC_API_KEY", value: "test-only", sensitive: true }],
          config: { profile: "work", customModels: ["Vendor/model:Native"], forkOwned: 42 },
        },
        unknown: { driver: "custom", config: { foo: 1 } },
      },
    });
    const patch = mobileOmpSettingsPatch(settings, id, { profile: "" });
    expect(decodePatch(patch)).toEqual({
      providerInstances: {
        omp_work: {
          driver: "omp",
          enabled: true,
          environment: [{ name: "ANTHROPIC_API_KEY", value: "test-only", sensitive: true }],
          config: { profile: "", customModels: ["Vendor/model:Native"], forkOwned: 42 },
        },
      },
    });
    expect(settings.providerInstances[id]?.config).toMatchObject({ profile: "work" });
  });
  it("aligns both enable flags and avoids collisions with unknown drivers", () => {
    const settings = decode({ providerInstances: { omp_2: { driver: "other", config: {} } } });
    expect(nextMobileOmpInstanceId(settings)).toBe("omp_3");
    expect(() =>
      mobileOmpSettingsPatch(settings, ProviderInstanceId.make("omp_2"), { enabled: true }),
    ).toThrow("already in use");
    expect(
      mobileOmpSettingsPatch(settings, id, { enabled: false }).providerInstances?.[id],
    ).toMatchObject({ enabled: false, config: { enabled: false } });
  });
});
