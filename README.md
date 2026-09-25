# ZeroTauri

A Tauri desktop GUI wrapper for a [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw) daemon.

**ZeroTauri is an independent community project.** It is not made,
maintained, audited, or endorsed by ZeroClaw Labs, and it is not related to
their `zerocode` product. "ZeroClaw" is their trademark; this project only
talks to their daemon.

## What it is

ZeroTauri wraps a running ZeroClaw daemon in a native window. If you already
use ZeroClaw, think of it as a graphical version of the Code pane in the
`zerocode` terminal UI. One window per coding session: pick a
folder and an agent, describe a change, and watch the agent work. Streamed
text, collapsible tool cards, inline tool approvals with a live countdown,
cancel, and a Changes panel that shows each file edit as a diff grouped by
turn.

It adds nothing to the agent itself. No new tools, channels, or permissions.
The daemon still owns agent execution, tool approval, and the transcript; this
app only renders and relays your decisions. It talks to the daemon over the
same local RPC socket `zerocode` uses, and the sessions it creates are the same
ACP sessions, so a session started in either client can be resumed in the
other.

## Quick start

This assumes ZeroClaw already works for you: `zeroclaw` 0.8.0 or newer is
installed, and at least one agent is enabled with a working provider key. If
`zerocode` can chat with an agent on your machine, you are ready.

