/**
 * Config env lookup. Prefers the current `GECKO_MCP_` prefix and falls back to
 * the legacy `FLOORP_MCP_` prefix so configs from before the rename keep working.
 */
export function envCfg(suffix: string): string | undefined {
  return process.env[`GECKO_MCP_${suffix}`] ?? process.env[`FLOORP_MCP_${suffix}`];
}
