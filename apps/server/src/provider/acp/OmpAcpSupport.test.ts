import { describe, expect, it } from "@effect/vitest";
import { OmpSettings } from "@t3tools/contracts";
import { Schema } from "effect";

import { buildOmpAcpSpawnInput, ompAcpSpawnArgs } from "./OmpAcpSupport.ts";

const settings = Schema.decodeSync(OmpSettings)({
  binaryPath: "/bin/custom-omp",
  profile: " work ",
});

describe("OMP launch policy", () => {
  it("does not inherit potentially unsafe native defaults", () => {
    expect(ompAcpSpawnArgs()).toEqual(["acp", "--approval-mode=always-ask"]);
  });

  it.each([
    ["approval-required", "--approval-mode=always-ask"],
    ["auto-accept-edits", "--approval-mode=write"],
    ["auto", "--auto-approve"],
    ["full-access", "--approval-mode=yolo"],
  ] as const)("maps %s to the current OMP CLI's %s mode", (mode, nativeMode) => {
    expect(ompAcpSpawnArgs(mode)).toEqual(["acp", nativeMode]);
    expect(ompAcpSpawnArgs(mode, true)).toEqual(["acp", nativeMode, "--no-tools"]);
  });

  it("uses one profile argument and keeps credentials exclusively in the environment", () => {
    const environment = { OMP_API_KEY: "secret-test-value", OMP_CONFIG: "instance-one" };
    const input = buildOmpAcpSpawnInput(settings, "/workspace", environment, "full-access");
    expect(input.command).toBe("/bin/custom-omp");
    expect(input.cwd).toBe("/workspace");
    expect(input.args).toEqual(["acp", "--approval-mode=yolo", "--profile", "work"]);
    expect(input.env).toMatchObject(environment);
    expect(input.args.join(" ")).not.toContain(environment.OMP_API_KEY);
    expect(environment).toEqual({ OMP_API_KEY: "secret-test-value", OMP_CONFIG: "instance-one" });
  });

  it("isolates provider-instance profiles and environment overrides", () => {
    const first = buildOmpAcpSpawnInput(settings, "/first", { OMP_CONFIG: "first" });
    const second = buildOmpAcpSpawnInput({ ...settings, profile: "other profile" }, "/second", {
      OMP_CONFIG: "second",
    });
    expect(first.env?.OMP_CONFIG).toBe("first");
    expect(second.env?.OMP_CONFIG).toBe("second");
    expect(second.args.slice(-2)).toEqual(["--profile", "other profile"]);
  });

  it("omits a blank profile and falls back to omp for an empty binary", () => {
    const input = buildOmpAcpSpawnInput({ binaryPath: "   ", profile: "   " }, "/workspace");
    expect(input.command).toBe("omp");
    expect(input.args).toEqual(["acp", "--approval-mode=always-ask"]);
  });
});
