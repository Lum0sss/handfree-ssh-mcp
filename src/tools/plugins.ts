import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PluginHost } from "../plugins/host.js";
import { formatToolErrorResponse, toToolError } from "../utils/tool-error.js";

const target = {
  plugin: z.string().describe("Plugin id from plugin-list"),
  component: z.string().optional().describe("Required when the plugin has multiple components"),
  connectionName: z.string().optional().describe("Existing SSH connection alias; same selection as execute-command. Omit for local components."),
};
const reply = async (operation: () => unknown) => {
  try { return {content: [{type: "text" as const, text: JSON.stringify(await operation())}]}; }
  catch (error) { return {content: [{type: "text" as const, text: formatToolErrorResponse(toToolError(error, "COMMAND_EXECUTION_ERROR"))}], isError: true}; }
};

export function registerPluginTools(server: McpServer): void {
  const host = new PluginHost();
  server.tool("plugin-list", "Discover enabled plugins, components, installation targets and sources from the user's registry. Does not install anything or open SSH connections.", {},
    async () => reply(() => host.catalog.read().map(({manifest}) => manifest)));
  server.tool("plugin-activate", "Check the installed version and fetch the current skill catalog. Explicit mode install/update runs the configured package installer on the selected host; review the manifest and running workloads first. Does not start experiment schedulers or own Web service lifetime.",
    {...target, mode: z.enum(["check", "install", "update"]).default("check")},
    async ({mode, ...selection}) => reply(() => host.activate(selection, mode)));
  server.tool("plugin-skill", "Read a skill from the installed plugin. Omit name for its catalog. Fetch again after updating the plugin. This returns instructions; it does not install a global client skill.",
    {...target, name: z.string().min(1).optional()},
    async ({name, ...selection}) => reply(() => host.skill(selection, name)));
  server.tool("plugin-run", "Invoke a plugin CLI with an argv array, using its configured entry point and settings. Read plugin-skill first. SSH components use the selected SSH connection and its existing command policy. Transfer files with the existing SFTP tools; all supplied paths belong to the component host.",
    {...target, args: z.array(z.string().refine(s => !s.includes("\0"))).max(256), timeout: z.number().int().min(1000).max(300000).optional()},
    async ({args, timeout, ...selection}) => reply(() => host.run(selection, args, timeout)));
}
