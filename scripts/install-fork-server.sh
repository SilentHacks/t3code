#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Build the SilentHacks/t3code fork on Ubuntu 22.04+ (x64 or ARM64).

Usage: bash install-fork-server.sh [--systemd]

Prerequisites:
  sudo apt-get update
  sudo apt-get install -y git curl ca-certificates build-essential python3 pkg-config libsecret-1-dev

Vite+/Node and a minimal Rust toolchain are installed for the current user if needed.
Allow several GB of free disk and at least 4 GB of RAM/swap for the source build.
OMP itself is not installed. Existing t3 installations and ~/.t3 data are untouched.

Options:
  --systemd   Write a separate t3-omp.service user unit; do not start it yet.

Overrides:
  T3CODE_FORK_REF          Branch, tag, or commit to build (default: main)
  T3CODE_FORK_INSTALL_DIR  Source/build storage (default: ~/.local/share/t3-omp)
  T3CODE_FORK_BIN_DIR      Launcher directory (default: ~/.local/bin)
  T3CODE_FORK_HOME         Fork state (default: ~/.t3-omp)
  T3CODE_FORK_PORT         Fork listener (default: 3774; stock T3 uses 3773)
EOF
}

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
systemd=0
case "${1:-}" in
  --help|-h) usage; exit 0 ;;
  --systemd) systemd=1; shift ;;
  '') ;;
  *) usage >&2; exit 1 ;;
esac
[[ $# -eq 0 ]] || die 'Unexpected arguments.'
[[ "$(uname -s)" == Linux ]] || die 'This installer is for Ubuntu Linux.'
case "$(uname -m)" in x86_64|aarch64|arm64) ;; *) die 'Requires x64 or ARM64.' ;; esac
for tool in git curl python3 make g++ pkg-config; do
  command -v "$tool" >/dev/null || die "Missing $tool. Run the prerequisite apt-get commands from --help."
done
pkg-config --exists libsecret-1 || die 'Install libsecret-1-dev first.'

