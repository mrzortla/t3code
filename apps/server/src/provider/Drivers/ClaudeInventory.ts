import type {
  ProviderDisabledInventory,
  ProviderInventoryItem,
  ProviderInventoryStatus,
  ServerProviderSkill,
} from "@t3tools/contracts";
import type {
  McpServerStatus,
  Settings as ClaudeSdkSettings,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type { ProviderInventoryDraft } from "@t3tools/provider-core/server/driver";

const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

const CLAUDE_AI_CONNECTOR_PREFIX = "claude.ai ";
const PLUGIN_SERVER_PATTERN = /^plugin:([^:]+):(.+)$/;
const MAX_ERROR_CHARS = 300;

export interface ClaudeInventoryProbe {
  readonly servers: ReadonlyArray<McpServerStatus>;
  readonly plugins: ReadonlyArray<{
    readonly name: string;
    readonly source?: string | undefined;
    readonly version?: string | undefined;
  }>;
  readonly skills: ReadonlyArray<Pick<SlashCommand, "name" | "description">>;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

const STATUS: Record<McpServerStatus["status"], ProviderInventoryStatus> = {
  connected: "connected",
  "needs-auth": "needsAuth",
  failed: "failed",
  pending: "pending",
  disabled: "disabled",
};

function serverItem(
  server: McpServerStatus,
  name: string,
  plugin: string | undefined,
): ProviderInventoryItem {
  const error = nonEmpty(server.error)?.slice(0, MAX_ERROR_CHARS);
  return {
    id: server.name,
    name: nonEmpty(name) ?? server.name,
    status: STATUS[server.status] ?? "pending",
    ...(server.status === "connected" && server.tools ? { toolCount: server.tools.length } : {}),
    ...(plugin ? { plugin } : {}),
    ...(error ? { error } : {}),
  };
}

const byName = (left: ProviderInventoryItem, right: ProviderInventoryItem) =>
  left.name.localeCompare(right.name);

export function claudeInventoryFromProbe(probe: ClaudeInventoryProbe): ProviderInventoryDraft {
  const connectors: Array<ProviderInventoryItem> = [];
  const mcpServers: Array<ProviderInventoryItem> = [];
  for (const server of probe.servers) {
    // `source` names where the definition came from; older CLIs only report `scope`.
    const source = server.source ?? server.scope;
    if (source === "sdk") continue;
    if (source === "claudeai") {
      const name = server.name.startsWith(CLAUDE_AI_CONNECTOR_PREFIX)
        ? server.name.slice(CLAUDE_AI_CONNECTOR_PREFIX.length)
        : server.name;
      connectors.push(serverItem(server, name, undefined));
      continue;
    }
    const pluginServer = source === "plugin" ? PLUGIN_SERVER_PATTERN.exec(server.name) : null;
    mcpServers.push(
      pluginServer
        ? serverItem(server, pluginServer[2] ?? server.name, pluginServer[1])
        : serverItem(server, server.name, undefined),
    );
  }

  // Built-in plugins ship inside Claude Code and are not something the user connected.
  const plugins = probe.plugins.filter((plugin) => !plugin.source?.endsWith("@builtin"));
  const pluginNames = new Set(plugins.map((plugin) => plugin.name));
  const skills: Array<ProviderInventoryItem> = [];
  const skillCounts = new Map<string, number>();
  for (const skill of probe.skills) {
    const separator = skill.name.indexOf(":");
    const plugin = separator > 0 ? skill.name.slice(0, separator) : undefined;
    if (plugin !== undefined && pluginNames.has(plugin)) {
      skillCounts.set(plugin, (skillCounts.get(plugin) ?? 0) + 1);
      continue;
    }
    const description = nonEmpty(skill.description);
    skills.push({ id: skill.name, name: skill.name, ...(description ? { description } : {}) });
  }

  const serverCounts = new Map<string, number>();
  for (const server of mcpServers) {
    if (server.plugin) serverCounts.set(server.plugin, (serverCounts.get(server.plugin) ?? 0) + 1);
  }

  return {
    manageUrl: CLAUDE_CONNECTORS_URL,
    connectors: { _tag: "Listed", items: connectors.toSorted(byName), canDisable: true },
    mcpServers: { _tag: "Listed", items: mcpServers.toSorted(byName), canDisable: true },
    plugins: {
      _tag: "Listed",
      items: plugins
        .map((plugin): ProviderInventoryItem => {
          const contents = [
            pluralize(skillCounts.get(plugin.name) ?? 0, "skill"),
            pluralize(serverCounts.get(plugin.name) ?? 0, "MCP server"),
          ].filter((part) => part !== undefined);
          const version = nonEmpty(plugin.version);
          return {
            id: nonEmpty(plugin.source) ?? plugin.name,
            name: plugin.name,
            ...(contents.length > 0 || version
              ? { description: [...contents, ...(version ? [`v${version}`] : [])].join(" · ") }
              : {}),
          };
        })
        .toSorted(byName),
      canDisable: true,
    },
    skills: { _tag: "Listed", items: skills.toSorted(byName), canDisable: true },
  };
}

function pluralize(count: number, noun: string): string | undefined {
  if (count === 0) return undefined;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Passed as the session's `--settings` layer, which outranks user, project and
 * local settings for this process only, so nothing is written to the user's
 * Claude configuration. Denied servers merge across every settings source.
 */
export function claudeDisabledInventorySettings(
  disabled: ProviderDisabledInventory,
): ClaudeSdkSettings | undefined {
  const deniedServers = [...(disabled.connectors ?? []), ...(disabled.mcpServers ?? [])];
  const plugins = disabled.plugins ?? [];
  const skills = disabled.skills ?? [];
  if (deniedServers.length === 0 && plugins.length === 0 && skills.length === 0) return undefined;
  return {
    ...(deniedServers.length > 0
      ? { deniedMcpServers: deniedServers.map((serverName) => ({ serverName })) }
      : {}),
    ...(plugins.length > 0
      ? { enabledPlugins: Object.fromEntries(plugins.map((id) => [id, false])) }
      : {}),
    ...(skills.length > 0
      ? { skillOverrides: Object.fromEntries(skills.map((name) => [name, "off" as const])) }
      : {}),
  };
}

/**
 * Mirrors {@link claudeDisabledInventorySettings} for T3's own skill discovery
 * so the composer stops offering what the session will not load. Claude Code
 * ignores skill overrides for plugin skills; those follow their plugin.
 */
export function withClaudeDisabledInventory(
  skills: ReadonlyArray<ServerProviderSkill>,
  disabled: ProviderDisabledInventory,
): ReadonlyArray<ServerProviderSkill> {
  const skillNames = new Set(disabled.skills);
  const pluginNames = new Set((disabled.plugins ?? []).map((id) => id.split("@")[0]));
  if (skillNames.size === 0 && pluginNames.size === 0) return skills;
  return skills.map((skill) => {
    const separator = skill.name.indexOf(":");
    const plugin = separator > 0 ? skill.name.slice(0, separator) : undefined;
    const off = skillNames.has(skill.name) || (plugin !== undefined && pluginNames.has(plugin));
    return off && skill.enabled ? { ...skill, enabled: false } : skill;
  });
}
