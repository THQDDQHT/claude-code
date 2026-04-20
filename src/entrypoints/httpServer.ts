/**
 * httpServer.ts - HTTP/SSE 入口
 *
 * 【职责】
 * 将 claude-code 以子进程方式封装为 HTTP 服务，供 NestJS 网关调用。
 * 接口返回 SSE 流，实时推送 Agent 执行进展。
 *
 * 【实现方式】
 * 每个请求启动一个 `claude -p` 子进程（headless 模式），读取其 stdout
 * （JSON 行输出）并映射为 SSE 事件。这样完全复用 claude-code 的初始化、
 * MCP 连接、Agent 加载、权限系统等，无需手动 import 内部模块。
 *
 * 【接口】
 * POST /api/chat          接受 { prompt, sessionId, cwd, context }，返回 SSE 流
 * POST /api/chat/reply    恢复等待用户输入的会话 { sessionId, userReply }
 * GET  /api/health        健康检查
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { accessSync } from "fs";
import { resolve } from "path";
import {
  buildClaudeChildEnv,
  buildClaudeCliArgs,
  collectWorkspaceDiagnostics,
  extractClaudeSessionId,
  getDefaultWorkspaceDir,
  mergeClaudeRuntimeContext,
  resolveSessionCwd,
  type ClaudeRuntimeContext,
} from "./httpServer.shared";

// ========== 会话状态管理 ==========

interface Session {
  id: string;
  /** 上一次运行的 sessionId（claude --resume 用） */
  claudeSessionId?: string;
  cwd: string;
  context?: ClaudeRuntimeContext;
}

const sessions = new Map<string, Session>();

function getOrCreateSession(
  sessionId?: string,
  cwd?: string,
  context?: ClaudeRuntimeContext,
): Session {
  const id = sessionId || randomUUID();
  const existing = sessions.get(id);
  if (existing) {
    if (cwd) {
      existing.cwd = resolveSessionCwd(cwd);
    }
    existing.context = mergeClaudeRuntimeContext(existing.context, context);
    return existing;
  }
  const session: Session = {
    id,
    cwd: resolveSessionCwd(cwd),
    context: mergeClaudeRuntimeContext(undefined, context),
  };
  sessions.set(id, session);
  return session;
}

function logWorkspaceDiagnostics(label: string, cwd: string): void {
  const diagnostics = collectWorkspaceDiagnostics(cwd);
  console.log(`[httpServer] ${label}: ${JSON.stringify(diagnostics)}`);
}

// ========== SSE 响应辅助 ==========

function sseHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function formatSSE(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

// ========== claude 子进程执行 ==========

/**
 * 找到 claude 可执行文件的路径。
 * 优先用环境变量 CLAUDE_CLI_PATH，否则用 bun 直接跑源码入口。
 */
function getClaudeCommand(): { cmd: string; baseArgs: string[] } {
  if (process.env.CLAUDE_CLI_PATH) {
    return {
      cmd: process.env.CLAUDE_CLI_PATH,
      baseArgs: [],
    };
  }

  // 默认: 用当前项目里的 dist/cli.js（如果存在），否则用全局 claude
  const distCli = resolve(import.meta.dir, "../../dist/cli.js");
  try {
    // 检查是否 build 过
    accessSync(distCli);
    return { cmd: "node", baseArgs: [distCli] };
  } catch {
    // 没有 build，直接用全局 claude
    return { cmd: "claude", baseArgs: [] };
  }
}

/**
 * 将 claude -p 的 JSON stdout 行映射为 SSE 事件。
 *
 * claude -p --output-format stream-json 输出每行一个 JSON 对象。
 * 主要类型：
 * - init: 初始化消息
 * - assistant: 助手消息（含 content blocks）
 * - result: 最终结果
 */
function mapClaudeOutputToSSEEvents(
  line: string,
): Array<{ type: string; [key: string]: unknown }> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];

  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    // 非 JSON 行，作为纯文本消息
    if (line.trim()) {
      events.push({ type: "message", content: line.trim() });
    }
    return events;
  }

  switch (parsed.type) {
    case "system": {
      break;
    }

    case "assistant": {
      const content = parsed.message?.content;
      if (!content) break;

      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          // 检查工作流步骤标记
          const stepMatch = block.text.match(
            /\[WORKFLOW_STEP:([^:]+):([^:]+):(\d+)\]/,
          );
          if (stepMatch) {
            events.push({
              type: "workflow_step",
              stepId: stepMatch[1],
              stepName: stepMatch[2],
              stepIndex: parseInt(stepMatch[3]!, 10),
            });
          }

          if (block.text.trim()) {
            events.push({ type: "message", content: block.text });
          }
        }

        if (block.type === "tool_use") {
          events.push({
            type: "tool_start",
            tool: block.name,
            toolUseId: block.id,
            input: block.input,
          });

          // AskUser / ConfirmRequirements 检测
          if (
            block.name === "AskUserQuestion" ||
            block.name === "mcp__lowcode-tools__AskUserQuestion"
          ) {
            const input = block.input as { questions?: unknown[] };
            events.push({
              type: "ask_user",
              questions: input?.questions || [],
            });
          }
          if (
            block.name === "ConfirmDashboardRequirements" ||
            block.name === "mcp__lowcode-tools__ConfirmDashboardRequirements"
          ) {
            const input = block.input as {
              requirement?: string;
              requirements?: string;
            };
            events.push({
              type: "confirm_requirement",
              requirement: input?.requirement || input?.requirements || "",
            });
          }
        }

        if (block.type === "tool_result") {
          const isError = block.is_error === true;
          events.push({
            type: isError ? "tool_error" : "tool_success",
            tool: (block as any).tool_name || "unknown",
            toolUseId: (block as any).tool_use_id,
            result: isError ? undefined : block.content,
            error: isError ? block.content : undefined,
          });
        }
      }
      break;
    }

    case "result": {
      events.push({
        type: "finish",
        status: parsed.is_error ? "failed" : "completed",
        message: typeof parsed.result === "string" ? parsed.result : "",
        duration: parsed.duration_ms,
        cost: parsed.total_cost_usd,
      });
      break;
    }

    default: {
      // 其他类型透传
      if (parsed.type) {
        events.push(parsed);
      }
      break;
    }
  }

  return events;
}

