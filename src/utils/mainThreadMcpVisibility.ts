type MaybeMcpTool = {
  name?: string
  isMcp?: boolean
}

function isMcpLikeTool(tool: MaybeMcpTool): boolean {
  return tool.name?.startsWith('mcp__') || tool.isMcp === true
}

export function filterMcpToolsForMainThread<T extends MaybeMcpTool>(
  tools: readonly T[],
  entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT,
): T[] {
  if (entrypoint !== 'sdk-cli') {
    return [...tools]
  }

  return tools.filter(tool => !isMcpLikeTool(tool))
}
