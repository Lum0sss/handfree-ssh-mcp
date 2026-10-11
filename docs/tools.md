[← Back to README](../README.md)

# Tools

| Tool | Description |
|------|-------------|
| `execute-command` | Run a command in the remote default shell; `stream` selects background return or waiting |
| `show-whitelist` | Show active command policy + SFTP policy + output-log path for a server |
| `close-connection` | Close a cached SSH connection for a server |
| `upload` | Upload local file(s) to a remote server (CRLF-fix for shell scripts, skip-if-identical, optional `reuseConnection`, `vvv`, `fast`; `localPath` accepts an array for batch upload — see [Upload behaviors](transfer.md#upload-behaviors)) |
| `download` | Download remote file to local disk (optional `reuseConnection`, `vvv`, `fast`, or `connections` for a multi-connection ranged download — see [Multi-connection download](transfer.md#multi-connection-download)) |
| `transfer` | Unified upload / download / server-to-server relay. Supports recursive small-file concurrency (`fileConcurrency`), batch upload (array `localPath`), temporary tar packing (`archive`, `archiveCompression`), fast SFTP by default, a bounded relay read-ahead window, and relay `strategy: "relay" \| "direct" \| "auto"` for a source-to-destination direct copy that bypasses this host — see [Upload behaviors](transfer.md#upload-behaviors). |
| `list-servers` | List configured (enabled) servers. Lean by default; `verbose:true` adds cached system status, `refresh:true` re-collects it (implies verbose). |
| `workspace-run` | Start a durable Linux task — **no YAML run profile needed**: pass `remoteRoot` + `venv`/`executable` inline, or use a saved `runProfiles.<name>` preset. `[push] → preflight → launching → remote-running → [collect]`. Durable: survives SSH disconnect and MCP adapter restart because all state lives on the remote filesystem, not locally — see [workspace-run (remote runner)](workspace-run.md). |
| `run-status` | Query a `workspace-run` run's current status by `runId` (reads the remote state directory over SFTP; no local cache). |
| `run-logs` | Read a byte-offset window of a run's stdout/stderr, UTF-8-boundary-safe across sequential calls. |
| `run-list` | List runs on a server, newest first. |
| `run-cancel` | Cancel a run: TERM to its process group, then KILL after `graceMs`; re-verifies process identity before signalling. |
| `run-retry` | Launch a fresh run from an earlier run's own stored (non-secret) config snapshot, not the live config; records `parentRunId`. |
| `help` | Self-describing help text for the MCP client |

## show-whitelist

Inspect this when a command/path is rejected or the configured policy is unclear. The legacy name covers both blacklist and whitelist modes:

```json
{
  "tool": "show-whitelist",
  "params": {
    "connectionName": "dev"
  }
}
```

Returns command mode, built-in command guards, configured whitelist/blacklist patterns, and examples when whitelist mode is active.

## execute-command

`cmdString` is sent unchanged to the remote SSH service's default shell. Ordinary commands need no `cmd`, `pwsh`, `bash` or `sh` prefix; add one only to select another interpreter. Each call opens a separate exec session, so connection reuse does not preserve `cd`, exports or shell state.

Background command status is local to the MCP process and is lost on restart; its saved local `logPath` remains. Use `workspace-run` for tasks that must survive SSH disconnects and MCP restarts.

```json
{
  "tool": "execute-command",
  "params": {
    "cmdString": "docker ps",
    "connectionName": "dev",
    "timeout": 300000,
    "stream": true,
    "reuseConnection": true,
    "vvv": false
  }
}
```

| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `cmdString` | ✅ | - | Command to execute |
| `connectionName` | With multiple enabled servers | Sole enabled server | Target server name from `list-servers` |
| `timeout` | ❌ | 300000ms (stream) / 30000ms (no stream) | Per-attempt phase timeout in ms. SSH setup and remote command execution use this cap; exec-channel opening is also bounded by configured `channelOpenTimeout`. |
| `stream` | ❌ | `true` | `true`: return `runId/logPath` immediately, then poll `command-status`; `false`: wait for final output |
| `reuseConnection` | ❌ | `true` | Reuse the cached SSH connection. Set `false` after a timeout or suspected stale cached connection to force a fresh TCP/SSH connection for this command. |
| `vvv` | ❌ | `false` | Append bounded SSH/channel debug output. Use with `reuseConnection: false` when you need fresh ssh2 handshake logs. |

**When to use `stream: false`:**
- Simple, fast commands (ls, pwd, cat)
- When the final output should be returned in the same call

## close-connection

```json
{
  "tool": "close-connection",
  "params": {
    "connectionName": "dev"
  }
}
```

Closes the cached SSH client for a configured server. This is useful after a timeout or suspected stale reused connection when you want the next default `reuseConnection: true` command to reconnect cleanly. Closing a jump host also closes cached targets whose jump chain uses that host. `reuseConnection: false` commands do not need this because their one-shot SSH clients close after each command.
