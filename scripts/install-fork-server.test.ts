// @effect-diagnostics nodeBuiltinImport:off - Tests the shell installer with local tool/build fixtures, without network access.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const installer = NodePath.resolve(import.meta.dirname, "install-fork-server.sh");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const run = (command: string, args: string[], env: NodeJS.ProcessEnv) =>
  NodeChildProcess.spawnSync(command, args, { env, encoding: "utf8", timeout: 30_000 });

async function withFixture(test: (env: NodeJS.ProcessEnv, root: string) => Promise<void>) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fork-install-"));
  const home = NodePath.join(root, "home with 'quotes $dollars");
  const tools = NodePath.join(root, "tools");
  const fixture = NodePath.join(root, "fixture");
  try {
    for (const path of [home, tools, NodePath.join(fixture, "scripts/lib")]) {
      await NodeFSP.mkdir(path, { recursive: true });
    }
    await NodeFSP.copyFile(
      NodePath.join(import.meta.dirname, "lib/public-config.ts"),
      NodePath.join(fixture, "scripts/lib/public-config.ts"),
    );
    await NodeFSP.writeFile(
      NodePath.join(fixture, ".env.example"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_live_fixture\nT3CODE_CLERK_JWT_TEMPLATE=t3-relay\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=fixture-oauth\nT3CODE_RELAY_URL=https://relay.example.com\n",
    );
    await NodeFSP.writeFile(
      NodePath.join(fixture, "bin.mjs"),
      "// pk_live_fixture fixture-oauth https://relay.example.com\nconsole.log(JSON.stringify({args:process.argv.slice(2),home:process.env.T3CODE_HOME,port:process.env.T3CODE_PORT}));\n",
    );
    const commands: Record<string, string> = {
      uname:
        'if [[ "$1" == -s ]]; then echo "${TEST_OS:-Linux}"; else echo "${TEST_ARCH:-x86_64}"; fi',
      "pkg-config": "exit 0",
      "g++": "exit 0",
      make: "exit 0",
      curl: "echo 'Unexpected network request' >&2; exit 99",
      git: `
if [[ "$1" == init ]]; then exit 0; fi
directory="$2"; shift 2
case "$1" in
 checkout)
   cp -R "$TEST_FIXTURE/." "$directory/"
   if [[ "\${TEST_NO_OMP:-0}" == 0 ]]; then
     mkdir -p "$directory/apps/server/src/provider/Drivers"
     touch "$directory/apps/server/src/provider/Drivers/OmpDriver.ts"
   fi ;;
 rev-parse) echo 0123456789012345678901234567890123456789 ;;
esac`,
      rustup: `
if [[ "$1" == run ]]; then
  mkdir -p native/resource-monitor/target/release
  printf '#!/bin/sh\\nexit 0\\n' > native/resource-monitor/target/release/t3-resource-monitor
  chmod +x native/resource-monitor/target/release/t3-resource-monitor
fi`,
      vp: `
case "$1" in
 i) exit 0 ;;
 exec) shift 2; exec ${quote(process.execPath)} "$@" ;;
 run)
   [[ "\${TEST_BUILD_FAIL:-0}" == 0 ]] || exit 42
   mkdir -p apps/server/dist/client/assets
   cp "$TEST_FIXTURE/bin.mjs" apps/server/dist/bin.mjs
   echo '<html></html>' > apps/server/dist/client/index.html
   if [[ "\${TEST_NO_CLIENT_CONFIG:-0}" == 0 ]]; then
     echo '// pk_live_fixture https://relay.example.com' > apps/server/dist/client/assets/config.js
   fi ;;
esac`,
    };
    for (const [name, body] of Object.entries(commands)) {
      await NodeFSP.writeFile(NodePath.join(tools, name), `#!/bin/bash\nset -eu\n${body}\n`, {
        mode: 0o755,
      });
    }
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("T3CODE_") || key.startsWith("VITE_") || key.startsWith("EXPO_PUBLIC_")) {
        delete env[key];
      }
    }
    await test(
      {
        ...env,
        HOME: home,
        PATH: `${tools}:${process.env.PATH}`,
        TEST_FIXTURE: fixture,
        T3CODE_HOME: NodePath.join(home, ".t3"),
        T3CODE_FORK_REF: "fixture-ref",
        T3CODE_FORK_HOME: NodePath.join(home, ".t3-omp"),
        T3CODE_FORK_INSTALL_DIR: NodePath.join(home, ".local/share/t3-omp"),
        T3CODE_FORK_BIN_DIR: NodePath.join(home, ".local/bin"),
        XDG_CONFIG_HOME: NodePath.join(home, ".config"),
      },
      root,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

describe("fork server installer", () => {
  it("installs an isolated launcher and separate service without changing stock t3", () =>
    withFixture(async (env) => {
      const bin = env.T3CODE_FORK_BIN_DIR!;
      await NodeFSP.mkdir(bin, { recursive: true });
      await NodeFSP.mkdir(env.T3CODE_HOME!, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(bin, "t3"), "stock t3");
      await NodeFSP.writeFile(NodePath.join(env.T3CODE_HOME!, "keep"), "live state");
      const result = run("bash", [installer, "--systemd"], env);
      expect(result.stderr, result.stdout).toBe("");
      expect(result.status, result.stdout).toBe(0);
      expect(await NodeFSP.readFile(NodePath.join(bin, "t3"), "utf8")).toBe("stock t3");
      expect(await NodeFSP.readFile(NodePath.join(env.T3CODE_HOME!, "keep"), "utf8")).toBe(
        "live state",
      );
      const launcher = NodePath.join(bin, "t3-omp");
      const invocation = run(launcher, ["serve", "--host", "value with spaces"], env);
      expect(invocation.status).toBe(0);
      expect(JSON.parse(invocation.stdout)).toEqual({
        args: ["serve", "--host", "value with spaces"],
        home: env.T3CODE_FORK_HOME,
        port: "3774",
      });
      const defaultEnv = { ...env };
      delete defaultEnv.T3CODE_FORK_HOME;
      expect(JSON.parse(run(launcher, ["serve"], defaultEnv).stdout).home).toBe(
        env.T3CODE_FORK_HOME,
      );
      const override = NodePath.join(env.HOME!, "other state");
      expect(
        JSON.parse(
          run(launcher, ["connect", "link", "--headless"], { ...env, T3CODE_FORK_HOME: override })
            .stdout,
        ).home,
      ).toBe(override);
      for (const args of [
        ["update"],
        ["service", "install"],
        ["connect"],
        ["connect", "--base-dir", "example"],
      ]) {
        expect(run(launcher, args, env).status).toBe(1);
      }
      const unit = await NodeFSP.readFile(
        NodePath.join(env.XDG_CONFIG_HOME!, "systemd/user/t3-omp.service"),
        "utf8",
      );
      expect(unit).toContain("t3-omp");
      expect(unit).toContain("$$dollars");
      expect(unit).toContain("KillMode=mixed");
      expect(unit).toContain("WorkingDirectory=%h");
      expect(result.stdout).toContain("connect link --headless");
      expect(run("bash", [installer, "--systemd"], env).status).toBe(0);
    }));

  it.each([
    { TEST_OS: "Darwin" },
    { TEST_ARCH: "i686" },
    { TEST_NO_OMP: "1" },
    { TEST_BUILD_FAIL: "1" },
    { TEST_NO_CLIENT_CONFIG: "1" },
  ])("does not install a launcher when prerequisites/build validation fail (%o)", (failure) =>
    withFixture(async (env) => {
      const result = run("bash", [installer], { ...env, ...failure });
      expect(result.status).not.toBe(0);
      await expect(
        NodeFSP.access(NodePath.join(env.T3CODE_FORK_BIN_DIR!, "t3-omp")),
      ).rejects.toThrow();
    }),
  );

  it("refuses to replace an unmanaged fork launcher", () =>
    withFixture(async (env) => {
      await NodeFSP.mkdir(env.T3CODE_FORK_BIN_DIR!, { recursive: true });
      const launcher = NodePath.join(env.T3CODE_FORK_BIN_DIR!, "t3-omp");
      await NodeFSP.writeFile(launcher, "custom launcher");
      const result = run("bash", [installer], env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unmanaged");
      expect(await NodeFSP.readFile(launcher, "utf8")).toBe("custom launcher");
    }));
});
