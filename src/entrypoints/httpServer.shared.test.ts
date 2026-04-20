import { expect, test } from "bun:test";
import {
  buildClaudeChildEnv,
  buildClaudeCliArgs,
  extractClaudeSessionId,
  getDefaultWorkspaceDir,
  mergeClaudeRuntimeContext,
} from "./httpServer.shared";

test("default workspace dir points to claude-code project root", () => {
  expect(
    getDefaultWorkspaceDir({} as NodeJS.ProcessEnv).endsWith("claude-code"),
  ).toBe(true);
});

test("buildClaudeCliArgs injects --resume before prompt", () => {
  expect(
    buildClaudeCliArgs({
      baseArgs: ["node", "dist/cli.js"],
      prompt: "hello",
      claudeSessionId: "claude-session-1",
    }),
  ).toEqual([
    "node",
    "dist/cli.js",
    "-p",
    "--output-format",
    "stream-json",
    "--max-turns",
    "200",
    "--resume",
    "claude-session-1",
    "hello",
  ]);
});

test("extractClaudeSessionId reads session id from system stream message", () => {
  expect(
    extractClaudeSessionId(
      JSON.stringify({
        type: "system",
        session_id: "claude-session-2",
      }),
    ),
  ).toBe("claude-session-2");
});

test("buildClaudeChildEnv injects lowcode request context into child env", () => {
  expect(
    buildClaudeChildEnv(
      {
        appId: "app-1",
        entryId: "entry-1",
        authorization: "Bearer token",
        cookie: "sid=abc",
        requestId: "req-1",
      },
      {} as NodeJS.ProcessEnv,
    ),
  ).toMatchObject({
    CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
    ENABLE_TOOL_SEARCH: "false",
    LOWCODE_APP_ID: "app-1",
    LOWCODE_ENTRY_ID: "entry-1",
    LOWCODE_AUTHORIZATION: "Bearer token",
    LOWCODE_COOKIE: "sid=abc",
    LOWCODE_REQUEST_ID: "req-1",
  });
});

test("mergeClaudeRuntimeContext preserves previous values and accepts newer request id", () => {
  expect(
    mergeClaudeRuntimeContext(
      {
        appId: "app-1",
        authorization: "Bearer token",
      },
      {
        entryId: "entry-1",
        requestId: "req-2",
      },
    ),
  ).toEqual({
    appId: "app-1",
    authorization: "Bearer token",
    entryId: "entry-1",
    requestId: "req-2",
  });
});
