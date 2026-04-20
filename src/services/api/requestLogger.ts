/**
 * 将 claude-code 发往模型的完整 API 请求体和响应摘要写入日志文件。
 * 每条日志作为一行 JSON（JSONL 格式），便于分析和调试。
 *
 * 仅在 CLAUDE_CODE_ENTRYPOINT=sdk-cli（httpServer 入口）时启用。
 *
 * 日志文件位置：{CWD}/logs/api-requests.jsonl
 * 可通过环境变量 CLAUDE_API_REQUEST_LOG_DIR 自定义目录。
 */
import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { getCwd } from "src/utils/cwd.js";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages.mjs";
import { getSessionId } from "src/bootstrap/state.js";

let ensuredDir = false;

function getLogDir(): string {
  return process.env.CLAUDE_API_REQUEST_LOG_DIR || join(getCwd(), "logs");
}

function getLogFilePath(): string {
  return join(getLogDir(), "api-requests.jsonl");
}

/**
 * 确保日志目录存在。内部缓存避免重复创建。
 */
async function ensureLogDir(): Promise<void> {
  if (!ensuredDir) {
    await mkdir(getLogDir(), { recursive: true });
    ensuredDir = true;
  }
}

/**
 * 将一条日志条目追加写入 JSONL 文件。
 * 异步写入，不阻塞主流程；写入失败静默忽略。
 */
async function writeLogEntry(entry: Record<string, unknown>): Promise<void> {
  try {
    await ensureLogDir();
    await appendFile(getLogFilePath(), JSON.stringify(entry) + "\n");
  } catch {
    // 写入失败静默忽略，不影响主流程
  }
}

/**
 * 将完整的 API 请求参数写入 JSONL 日志文件。
 * 包含 system prompt、messages、tools 等完整请求体，用于调试 LLM 行为。
 *
 * @param params - 发往 API 的完整请求参数
 * @param querySource - 请求来源标识（如 'sdk'）
 */
export async function logAPIRequestBody(
  params: BetaMessageStreamParams,
  querySource?: string,
): Promise<void> {
  // 仅在 sdk-cli 入口（httpServer）启用，避免影响普通 CLI 使用
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== "sdk-cli") {
    return;
  }

  await writeLogEntry({
    timestamp: new Date().toISOString(),
    type: "request",
    sessionId: getSessionId(),
    querySource,
    model: params.model,
    system: params.system,
    messages: params.messages,
    tools: params.tools,
    tool_choice: params.tool_choice,
    max_tokens: params.max_tokens,
    thinking: params.thinking,
    betas: params.betas,
    metadata: params.metadata,
  });
}

/**
 * 记录 API 响应摘要到 JSONL 日志文件。
 * 不记录完整响应内容（太大），只记录关键字段：stop_reason、usage、content 中的工具调用摘要。
 *
 * @param response - 包含 stop_reason、usage 等关键响应信息的对象
 */
export async function logAPIResponseSummary(response: {
  stopReason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
  contentSummary?: string;
  durationMs?: number;
}): Promise<void> {
  if (process.env.CLAUDE_CODE_ENTRYPOINT !== "sdk-cli") {
    return;
  }

  await writeLogEntry({
    timestamp: new Date().toISOString(),
    type: "response",
    sessionId: getSessionId(),
    stopReason: response.stopReason,
    usage: response.usage,
    model: response.model,
    contentSummary: response.contentSummary,
    durationMs: response.durationMs,
  });
}
