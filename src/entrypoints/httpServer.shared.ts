import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

export interface ClaudeRuntimeContext {
  appId?: string;
  entryId?: string;
  authorization?: string;
  cookie?: string;
  requestId?: string;
}

export interface ClaudeWorkspaceDiagnostics {
  cwd: string;
  claudeMdExists: boolean;
  agentsDirExists: boolean;
  settingsLocalExists: boolean;
  settingsExists: boolean;
  hasLowcodeHttpMcp: boolean;
}

const CONTEXT_KEYS: Array<keyof ClaudeRuntimeContext> = [
  "appId",
  "entryId",
  "authorization",
  "cookie",
  "requestId",
];

function hasLowcodeHttpMcpConfig(path: string): boolean {
  if (!existsSync(path)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      mcpServers?: Record<string, { type?: string }>;
    };
    return parsed.mcpServers?.["lowcode-tools"]?.type === "http";
  } catch {
    return false;
  }
}

export function getDefaultWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.CLAUDE_CODE_WORKSPACE_DIR || resolve(import.meta.dir, "../..");
}

export function resolveSessionCwd(
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return cwd || getDefaultWorkspaceDir(env);
}

export function buildClaudeCliArgs(options: {
  baseArgs: string[];
  prompt: string;
  claudeSessionId?: string;
}): string[] {
  const args = [
    ...options.baseArgs,
    "-p",
    "--output-format",
    "stream-json",
    "--max-turns",
    "200",
  ];

  if (options.claudeSessionId) {
    args.push("--resume", options.claudeSessionId);
  }

  args.push(options.prompt);
  return args;
}

export function extractClaudeSessionId(line: string): string | undefined {
  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      session_id?: string;
    };
    if (
      parsed.type === "system" &&
      typeof parsed.session_id === "string" &&
      parsed.session_id.trim()
    ) {
      return parsed.session_id;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function mergeClaudeRuntimeContext(
  current?: ClaudeRuntimeContext,
  incoming?: ClaudeRuntimeContext,
): ClaudeRuntimeContext | undefined {
  const merged: ClaudeRuntimeContext = { ...(current || {}) };

  for (const key of CONTEXT_KEYS) {
    const value = incoming?.[key];
    if (typeof value === "string" && value.trim()) {
      merged[key] = value;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function buildClaudeChildEnv(
  context?: ClaudeRuntimeContext,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    CLAUDE_CODE_ENTRYPOINT: "sdk-cli",
    // 禁用 Tool Search（tool_reference beta），避免 API 代理不支持该类型导致 400 错误。
    // tool_reference 是 Anthropic API 的 beta content type，第三方代理（ANTHROPIC_BASE_URL）
    // 通常不支持；ToolSearch 返回此类型会导致 "unknown variant `tool_reference`" 错误并终止进程。
    ENABLE_TOOL_SEARCH: env.ENABLE_TOOL_SEARCH || "false",
    LOWCODE_APP_ID: context?.appId || env.LOWCODE_APP_ID || "",
    LOWCODE_ENTRY_ID: context?.entryId || env.LOWCODE_ENTRY_ID || "",
    LOWCODE_AUTHORIZATION:
      context?.authorization || env.LOWCODE_AUTHORIZATION || "",
    LOWCODE_COOKIE: context?.cookie || env.LOWCODE_COOKIE || "",
    LOWCODE_REQUEST_ID: context?.requestId || env.LOWCODE_REQUEST_ID || "",
  };
}

export function collectWorkspaceDiagnostics(
  cwd: string,
): ClaudeWorkspaceDiagnostics {
  const claudeDir = join(cwd, ".claude");
  const settingsLocalPath = join(claudeDir, "settings.local.json");
  const settingsPath = join(claudeDir, "settings.json");

  return {
    cwd,
    claudeMdExists: existsSync(join(claudeDir, "CLAUDE.md")),
    agentsDirExists: existsSync(join(claudeDir, "agents")),
    settingsLocalExists: existsSync(settingsLocalPath),
    settingsExists: existsSync(settingsPath),
    hasLowcodeHttpMcp:
      hasLowcodeHttpMcpConfig(settingsLocalPath) ||
      hasLowcodeHttpMcpConfig(settingsPath),
  };
}
