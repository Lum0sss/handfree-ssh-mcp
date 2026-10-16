# Declarative CLI plugins

Plugins are independent programs. Handfree supplies discovery, installation commands,
SSH transport and release-specific instructions; experiment and Web logic stays in the
plugin. No REXP command mapping or REXP dependency is built into Handfree.

## User configuration

The optional registry defaults to `~/.config/handfree-ssh-mcp/plugins.yaml`
(`$XDG_CONFIG_HOME/handfree-ssh-mcp/plugins.yaml` when set). Override it with
`--plugins /absolute/path/plugins.yaml` or `HANDFREE_PLUGINS_CONFIG`.
A missing registry means no plugins. An invalid registry returns a structured error
when queried; ordinary SSH tools remain available. Files are reread on every plugin
request, so restart is unnecessary after changing a manifest.

Copy `examples/plugins/registry.example.yaml` and the manifests you need to that
personal configuration directory, then edit your paths. Do not store personal
configuration or credentials in the source repository. SSH authentication and aliases
remain in the existing SSH configuration; the plugin registry has no separate SSH client.

Each registry entry references a local, trusted manifest. Paths are relative to the
registry file. Enabled manifests must have matching ids and schemaVersion 1. A plugin
can contain several components; select one explicitly when there is more than one.

## Tool flow

1. `list-servers`: find the SSH connection alias for your target.
2. `plugin-list`: discover plugin ids, components, targets and sources.
3. `plugin-activate {plugin:"rexp", connectionName:"my-server"}`: check the installed
   version and fetch its skill catalog. Default mode is `check` and makes no installation.
4. If missing, explicitly select `mode:"install"`. To request the package manager's
   latest available version select `mode:"update"`. These use the configured commands,
   then query the actual installed version and skill catalog again. Repeated checks do
   not reinstall packages. Review running workloads before updating a worker.
5. `plugin-skill {plugin:"rexp", connectionName:"my-server", name:"platform-operations"}`:
   obtain the instructions shipped by that installed version. Fetch again after updates.
6. `plugin-run {plugin:"rexp", connectionName:"my-server", args:["runs","--json"]}`:
   call its CLI. New plugin commands require no change to Handfree.

The examples above are illustrative tool arguments. Configure the target first.
`connectionName` follows ordinary SSH tools: required if several hosts are enabled,
automatically resolved if exactly one is enabled. It is never fixed to a device name.
Local components reject `connectionName` and execute on the **MCP process host**, which
may be a Mac, Windows machine or another server.

## Manifest contract

A component declares `id`, `target` (`local` or `ssh`), `description`, `entry` and
`version` argv arrays. Optional fields:

- `source`: `kind`, `location`, optional `package`, for discovery. Downloads are done
  by the explicit `install`/`update` argv commands, **not inferred from a URL**.
- `install` / `update`: package manager argv arrays. Missing actions fail clearly.
- `env`: environment variables for every command, including install and version.
- `skills.list` / `skills.show`: commands returning the current catalog and one skill;
  `${skill}` is the requested name. These may return JSON or Markdown; Handfree
  returns their output without interpreting a plugin-specific business schema.

`${settingName}` substitutes a registry setting in manifest argv/environment values.
Per-connection settings override common settings. Missing/empty required values fail
before any command is run. Substitution is single-pass. Runtime `args` are passed
literally, without interpolation. No arbitrary JavaScript modules are loaded.

For REXP, keep `platformRoot`, `labPath` and `platformPython` per server. The root is
passed through `PLATFORM_ROOT`; omitting a required root fails instead of selecting an
arbitrary directory. Existing roots are not initialized, migrated or deleted by activation.
The example assumes an existing Python installation (such as Conda base); it does not
install Conda or create experiment environments. It requires a REXP release with
`lab skills list/show`; upgrading Handfree alone does not add that interface to old workers.
The TestPyPI example is a development source; change installer argv for production.

## Execution and lifetime

Local commands use `execFile` without a shell. Remote argv and environment values
are individually POSIX-quoted, then executed through the existing SSH manager. Existing
command policies apply to the **complete quoted command**, including `env`; a whitelist
for an unquoted bare executable might need a deliberate adjustment. Handfree never
relaxes that policy. SFTP continues to use existing upload/download/transfer tools and
path policies. This first remote adapter requires a POSIX shell.

CLI outputs are returned as `{plugin,component,target,connectionName,output}`. Errors
use existing MCP `isError` / code / message / retriable conventions. Output is limited
to 1 MiB per stream (SSH), 1 MiB combined (local); detected truncation is an error.
Remote exit errors are detected from the existing manager's exit markers; this is not a
new transport protocol. A disconnected mutation is not retried automatically, since the
remote operation might already have happened. Check its state before retrying.
Normal command timeout defaults to 30 seconds (configurable up to 5 minutes through
the tool); maintenance uses 5 minutes. A timeout/disconnect may leave a partially
completed installation and cannot be rolled back by Handfree. Maintenance is serialized
per component/host in one MCP process; it is not a distributed package manager lock.

Skills are retrieved on demand, not cached indefinitely or installed into a client's
global skills directory. Connection loss does not own the scheduler or an existing Web
service. Use each program's explicit lifecycle commands. Foreground long-running servers
should not be started with `plugin-run`; the REXP Web example uses its existing persistent
`start/stop/status/logs` helper. Web's installation directory, data and lifecycle remain
independent. The current Web example controls an existing checkout; it has no published
update source or skill endpoint, so neither is fabricated by this manifest.

## Development verification

`npm run test:plugins` covers local execution, literal argv, SSH alias and root selection,
policy failures, installer failure, rereading skills after updates, component selection,
concurrent maintenance and timeouts. Existing SSH tests remain separate.


### Validation for this implementation

- Plugin tests: 6 passed, including an actual MCP client/server exchange.
- Full suite: 739 passed, 3 failed, 11 skipped in the run including the first five
  plugin tests. The three failures were reproduced from a clean archive of origin/main
  (290c446): one missing-authentication assertion and two direct-transfer host-key fixtures.
- The actual local REXP CLI was invoked through the generic plugin host: version,
  release skills, status, queue and fixed root identity passed. No experiment scheduler
  was started and no remote worker was updated.
- Package dry run includes the new host and example manifests, excludes private SSH
  configuration and the former REXP JavaScript adapter.
- Existing Web continues to use its independent stable runtime. It has not yet migrated
  its business calls to this new generic plugin API.