1. **Install the build toolchains** if you do not have them.

   - Rust 1.88 or newer via [rustup](https://rustup.rs).
   - Node 24 or newer from [nodejs.org](https://nodejs.org) or `nvm`.
   - macOS: the Xcode Command Line Tools (`xcode-select --install`).
   - Linux: the webview libraries.

     ```sh
     sudo apt-get install -y libwebkit2gtk-4.1-dev libsoup-3.0-dev \
       libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev
     ```

   - Windows: Visual Studio Build Tools with the C++ workload. WebView2 is
     already present on Windows 10 and 11.

2. **Clone and build.**

   ```sh
   git clone https://github.com/IftekharUddin/zerotauri
   cd zerotauri
   (cd ui && npm ci && npm run build)
   cargo build --release
   ```

   The first Rust build compiles the Tauri toolchain and takes a few minutes.
   Later builds are fast.

3. **Run it.**

   ```sh
   ./target/release/zerotauri
   ```

   On launch the app looks for a daemon at `~/.zeroclaw/data/daemon.sock`.
   If you already run `zeroclaw daemon`, for example as a service, it attaches
   to it and never signals it. If nothing is listening it starts one for you;
   see [What it starts](#what-it-starts) before relying on that.

4. **Start a session.** Choose a folder with the picker and an agent from the
   list. Only enabled agents are offered, and a single enabled agent is
   selected for you. Type what you want changed and press Enter.

5. **Answer approvals as they come.** When a tool needs your say-so, a card
   appears with the daemon's countdown. Allow once, always allow, or reject,
   by button or with Enter, `A`, or `R` when the message box is not focused.
   Letting the countdown expire is the daemon denying by policy, exactly as
   it would in any other client.

6. **Check the status bar** at the bottom before you send anything that
   matters. It shows the socket path, which tells you which config directory
   you are on, the daemon version, and "started by this app" when the daemon
   is one the app spawned.

## Using a different config directory

The app follows the same rule as `zeroclaw daemon --config-dir`: an explicit
flag beats the `ZEROCLAW_CONFIG_DIR` environment variable, which beats
`~/.zeroclaw`.

```sh
./target/release/zerotauri --config-dir ~/.zeroclaw-dev/code
```

Prefer the flag. Some terminal panes and app launchers drop a `VAR=value`
prefix before running the command, and a silently dropped variable means the
app falls back to `~/.zeroclaw` and starts a daemon from your real config.
The status bar tells you which one you got.

Keep config directories short. The daemon's socket lives at
`<config dir>/data/daemon.sock`, and Unix socket paths are limited to roughly
a hundred bytes. A deeply nested directory produces a daemon that starts but
never opens its socket, and the app then reports that it never became ready.

## What it starts

When no daemon answers, the app runs `zeroclaw daemon --ephemeral` with your
config directory and pins its socket to the path the app expects. An ephemeral
daemon exits about a second after its last client disconnects, so closing the
app takes it down with it.

Read that carefully. `--ephemeral` changes only when the daemon exits. A
daemon started this way still brings up the gateway, every configured
channel, and cron from that config, and any other client that attaches keeps
it alive. If you would rather not have your channels come up under a coding
app, use a dedicated config directory with the flag above, or start
`zeroclaw daemon` yourself first so the app attaches instead.

The action palette has "Stop the daemon this app started". It signals only a
process this app recorded starting. A daemon that was already running is
never touched.

The spawned daemon's output goes to a log under the app's log directory,
`~/Library/Logs/io.github.iftekharuddin.zerotauri/` on macOS and the
equivalent per-app logs directory on Linux and Windows.

## Sessions and zerocode

Code sessions are stored by the daemon in its ACP session store, the same one
`zerocode`'s Code pane uses. The session rail lists them, newest first, and
any of them can be resumed here, including ones started in `zerocode`.

Two things to know when both clients are open:

- Resuming a session takes over its controls. If the session is running in
  the other client at that moment, the app asks before taking it, because the
  cancel button would move with it.
- "Always allow" on an approval lasts only for the life of the daemon and is
  never written to your config. That is daemon behaviour, not an app choice.

Closing a session in the app removes it from the daemon's memory but keeps
its transcript; it reappears in the rail and can be resumed later.

## Keys

| Action | Key |
|---|---|
| Send | Enter |
| New line | Shift+Enter |
| Stop the current turn | Esc |
| Approve once / always / reject | Enter / A / R, with the message box not focused |
| Action palette | Cmd+K or Ctrl+K |
| Session rail | Cmd+B or Ctrl+B |
| Changes panel | Cmd+J or Ctrl+J |

Every action is also in the palette, so nothing is keyboard-only.

## Reconnecting

If the daemon goes away, a banner appears and the app retries once per second
with the same client identity. When the daemon returns, the app re-attaches
its open session and reloads the transcript.

Events from a turn that ran while the app was disconnected are not replayed,
and an approval raised during that window is denied by the daemon after its
timeout. If a turn was still running when you reconnect, the banner offers
Stop, which cancels it, or Wait, which reloads once the daemon reports it
idle.

## Troubleshooting

**"No enabled agents."** The config directory the app is using has no agent
with `enabled = true`, or it is a fresh directory. Run `zeroclaw quickstart`
against that directory, or check the status bar to see which directory the
app picked.

**"Could not find the zeroclaw binary."** Apps launched from the Dock or a
desktop menu get a minimal `PATH`. The app also checks `~/.cargo/bin`,
`~/.local/bin`, and the Homebrew and system directories. If `zeroclaw` lives
somewhere else, start `zeroclaw daemon` yourself and the app will attach.

**"Started a daemon but it never became ready."** Read the daemon log in the
app's log directory. The usual causes are a broken config, a port already in
use by another daemon's gateway, or a config directory path too long for a
socket.

**"Protocol mismatch" or "needs at least 0.8.0".** Upgrade `zeroclaw`. The app
speaks protocol version 1 and refuses only on that or on a daemon older than
its floor; above the floor it hides features the daemon lacks rather than
failing.

**The status bar shows `~/.zeroclaw` when you wanted another directory.** The
environment variable did not reach the process. Use the `--config-dir` flag.

**A message fails immediately with a provider error.** The agent's provider
or key is the problem, not the app. The failure text is the daemon's own.
Confirm with `zerocode` or the `zeroclaw` CLI against the same config.

**A second launch focuses the existing window.** One instance per user session
by design. Quit the app first to relaunch with different flags.

## Building an installable bundle

For a proper application bundle instead of a bare binary, install the Tauri
CLI and build with it:

```sh
cargo install tauri-cli --version "^2"
cargo tauri build
```

Bundles land under `target/release/bundle/`: an app and dmg on macOS, msi and
setup exe on Windows, deb and AppImage on Linux. Local builds are unsigned, so
macOS will quarantine the app; `xattr -dr com.apple.quarantine` on the bundle
clears that for your own machine.

## Development

```sh
cargo clippy --all-targets -- -D warnings
cargo test
(cd ui && node --experimental-strip-types --test src/lib/*.test.ts)
```

For frontend hot reload, run `cargo tauri dev`, which starts the Vite dev
server and points the window at it.

`tests/capability_security.rs` asserts the webview never gains a native
capability beyond the folder picker. CI runs the frontend tests and build,
clippy with warnings denied, and the Rust tests on macOS, Linux, and Windows.

The design and delivery plan, including the daemon-side changes this app would
benefit from, is in [`docs/design.md`](docs/design.md).

## License

MIT or Apache-2.0, at your option. See `LICENSE-MIT` and `LICENSE-APACHE`.
