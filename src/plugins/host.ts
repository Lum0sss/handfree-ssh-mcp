import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PluginCatalog, expand, shellQuote } from "./catalog.js";
import { SSHConnectionManager } from "../services/ssh-connection-manager.js";
import { ToolError } from "../utils/tool-error.js";

const execFileAsync = promisify(execFile);
type Target = {plugin: string; component?: string; connectionName?: string};
type ExecuteLocal = (argv: string[], env: Record<string, string>, timeout: number) => Promise<string>;
const localExec: ExecuteLocal = async (argv, env, timeout) => {
  const result = await execFileAsync(argv[0], argv.slice(1), {
    env: {...process.env, ...env}, timeout, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  return result.stdout;
};

/** One host, no experiment-specific tool mappings or background process ownership. */
export class PluginHost {
  private mutations = new Map<string, Promise<unknown>>();
  constructor(readonly catalog = new PluginCatalog(),
    private readonly ssh = SSHConnectionManager.getInstance(),
    private readonly executeLocal = localExec) {}

  private context(target: Target) {
    const resolved = this.catalog.resolve(target.plugin, target.component);
    const connectionName = resolved.component.target === "ssh" ? this.ssh.resolveServer(target.connectionName) : undefined;
    if (resolved.component.target === "local" && target.connectionName)
      throw new ToolError("INVALID_CONFIGURATION", "A local component does not accept connectionName");
    const variables = {...resolved.registration.settings,
      ...(connectionName ? resolved.registration.connections[connectionName] || {} : {})};
    return {...resolved, connectionName, variables};
  }

  private async execute(target: Target, select: (c: ReturnType<PluginHost["context"]>) => string[],
    timeout = 30000, extra: Record<string, string> = {}, runtimeArgs: string[] = []) {
    const c = this.context(target);
    const variables = {...c.variables, ...extra};
    const argv = [...select(c).map(value => expand(value, variables)), ...runtimeArgs];
    if (argv.some(value => value.includes("\0"))) throw new ToolError("INVALID_CONFIGURATION", "NUL is not allowed");
    const env = Object.fromEntries(Object.entries(c.component.env).map(([key, value]) => [key, expand(value, variables)]));
    let output: string;
    try {
      if (c.connectionName) {
        const command = [...(Object.keys(env).length ? ["env", ...Object.entries(env).map(([k,v]) => `${k}=${v}`)] : []), ...argv].map(shellQuote).join(" ");
        // Use the existing manager, including its command policy, timeout and output limits.
        // Mutations are never automatically retried after an ambiguous SSH disconnect.
        output = await this.ssh.executeCommand(command, c.connectionName, {timeout, maxRetries: 0, maxOutputBytes: 1024 * 1024});
        if (/\[EXIT CODE: [1-9]\d*\]/.test(output) || /\[OUTPUT TRUNCATED\]/.test(output))
          throw new ToolError("COMMAND_EXECUTION_ERROR", output);
      } else {
        output = await this.executeLocal(argv, env, timeout);
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("COMMAND_EXECUTION_ERROR", (error as Error).message);
    }
    return {plugin: target.plugin, component: c.component.id, target: c.component.target,
      connectionName: c.connectionName ?? null, output};
  }

  async run(target: Target, args: string[], timeout?: number) {
    return this.execute(target, c => c.component.entry, timeout, {}, args);
  }

  async skill(target: Target, name?: string) {
    return this.execute(target, c => {
      if (!c.component.skills) throw new ToolError("INVALID_CONFIGURATION", "This component does not publish skills");
      return name ? c.component.skills.show : c.component.skills.list;
    }, 30000, name ? {skill: name} : {});
  }

  async activate(target: Target, mode: "check" | "install" | "update" = "check") {
    const c = this.context(target);
    const key = `${target.plugin}/${c.component.id}/${c.connectionName ?? "local"}`;
    if (this.mutations.has(key)) throw new ToolError("COMMAND_EXECUTION_ERROR", "Plugin maintenance is already in progress", true);
    const task = (async () => {
      if (mode !== "check") {
        const command = c.component[mode];
        if (!command) throw new ToolError("INVALID_CONFIGURATION", `No ${mode} command configured for this component`);
        await this.execute(target, () => command, 300000);
      }
      const version = await this.execute(target, ctx => ctx.component.version);
      const skills = c.component.skills ? await this.skill(target) : null;
      return {...version, mode, skills};
    })();
    this.mutations.set(key, task);
    try { return await task; } finally { this.mutations.delete(key); }
  }
}
