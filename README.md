# Zero Claw-Code

A focused desktop coding workspace that drives a [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw) daemon.

**Zero Claw-Code is an independent community project.** It is not made,
maintained, audited, or endorsed by ZeroClaw Labs, and it is not related to
their `zerocode` product. "ZeroClaw" is their trademark; this project only
talks to their daemon.

## What it is

One window per coding session. You pick a folder and an agent, describe a
change, and watch the agent work: streamed text, collapsible tool cards, inline
tool approvals with a live countdown, cancel, and a Changes panel that shows
each file edit as a diff grouped by turn. Sessions are the same ACP sessions
the `zerocode` TUI's Code pane uses, so a session started in either client can
be resumed in the other.

Zero Claw-Code owns presentation only. The daemon owns agent execution, tools,
approvals, and the authoritative transcript. The app links no ZeroClaw crate:
it speaks the daemon's JSON-RPC protocol over the local socket, and works with
any daemon that speaks protocol version 1 and is at least version 0.8.0.

## Requirements

- A `zeroclaw` install (0.8.0 or newer) on your `PATH`, or a daemon already
  listening on its local socket.
- Rust 1.88 or newer and Node 24 or newer to build from source.
- On Linux, the Tauri webview toolchain: `libwebkit2gtk-4.1-dev`,
  `libsoup-3.0-dev`, `libgtk-3-dev`, `librsvg2-dev`,
  `libayatana-appindicator3-dev`.

## Run it

```sh
cd ui && npm ci && npm run build && cd ..
cargo build
./target/debug/zero-claw-code
```

With no flag it uses `~/.zeroclaw`, attaches to a daemon already listening
there, and otherwise starts one itself. To point it somewhere else:

```sh
./target/debug/zero-claw-code --config-dir ~/.zeroclaw-dev/code
```

The flag beats `ZEROCLAW_CONFIG_DIR`, which beats `~/.zeroclaw`. The status bar
shows the socket path, which includes the config directory, so check it before
you send anything.

For frontend hot reload, install the Tauri CLI and run `cargo tauri dev`.

## What it starts

Zero Claw-Code attaches to a running daemon and never signals it. When nothing is
listening it starts `zeroclaw daemon --ephemeral`, which exits about a second
after its last client disconnects.

Read that carefully: `--ephemeral` changes only when the daemon exits. A daemon
started this way still brings up the gateway, configured channels, and cron
from your config, and any other client that attaches keeps it alive. Use a
dedicated config directory with the `--config-dir` flag if you do not want
that. The palette has "Stop the daemon this app started", which signals only
a process this app recorded starting.

## Keys

| Action | Key |
|---|---|
| Send | Enter |
| New line | Shift+Enter |
| Stop the current turn | Esc |
| Approve once / always / reject | Enter / A / R while an approval is showing |
| Action palette | Cmd+K or Ctrl+K |
| Session rail | Cmd+B or Ctrl+B |
| Changes panel | Cmd+J or Ctrl+J |

Every action is also in the palette.

## Reconnecting

If the daemon goes away, a banner appears and the app retries once per second
with the same client identity, then re-attaches its open session and reloads
the transcript. Events from a turn that ran while the app was disconnected are
not replayed, and an approval raised during that window is denied by the
daemon after its timeout; the banner says so and offers Stop or Wait.

## Development

```sh
cargo clippy --all-targets -- -D warnings
cargo test
cd ui && node --experimental-strip-types --test src/lib/*.test.ts
```

`tests/capability_security.rs` asserts the webview never gains a native
capability beyond the folder picker. The design and delivery plan, including
the daemon-side changes this app would benefit from, is in
[`docs/design.md`](docs/design.md).

## License

MIT or Apache-2.0, at your option. See `LICENSE-MIT` and `LICENSE-APACHE`.