install_dir="${T3CODE_FORK_INSTALL_DIR:-$HOME/.local/share/t3-omp}"
bin_dir="${T3CODE_FORK_BIN_DIR:-$HOME/.local/bin}"
data_dir="${T3CODE_FORK_HOME:-$HOME/.t3-omp}"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
launcher="$bin_dir/t3-omp"
marker='# T3_OMP_MANAGED_V1'
for path in "$install_dir" "$bin_dir" "$data_dir" "$unit_dir"; do
  [[ "$path" == /* && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || die 'Install paths must be absolute single-line paths.'
done
if [[ -e "$launcher" || -L "$launcher" ]]; then
  [[ -f "$launcher" ]] && grep -qxF "$marker" "$launcher" || die "Refusing to replace an unmanaged $launcher."
fi
if [[ "$systemd" -eq 1 && -e "$unit_dir/t3-omp.service" ]]; then
  grep -qxF "$marker" "$unit_dir/t3-omp.service" || die 'Refusing to replace an unmanaged t3-omp.service.'
fi

mkdir -p "$install_dir/releases" "$bin_dir"
release="$(mktemp -d "$install_dir/releases/build.XXXXXX")"
launcher_tmp=''
installed=0
cleanup() {
  [[ -z "$launcher_tmp" ]] || rm -f -- "$launcher_tmp"
  [[ "$installed" -eq 1 ]] || rm -rf -- "$release"
}
trap cleanup EXIT

printf 'Fetching the fork (%s)...\n' "${T3CODE_FORK_REF:-main}"
git init --quiet "$release"
git -C "$release" remote add origin https://github.com/SilentHacks/t3code.git
git -C "$release" sparse-checkout init --cone
git -C "$release" sparse-checkout set apps packages scripts native patches assets packaging infra oxlint-plugin-t3code .vite-hooks
git -C "$release" fetch --filter=blob:none --depth=1 origin "${T3CODE_FORK_REF:-main}"
git -C "$release" checkout --detach --quiet FETCH_HEAD
[[ -f "$release/apps/server/src/provider/Drivers/OmpDriver.ts" ]] || die 'This revision does not include OMP.'
git -C "$release" rev-parse HEAD
cp "$release/.env.example" "$release/.env"

if [[ -f "$HOME/.config/vite-plus/env" ]]; then . "$HOME/.config/vite-plus/env"; fi
if ! command -v vp >/dev/null; then
  curl --proto '=https' --tlsv1.2 -fsSL https://vite.plus/install.sh -o "$release/install-vp.sh"
  bash "$release/install-vp.sh"
  . "$HOME/.config/vite-plus/env"
fi
export VP_NODE_VERSION=24.21.0
if [[ -f "$HOME/.cargo/env" ]]; then . "$HOME/.cargo/env"; fi
if ! command -v rustup >/dev/null; then
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o "$release/install-rust.sh"
  sh "$release/install-rust.sh" -y --profile minimal --default-toolchain none
  . "$HOME/.cargo/env"
fi
rustup toolchain install 1.99.0 --profile minimal

cd "$release"
printf 'Building the Connect-enabled web/server and Linux resource monitor...\n'
vp i --frozen-lockfile
node_path="$(vp exec node -p 'process.execPath')"
[[ -x "$node_path" ]] || die 'Could not resolve the managed Node executable.'
"$node_path" --input-type=module <<'JS'
import { loadRepoEnv, resolvePublicConfig } from './scripts/lib/public-config.ts';
const config = resolvePublicConfig(loadRepoEnv());
if (!config.clerkPublishableKey || !config.clerkJwtTemplate || !config.clerkCliOAuthClientId || !config.relayUrl) {
  throw new Error('Missing public T3 Connect configuration. Check .env and runtime overrides.');
}
JS
vp run --filter t3 build
rustup run 1.99.0 cargo build --locked --release --manifest-path native/resource-monitor/Cargo.toml
mkdir -p apps/server/dist/resource-monitor
cp native/resource-monitor/target/release/t3-resource-monitor apps/server/dist/resource-monitor/t3-resource-monitor
[[ -f apps/server/dist/client/index.html ]] || die 'Bundled web client is missing.'
"$node_path" --input-type=module <<'JS'
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRepoEnv, resolvePublicConfig } from './scripts/lib/public-config.ts';
const config = resolvePublicConfig(loadRepoEnv());
const bundleText = (dir, extensions) => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() && entry.name !== 'client' ? bundleText(path, extensions) :
    entry.isFile() && extensions.some(extension => path.endsWith(extension)) ? [readFileSync(path, 'utf8')] : [];
}).join('\n');
const server = bundleText('apps/server/dist', ['.mjs', '.js']);
const client = bundleText('apps/server/dist/client', ['.js']);
if (![config.clerkPublishableKey, config.clerkCliOAuthClientId, config.relayUrl].every(value => server.includes(value)) ||
    ![config.clerkPublishableKey, config.relayUrl].every(value => client.includes(value))) {
  throw new Error('Public T3 Connect configuration is missing from the built client/server.');
}
console.log('Verified public T3 Connect configuration in both bundles.');
JS
"$node_path" apps/server/dist/bin.mjs --version
"$node_path" apps/server/dist/bin.mjs connect link --help >/dev/null

launcher_tmp="$(mktemp "$bin_dir/.t3-omp.XXXXXX")"
python3 - "$launcher_tmp" "$node_path" "$release" "$data_dir" "$marker" "$systemd" "$unit_dir" "$launcher" <<'PY'
import pathlib, shlex, sys
target, node, release, data, marker, systemd, unit_dir, launcher = sys.argv[1:]
q = shlex.quote
pathlib.Path(target).write_text(f'''#!/usr/bin/env bash
{marker}
set -euo pipefail
default_home={q(data)}
export T3CODE_HOME="${{T3CODE_FORK_HOME:-$default_home}}"
export T3CODE_PORT="${{T3CODE_FORK_PORT:-3774}}"
export PATH={q(str(pathlib.Path(node).parent))}:"$HOME/.local/bin:$HOME/.bun/bin:${{PATH:-/usr/local/bin:/usr/bin:/bin}}"
case "${{1:-}}" in
  update|service)
    echo 'This is a source-built fork. Re-run its installer to update; use t3-omp.service for background operation.' >&2
    exit 1 ;;
  connect)
    case "${{2:-}}" in
      login|link|status|logout|unlink|publish|--help|-h) ;;
      *)
        echo 'Use: t3-omp connect link --headless, then t3-omp serve. The stock onboarding service can download upstream code.' >&2
        exit 1 ;;
    esac ;;
esac
exec {q(node)} {q(release + '/apps/server/dist/bin.mjs')} "$@"
''')
if systemd == '1':
    unit = pathlib.Path(unit_dir) / 't3-omp.service'
    unit.parent.mkdir(parents=True, exist_ok=True)
    exec_start = launcher.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$')
    unit.write_text(f'''{marker}
[Unit]
Description=T3 Code OMP fork (T3 Connect)
After=network-online.target

[Service]
WorkingDirectory=%h
ExecStart="{exec_start}" serve
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=30

[Install]
WantedBy=default.target
''')
PY
chmod 755 "$launcher_tmp"
mv -f "$launcher_tmp" "$launcher"
launcher_tmp=''
installed=1
printf '\nInstalled: %s\nState: %s (override with T3CODE_FORK_HOME)\n' "$launcher" "$data_dir"
printf '\nLink this VPS to your usual T3 Connect account:\n  %q connect link --headless\n' "$launcher"
if [[ "$systemd" -eq 1 ]]; then
  printf '\nAfter linking, start the separate fork service:\n  systemctl --user daemon-reload\n  systemctl --user enable --now t3-omp.service\n'
  printf 'Keep it running after logout:\n  sudo loginctl enable-linger "$USER"\n'
else
  printf '\nStart the server:\n  %q serve\n' "$launcher"
fi
printf '\nInstall/authenticate OMP on this VPS, then add Oh My Pi in the fork client.\n'
printf 'Old build directories are retained for rollback; updates require restarting the fork service.\n'