// ========== 请求处理 ==========

async function handleChat(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    prompt: string;
    sessionId?: string;
    cwd?: string;
    context?: ClaudeRuntimeContext;
  };

  const { prompt, sessionId, cwd, context } = body;

  if (!prompt) {
    return new Response(JSON.stringify({ error: "prompt is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const session = getOrCreateSession(sessionId, cwd, context);

  const { cmd, baseArgs } = getClaudeCommand();

  // 组装 claude CLI 参数
  const args = buildClaudeCliArgs({
    baseArgs,
    prompt,
    claudeSessionId: session.claudeSessionId,
  });

  console.log(
    `[httpServer] 启动 claude 子进程: ${cmd} ${args.slice(0, 5).join(" ")}...`,
  );
  logWorkspaceDiagnostics("请求工作目录诊断", session.cwd);
  console.log(
    `[httpServer] 会话上下文: ${JSON.stringify({
      sessionId: session.id,
      claudeSessionId: session.claudeSessionId || "",
      hasAppId: Boolean(session.context?.appId),
      hasEntryId: Boolean(session.context?.entryId),
      hasAuthorization: Boolean(session.context?.authorization),
      hasCookie: Boolean(session.context?.cookie),
      requestId: session.context?.requestId || "",
    })}`,
  );

  // 创建 SSE 流
  const encoder = new TextEncoder();
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  let child: ChildProcess | undefined;
  let buffer = "";
  let streamClosed = false;

  const stopChild = () => {
    if (!child) return;

    child.stdout?.removeAllListeners("data");
    child.stderr?.removeAllListeners("data");
    child.removeAllListeners("close");
    child.removeAllListeners("error");

    if (child.exitCode === null && child.signalCode === null && !child.killed) {
      child.kill();
    }
  };

  const handleAbort = () => {
    if (streamClosed) return;
    console.warn("[httpServer] SSE 请求已断开，终止 claude 子进程");
    stopChild();
    streamClosed = true;
    try {
      controllerRef?.close();
    } catch {
      // ignore: 连接已关闭时 Bun 会抛 Invalid state
    }
  };

  const closeStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    req.signal.removeEventListener("abort", handleAbort);
    try {
      controllerRef?.close();
    } catch {
      // ignore: 连接已关闭时 Bun 会抛 Invalid state
    }
  };

  const enqueueEvent = (event: {
    type: string;
    [key: string]: unknown;
  }): boolean => {
    if (streamClosed || !controllerRef) {
      return false;
    }

    try {
      controllerRef.enqueue(encoder.encode(formatSSE(event)));
      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[httpServer] SSE 流已关闭，停止继续写入事件: ${errorMsg}`);
      req.signal.removeEventListener("abort", handleAbort);
      streamClosed = true;
      stopChild();
      return false;
    }
  };

  const flushBufferedEvents = () => {
    if (!buffer.trim()) {
      return;
    }

    const detectedSessionId = extractClaudeSessionId(buffer);
    if (detectedSessionId && detectedSessionId !== session.claudeSessionId) {
      session.claudeSessionId = detectedSessionId;
      console.log(`[httpServer] 已记录 Claude 会话 ID: ${detectedSessionId}`);
    }

    const events = mapClaudeOutputToSSEEvents(buffer);
    buffer = "";

    for (const event of events) {
      if (!enqueueEvent(event)) {
        return;
      }
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;

      if (req.signal.aborted) {
        handleAbort();
        return;
      }

      req.signal.addEventListener("abort", handleAbort, {
        once: true,
      });

      // 发送 connected 事件
      if (!enqueueEvent({ type: "connected", sessionId: session.id })) {
        return;
      }

      try {
        child = spawn(cmd, args, {
          cwd: session.cwd,
          env: buildClaudeChildEnv(session.context),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        enqueueEvent({
          type: "finish",
          status: "failed",
          message: `启动 claude 进程失败: ${errorMsg}`,
        });
        closeStream();
        return;
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        if (streamClosed) {
          return;
        }

        buffer += chunk.toString("utf-8");

        // 按行拆分
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // 最后一段可能不完整

        for (const line of lines) {
          if (!line.trim()) continue;

          const detectedSessionId = extractClaudeSessionId(line);
          if (
            detectedSessionId &&
            detectedSessionId !== session.claudeSessionId
          ) {
            session.claudeSessionId = detectedSessionId;
            console.log(
              `[httpServer] 已记录 Claude 会话 ID: ${detectedSessionId}`,
            );
          }

          const events = mapClaudeOutputToSSEEvents(line);
          for (const event of events) {
            if (!enqueueEvent(event)) {
              return;
            }
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf-8").trim();
        if (text) {
          console.error(`[httpServer] claude stderr: ${text}`);
        }
      });

      child.on("close", (code) => {
        if (streamClosed) {
          return;
        }

        // 处理剩余 buffer
        flushBufferedEvents();

        if (code !== 0 && code !== null) {
          enqueueEvent({
            type: "finish",
            status: "failed",
            message: `claude 进程退出，code: ${code}`,
          });
        }

        closeStream();
      });

      child.on("error", (err) => {
        if (streamClosed) {
          return;
        }

        enqueueEvent({
          type: "finish",
          status: "failed",
          message: `claude 进程错误: ${err.message}`,
        });
        closeStream();
      });
    },

    cancel() {
      handleAbort();
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

async function handleChatReply(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    sessionId: string;
    userReply: string;
  };

  const { sessionId, userReply } = body;

  if (!sessionId || !userReply) {
    return new Response(
      JSON.stringify({ error: "sessionId and userReply are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const session = sessions.get(sessionId);
  if (!session) {
    return new Response(JSON.stringify({ error: "session not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 用户回复作为新的 prompt，继续已有会话
  const fakeReq = new Request(req.url.replace("/reply", ""), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: userReply,
      sessionId,
      cwd: session.cwd,
      context: session.context,
    }),
  });

  return handleChat(fakeReq);
}

function handleHealth(): Response {
  return new Response(
    JSON.stringify({
      status: "ok",
      sessions: sessions.size,
      workspaceDir: getDefaultWorkspaceDir(),
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// ========== HTTP Server ==========

const PORT = parseInt(process.env.CLAUDE_HTTP_PORT || "3100", 10);

console.log(`[httpServer] 正在启动 claude-code HTTP Server，端口: ${PORT}`);
logWorkspaceDiagnostics("默认工作目录诊断", getDefaultWorkspaceDir());

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: sseHeaders() });
    }

    try {
      switch (`${req.method} ${url.pathname}`) {
        case "POST /api/chat":
          // SSE 长连接不能使用 Bun 默认 10 秒 idle timeout。
          server.timeout(req, 0);
          return await handleChat(req);

        case "POST /api/chat/reply":
          server.timeout(req, 0);
          return await handleChatReply(req);

        case "GET /api/health":
          return handleHealth();

        default:
          return new Response(JSON.stringify({ error: "Not Found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[httpServer] Error: ${errorMsg}`);
      return new Response(JSON.stringify({ error: errorMsg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
});

console.log(
  `[httpServer] claude-code HTTP Server 已启动: http://localhost:${server.port}`,
);
console.log(`[httpServer] 接口:`);
console.log(`  POST /api/chat       - 发送 prompt，返回 SSE 流`);
console.log(`  POST /api/chat/reply - 用户回复（恢复会话）`);
console.log(`  GET  /api/health     - 健康检查`);
