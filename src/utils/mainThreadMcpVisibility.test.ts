import { expect, test } from "bun:test";
import { filterMcpToolsForMainThread } from "./mainThreadMcpVisibility.js";

const BUILT_IN_TOOL = { name: "AgentTool" };
const MCP_TOOL = {
  name: "mcp__lowcode-tools__AskUserQuestion",
  isMcp: true,
};
const PREFIX_ONLY_MCP_TOOL = {
  name: "mcp__lowcode-tools__SearchDataEntityDocs",
};

test("sdk-cli main thread hides MCP tools", () => {
  const tools = filterMcpToolsForMainThread(
    [BUILT_IN_TOOL, MCP_TOOL],
    "sdk-cli",
  );

  expect(tools.map(tool => tool.name)).toEqual([BUILT_IN_TOOL.name]);
});

test("non-sdk-cli main thread keeps MCP tools", () => {
  const tools = filterMcpToolsForMainThread(
    [BUILT_IN_TOOL, MCP_TOOL],
    undefined,
  );

  expect(tools.map(tool => tool.name)).toEqual([
    BUILT_IN_TOOL.name,
    MCP_TOOL.name,
  ]);
});

test("sdk-cli main thread hides prefix-only MCP tools", () => {
  const tools = filterMcpToolsForMainThread(
    [BUILT_IN_TOOL, PREFIX_ONLY_MCP_TOOL],
    "sdk-cli",
  );

  expect(tools.map(tool => tool.name)).toEqual([BUILT_IN_TOOL.name]);
});
