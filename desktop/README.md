# Dev Assistant Desktop (Tauri)

This is a native desktop window around the existing Dev Assistant Node.js
application. The CLI remains the application core; Tauri owns the window and
starts/stops the local loopback service with the desktop process.

## Fedora prerequisites

Install the Tauri Linux system libraries and a C toolchain:

```bash
sudo dnf check-update
sudo dnf install webkit2gtk4.1-devel openssl-devel curl wget file \
  libappindicator-gtk3-devel librsvg2-devel libxdo-devel
sudo dnf group install "c-development"
```

Install Rust using rustup if it is not already available, then install the
desktop JavaScript dependencies:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
npm install --prefix desktop
```

## Run the desktop window

From the repository root:

```bash
npm --prefix desktop run dev
```

This builds the existing CLI, starts its loopback GUI service, and opens it in
a Tauri webview window. Closing the desktop application stops the Node service.

## Build a desktop package

```bash
npm --prefix desktop run build
```

The initial desktop runtime expects Node.js 22 or later to be installed and
available as `node` on PATH. The Tauri bundle includes the compiled CLI
resources, but does not yet embed a Node.js runtime. A self-contained release
will require packaging a platform-specific Node sidecar.

## Opening repositories

The project selector supports local repository paths and remote Git clone URLs.
For remote repositories, enter an HTTPS or SSH URL and optionally a branch or
tag. The clone is stored under `~/.dev-assistant/projects` and opened as a
local working copy. Private repositories use the Git credential helper or SSH
keys already configured on the computer. Do not embed passwords or tokens in
clone URLs. Cloning does not push changes back to the remote automatically.
