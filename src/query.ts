// biome-ignore-all assist/source/organizeImports: ANT-ONLY 导入标记不可重新排序
import type {
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { FallbackTriggeredError } from './services/api/withRetry.js'
import {
  calculateTokenWarningState,
  isAutoCompactEnabled,
  type AutoCompactTrackingState,
} from './services/compact/autoCompact.js'
import { buildPostCompactMessages } from './services/compact/compact.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const reactiveCompact = feature('REACTIVE_COMPACT')
  ? (require('./services/compact/reactiveCompact.js') as typeof import('./services/compact/reactiveCompact.js'))
  : null
const contextCollapse = feature('CONTEXT_COLLAPSE')
  ? (require('./services/contextCollapse/index.js') as typeof import('./services/contextCollapse/index.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import { ImageSizeError } from './utils/imageValidation.js'
import { ImageResizeError } from './utils/imageResizer.js'
import { findToolByName, type ToolUseContext } from './Tool.js'
import { asSystemPrompt, type SystemPrompt } from './utils/systemPromptType.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  RequestStartEvent,
  StreamEvent,
  ToolUseSummaryMessage,
  UserMessage,
  TombstoneMessage,
} from './types/message.js'
import { logError } from './utils/log.js'
import {
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  isPromptTooLongMessage,
} from './services/api/errors.js'
import { logAntError, logForDebugging } from './utils/debug.js'
import {
  createUserMessage,
  createUserInterruptionMessage,
  normalizeMessagesForAPI,
  createSystemMessage,
  createAssistantAPIErrorMessage,
  getMessagesAfterCompactBoundary,
  createToolUseSummaryMessage,
  createMicrocompactBoundaryMessage,
  stripSignatureBlocks,
} from './utils/messages.js'
import { generateToolUseSummary } from './services/toolUseSummary/toolUseSummaryGenerator.js'
import { prependUserContext, appendSystemContext } from './utils/api.js'
import {
  createAttachmentMessage,
  filterDuplicateMemoryAttachments,
  getAttachmentMessages,
  startRelevantMemoryPrefetch,
} from './utils/attachments.js'
/* eslint-disable @typescript-eslint/no-require-imports */
const skillPrefetch = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('./services/skillSearch/prefetch.js') as typeof import('./services/skillSearch/prefetch.js'))
  : null
const jobClassifier = feature('TEMPLATES')
  ? (require('./jobs/classifier.js') as typeof import('./jobs/classifier.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  remove as removeFromQueue,
  getCommandsByMaxPriority,
  isSlashCommand,
} from './utils/messageQueueManager.js'
import { notifyCommandLifecycle } from './utils/commandLifecycle.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import {
  getRuntimeMainLoopModel,
  renderModelName,
} from './utils/model/model.js'
import {
  doesMostRecentAssistantMessageExceed200k,
  finalContextTokensFromLastResponse,
  tokenCountWithEstimation,
} from './utils/tokens.js'
import { ESCALATED_MAX_TOKENS } from './utils/context.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from './services/analytics/growthbook.js'
import { SLEEP_TOOL_NAME } from './tools/SleepTool/prompt.js'
import { executePostSamplingHooks } from './utils/hooks/postSamplingHooks.js'
import { executeStopFailureHooks } from './utils/hooks.js'
import type { QuerySource } from './constants/querySource.js'
import { createDumpPromptsFetch } from './services/api/dumpPrompts.js'
import { StreamingToolExecutor } from './services/tools/StreamingToolExecutor.js'
import { queryCheckpoint } from './utils/queryProfiler.js'
import { runTools } from './services/tools/toolOrchestration.js'
import { applyToolResultBudget } from './utils/toolResultStorage.js'
import { recordContentReplacement } from './utils/sessionStorage.js'
import { handleStopHooks } from './query/stopHooks.js'
import { buildQueryConfig } from './query/config.js'
import { productionDeps, type QueryDeps } from './query/deps.js'
import type { Terminal, Continue } from './query/transitions.js'
import { feature } from 'bun:bundle'
import {
  getCurrentTurnTokenBudget,
  getTurnOutputTokens,
  incrementBudgetContinuationCount,
} from './bootstrap/state.js'
import { createBudgetTracker, checkTokenBudget } from './query/tokenBudget.js'
import { count } from './utils/array.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const taskSummaryModule = feature('BG_SESSIONS')
  ? (require('./utils/taskSummary.js') as typeof import('./utils/taskSummary.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

function* yieldMissingToolResultBlocks(
  assistantMessages: AssistantMessage[],
  errorMessage: string,
) {
  for (const assistantMessage of assistantMessages) {
    // 从此助手消息中提取所有 tool_use 块
    const toolUseBlocks = assistantMessage.message.content.filter(
      content => content.type === 'tool_use',
    ) as ToolUseBlock[]

    // 为每个 tool_use 生成一条中断消息
    for (const toolUse of toolUseBlocks) {
      yield createUserMessage({
        content: [
          {
            type: 'tool_result',
            content: errorMessage,
            is_error: true,
            tool_use_id: toolUse.id,
          },
        ],
        toolUseResult: errorMessage,
        sourceToolAssistantUUID: assistantMessage.uuid,
      })
    }
  }
}

/**
 * 思考块的规则冗长且微妙，需要深思熟虑才能理解。
 *
 * 规则如下：
 * 1. 包含 thinking 或 redacted_thinking 块的消息，必须属于 max_thinking_length > 0 的查询
 * 2. thinking 块不能是消息中的最后一个块
 * 3. thinking 块必须在整个助手轨迹期间保留（单轮对话，或如果该轮包含 tool_use，则还包括其后续的 tool_result 和下一个助手消息）
 *
 * 牢记这些规则，否则你将面临一整天的调试和抓狂。
 */
const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * 这是 max_output_tokens 错误消息吗？如果是，流式循环应暂不向 SDK 调用者暴露，
 * 直到确认恢复循环是否能继续。提前暴露会导致 SDK 调用者（如 cowork/desktop）
 * 看到中间错误并终止会话——而恢复循环仍在运行但已无人监听。
 *
 * 与 reactiveCompact.isWithheldPromptTooLong 对称。
 */
function isWithheldMaxOutputTokens(
  msg: Message | StreamEvent | undefined,
): msg is AssistantMessage {
  return msg?.type === 'assistant' && msg.apiError === 'max_output_tokens'
}

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  // API task_budget（output_config.task_budget，beta task-budgets-2026-03-13）。
  // 与 tokenBudget +500k 自动续写功能不同。`total` 是整个 agentic turn 的预算；
  // `remaining` 根据累计 API 用量逐轮计算。参见 claude.ts 中的 configureTaskBudgetParams。
  taskBudget?: { total: number }
  deps?: QueryDeps
}

// -- 查询循环状态

// 循环迭代间携带的可变状态
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  // 上一轮迭代为何继续。首次迭代时为 undefined。
  // 让测试可以断言恢复路径是否触发，而无需检查消息内容。
  transition: Continue | undefined
}

export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  const consumedCommandUuids: string[] = []
  const terminal = yield* queryLoop(params, consumedCommandUuids)
  // 仅在 queryLoop 正常返回时到达。throw（错误通过 yield* 传播）和 .return()
  //（Return 完成关闭两个生成器）时跳过。这与 print.ts 的 drainCommandQueue
  // 在 turn 失败时给出相同的非对称 started-without-completed 信号。
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal
}

async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // 不可变参数 —— 查询循环期间不会重新赋值。
  const {
    systemPrompt,
    userContext,
    systemContext,
    canUseTool,
    fallbackModel,
    querySource,
    maxTurns,
    skipCacheWrite,
  } = params
  const deps = params.deps ?? productionDeps()

  // 跨迭代的可变状态。循环体在每次迭代顶部解构它，
  // 以便直接用裸名读取（`messages`、`toolUseContext`）。
  // Continue 点用 `state = { ... }` 整体赋值，而非 9 个单独赋值。
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  // task_budget.remaining 跨压缩边界的追踪。首次压缩前为 undefined ——
  // 未压缩时服务端能看到完整历史并自己处理倒计时（见
  // api/api/sampling/prompt/renderer.py:292）。压缩后服务端只能看到摘要，
  // 会低估消耗；remaining 告诉它被摘要掉的压缩前最终窗口。跨多次压缩
  // 累计：每次减去该次压缩触发点的最终上下文。循环局部变量（不在 State 上）
  // 以避免触碰 7 个 continue 点。
  let taskBudgetRemaining: number | undefined = undefined

  // 在入口处快照不可变的 env/statsig/session 状态。详见 QueryConfig
  // 了解包含哪些内容以及为何故意排除 feature() 门控。
  const config = buildQueryConfig()

  // 每个用户 turn 触发一次 —— prompt 在循环迭代间不变，
  // 所以每次迭代触发会向 sideQuery 问 N 次相同问题。
  // 消费点轮询 settledAt（永不阻塞）。`using` 在所有生成器退出路径上
  // 自动释放 —— 详见 MemoryPrefetch 的释放/遥测语义。
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 在每次迭代顶部解构状态。只有 toolUseContext 会在迭代内被重新赋值
    //（queryTracking、messages 更新）；其余在 continue 点之间只读。
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state

    // 技能发现预取 —— 每次迭代执行（使用 findWritePivot 守卫在非写入迭代上
    // 提前返回）。发现过程在模型流式输出和工具执行期间运行；与内存预取
    // 一起在工具完成后消费。替代了在 getAttachmentMessages 内运行的阻塞式
    // assistant_turn 路径（97% 的调用在生产环境中什么都没找到）。
    // Turn-0 的用户输入发现仍在 userInputAttachments 中阻塞 —— 那是唯一
    // 没有前置工作可以隐藏的信号。
    const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )

    yield { type: 'stream_request_start' }

    queryCheckpoint('query_fn_entry')

    // 记录查询开始，用于 headless 延迟追踪（跳过子 Agent）
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // 初始化或递增查询链追踪
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const queryChainIdForAnalytics =
      queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    let tracking = autoCompactTracking

    // 按消息级别执行工具结果大小的聚合预算。在 microcompact 之前运行 ——
    // 缓存式 MC 纯粹按 tool_use_id 操作（不检查内容），所以内容替换对它
    // 透明，两者干净组合。contentReplacementState 为 undefined 时为空操作（功能关闭）。
    // 仅对 resume 时会读回记录的 querySource 持久化：agentId 路由到 sidechain
    // 文件（AgentTool resume）或 session 文件（/resume）。临时的 runForkedAgent
    // 调用者（agent_summary 等）不持久化。
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? records =>
            void recordContentReplacement(
              records,
              toolUseContext.agentId,
            ).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
    )

    // 在 microcompact 之前应用 snip（两者可能同时运行 —— 不互斥）。
    // snipTokensFreed 传递给 autocompact，使其阈值检查反映 snip 移除的量；
    // tokenCountWithEstimation 单独看不到（它读取受保护尾部助手的 usage，
    // 该部分在 snip 后不变）。
    let snipTokensFreed = 0
    if (feature('HISTORY_SNIP')) {
      queryCheckpoint('query_snip_start')
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
      snipTokensFreed = snipResult.tokensFreed
      if (snipResult.boundaryMessage) {
        yield snipResult.boundaryMessage
      }
      queryCheckpoint('query_snip_end')
    }

    // 在 autocompact 之前应用 microcompact
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    // 对于缓存的 microcompact（缓存编辑），推迟边界消息到 API 响应之后，
    // 以便使用实际的 cache_deleted_input_tokens。
    // 由 feature() 门控，确保该字符串从外部构建中消除。
    const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
      ? microcompactResult.compactionInfo?.pendingCacheEdits
      : undefined
    queryCheckpoint('query_microcompact_end')

    // 投射折叠的上下文视图，可能提交更多折叠。在 autocompact 之前运行，
    // 这样如果折叠使我们低于 autocompact 阈值，autocompact 就不会执行，
    // 我们保留粒度化的上下文而非单一摘要。
    //
    // 不产出任何内容 —— 折叠视图是对 REPL 完整历史的读取时投影。
    // 摘要消息存储在折叠存储中，而非 REPL 数组。这就是折叠跨 turn
    // 持久化的原因：projectView() 在每次进入时重放提交日志。
    // 在一个 turn 内，视图通过 continue 点的 state.messages 向前流动，
    // 下一次 projectView() 不执行任何操作，因为已归档的消息已从其输入中移除。
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = collapseResult.messages
    }

    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
      snipTokensFreed,
    )
    queryCheckpoint('query_autocompact_end')

    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      logEvent('tengu_auto_compact_succeeded', {
        originalMessageCount: messages.length,
        compactedMessageCount:
          compactionResult.summaryMessages.length +
          compactionResult.attachments.length +
          compactionResult.hookResults.length,
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionInputTokens: compactionUsage?.input_tokens,
        compactionOutputTokens: compactionUsage?.output_tokens,
        compactionCacheReadTokens:
          compactionUsage?.cache_read_input_tokens ?? 0,
        compactionCacheCreationTokens:
          compactionUsage?.cache_creation_input_tokens ?? 0,
        compactionTotalTokens: compactionUsage
          ? compactionUsage.input_tokens +
            (compactionUsage.cache_creation_input_tokens ?? 0) +
            (compactionUsage.cache_read_input_tokens ?? 0) +
            compactionUsage.output_tokens
          : 0,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // task_budget：在 messagesForQuery 被下面的 postCompactMessages 替换之前，
      // 捕获压缩前的最终上下文窗口。iterations[-1] 是权威的最终窗口
      //（服务端工具循环之后）；见 #304930。
      if (params.taskBudget) {
        const preCompactContext =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // 每次压缩时重置，使 turnCounter/turnId 反映最新一次压缩。
      // recompactionInfo（autoCompact.ts:190）在调用前已捕获
      // turnsSincePreviousCompact/previousCompactTurnId 的旧值，
      // 所以这个重置不会丢失那些信息。
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      for (const message of postCompactMessages) {
        yield message
      }

      // 使用压缩后的消息继续当前查询调用
      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // Autocompact 失败 —— 传播失败计数，以便熔断器在下次迭代时停止重试。
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    //TODO: 设置时不需要给 toolUseContext.messages 赋值，因为在这里已经更新了
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }

    const assistantMessages: AssistantMessage[] = []
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // @see https://docs.claude.com/en/docs/build-with-claude/tool-use
    // 注意：stop_reason === 'tool_use' 不可靠 —— 不总是正确设置。
    // 在流式传输期间每当 tool_use 块到达时设置 —— 唯一的循环退出信号。
    // 如果流式传输后为 false，则表示完成（除了 stop-hook 重试）。
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    const useStreamingToolExecution = config.gates.streamingToolExecution
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })

    queryCheckpoint('query_setup_end')

    // 每个查询会话只创建一次 fetch 包装器，避免内存滞留。
    // 每次调用 createDumpPromptsFetch 都会创建一个捕获请求体的闭包。
    // 只创建一次意味着只保留最新的请求体（~700KB），
    // 而非会话中的所有请求体（长会话可达 ~500MB）。
    // 注意：agentId 在一次 query() 调用期间实际上是常量 —— 它只在
    // 查询之间改变（如 /clear 命令或会话恢复）。
    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    // 达到硬性阻塞限制时阻塞（仅在自动压缩关闭时生效）
    // 这保留空间以便用户仍可手动运行 /compact
    // 如果刚发生过压缩则跳过此检查 —— 压缩结果已验证在阈值之下，
    // 而 tokenCountWithEstimation 会使用保留消息中反映压缩前上下文大小的
    // 过期 input_tokens。snip 同理：减去 snipTokensFreed
    //（否则在 snip 将我们降到 autocompact 阈值以下、但过期用量仍在
    // 阻塞限制之上的窗口期会误阻塞——此 PR 之前该窗口不存在，因为
    // autocompact 总是基于过期计数触发）。
    // compact/session_memory 查询也跳过 —— 这些是 fork 的 Agent，
    // 继承完整对话，在此阻塞会死锁（compact Agent 需要运行才能减少 token 数）。
    // 启用 reactive compact 且允许自动压缩时也跳过 —— 抢占式合成错误
    // 在 API 调用之前就返回了，reactive compact 永远看不到
    // prompt-too-long 来响应。扩展到 walrus 条件以便 RC 在主动式失败时
    // 作为后备。
    //
    // context-collapse 同理跳过：其 recoverFromOverflow 在真实 API 413 上
    // 排空已暂存的折叠，然后落到 reactiveCompact。此处的合成抢占会在
    // API 调用前返回，饿死两条恢复路径。isAutoCompactEnabled() 合取
    // 保留用户显式"不自动做任何事"的配置 —— 如果设置了 DISABLE_AUTO_COMPACT，
    // 就执行抢占。
    let collapseOwnsIt = false
    if (feature('CONTEXT_COLLAPSE')) {
      collapseOwnsIt =
        (contextCollapse?.isContextCollapseEnabled() ?? false) &&
        isAutoCompactEnabled()
    }
    // 每 turn 提升一次媒体恢复门控。流循环内的扣留和之后的恢复必须一致；
    // CACHED_MAY_BE_STALE 可能在 5-30 秒的流式传输期间翻转，
    // 扣留但不恢复会吞掉消息。PTL 不提升是因为其扣留是无门控的 ——
    // 它早于实验且已是对照组基线。
    const mediaRecoveryEnabled =
      reactiveCompact?.isReactiveCompactEnabled() ?? false
    if (
      !compactionResult &&
      querySource !== 'compact' &&
      querySource !== 'session_memory' &&
      !(
        reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()
      ) &&
      !collapseOwnsIt
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    let attemptWithFallback = true

    queryCheckpoint('query_api_loop_start')
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')
          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              ...(config.gates.fastModeEnabled && {
                fastMode: appState.fastMode,
              }),
              toolChoice: undefined,
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes:
                toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt:
                !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride,
              fetchOverride: dumpPromptsFetch,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some(
                c => c.type === 'pending',
              ),
              queryTracking,
              effortValue: appState.effortValue,
              advisorModel: appState.advisorModel,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
            },
          })) {
            // We won't use the tool_calls from the first attempt
            // We could.. but then we'd have to merge assistant messages
            // with different ids and double up on full the tool_results
            if (streamingFallbackOccured) {
              // 为孤立消息生成墓碑，以便从 UI 和 transcript 中移除。
              // 这些部分消息（特别是 thinking 块）有无效签名，
              // 会导致 "thinking blocks cannot be modified" API 错误。
              for (const msg of assistantMessages) {
                yield { type: 'tombstone' as const, message: msg }
              }
              logEvent('tengu_orphaned_messages_tombstoned', {
                orphanedMessageCount: assistantMessages.length,
                queryChainId: queryChainIdForAnalytics,
                queryDepth: queryTracking.depth,
              })

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              // 丢弃失败流式尝试的待处理结果，创建新的执行器。
              // 防止孤立的 tool_results（带旧 tool_use_id）在后备响应到达后
              // 被产出。
              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }
            // 在 yield 之前对克隆消息回填 tool_use 输入，以便 SDK 流输出
            // 和 transcript 序列化能看到遗留/派生字段。原始 `message` 保持不变，
            // 用于下面的 assistantMessages.push —— 它会回传给 API，
            // 修改它会破坏 prompt 缓存（字节不匹配）。
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              let clonedContent: typeof message.message.content | undefined
              for (let i = 0; i < message.message.content.length; i++) {
                const block = message.message.content[i]!
                if (
                  block.type === 'tool_use' &&
                  typeof block.input === 'object' &&
                  block.input !== null
                ) {
                  const tool = findToolByName(
                    toolUseContext.options.tools,
                    block.name,
                  )
                  if (tool?.backfillObservableInput) {
                    const originalInput = block.input as Record<string, unknown>
                    const inputCopy = { ...originalInput }
                    tool.backfillObservableInput(inputCopy)
                    // 仅在回填新增字段时才克隆；如果只是覆盖已有字段则跳过
                    //（如文件工具展开 file_path）。覆盖会改变序列化的 transcript，
                    // 破坏恢复时的 VCR fixture 哈希，同时 SDK 流不需要 ——
                    // hooks 通过 toolExecution.ts 单独获取展开路径。
                    const addedFields = Object.keys(inputCopy).some(
                      k => !(k in originalInput),
                    )
                    if (addedFields) {
                      clonedContent ??= [...message.message.content]
                      clonedContent[i] = { ...block, input: inputCopy }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: { ...message.message, content: clonedContent },
                }
              }
            }
            // 暂不暴露可恢复的错误（prompt-too-long、max-output-tokens），
            // 直到确认恢复（折叠排空 / reactive compact / 截断重试）能否成功。
            // 仍推入 assistantMessages，以便下面的恢复检查能找到它们。
            // 任一子系统的扣留都足够 —— 它们独立，关闭一个不会破坏另一个的
            // 恢复路径。
            //
            // feature() 仅在 if/三元表达式中生效（bun:bundle 的 tree-shaking
            // 约束），所以 collapse 检查是嵌套的而非组合的。
            let withheld = false
            if (feature('CONTEXT_COLLAPSE')) {
              if (
                contextCollapse?.isWithheldPromptTooLong(
                  message,
                  isPromptTooLongMessage,
                  querySource,
                )
              ) {
                withheld = true
              }
            }
            if (reactiveCompact?.isWithheldPromptTooLong(message)) {
              withheld = true
            }
            if (
              mediaRecoveryEnabled &&
              reactiveCompact?.isWithheldMediaSizeError(message)
            ) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }
            if (!withheld) {
              yield yieldMessage
            }
            if (message.type === 'assistant') {
              assistantMessages.push(message)

              const msgToolUseBlocks = message.message.content.filter(
                content => content.type === 'tool_use',
              ) as ToolUseBlock[]
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }

              if (
                streamingToolExecutor &&
                !toolUseContext.abortController.signal.aborted
              ) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, message)
                }
              }
            }

            if (
              streamingToolExecutor &&
              !toolUseContext.abortController.signal.aborted
            ) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter(_ => _.type === 'user'),
                  )
                }
              }
            }
          }
          queryCheckpoint('query_api_streaming_end')

          // 使用 API 实际报告的 token 删除计数（而非客户端估算）产出延迟的
          // microcompact 边界消息。整个块由 feature() 门控，确保排除的字符串
          // 从外部构建中消除。
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            // API 字段是跨请求累计/粘性的，所以减去此请求前捕获的基线得到增量。
            const usage = lastAssistant?.message.usage
            const cumulativeDeleted = usage
              ? ((usage as unknown as Record<string, number>)
                  .cache_deleted_input_tokens ?? 0)
              : 0
            const deletedTokens = Math.max(
              0,
              cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
            )
            if (deletedTokens > 0) {
              yield createMicrocompactBoundaryMessage(
                pendingCacheEdits.trigger,
                0,
                deletedTokens,
                pendingCacheEdits.deletedToolIds,
                [],
              )
            }
          }
        } catch (innerError) {
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            // 触发了后备模型切换 —— 切换模型并重试
            currentModel = fallbackModel
            attemptWithFallback = true

            // 清空助手消息，因为将重试整个请求
            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            // 丢弃失败尝试的待处理结果，创建新的执行器。
            // 防止孤立的 tool_results（带旧 tool_use_id）泄漏到重试中。
            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // 用新模型更新工具使用上下文
            toolUseContext.options.mainLoopModel = fallbackModel

            // thinking 签名与模型绑定：将受保护的 thinking 块（如 capybara）
            // 重放到不受保护的后备模型（如 opus）会返回 400。
            // 重试前剥离签名，使后备模型得到干净的历史。
            if (process.env.USER_TYPE === 'ant') {
              messagesForQuery = stripSignatureBlocks(messagesForQuery)
            }

            // 记录后备切换事件
            logEvent('tengu_model_fallback_triggered', {
              original_model:
                innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              entrypoint:
                'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            // 产出关于后备切换的系统消息 —— 使用 'warning' 级别，
            // 用户无需 verbose 模式即可看到通知
            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )

            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logEvent('tengu_query_error', {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap(_ =>
          _.message.content.filter(content => content.type === 'tool_use'),
        ).length,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // 处理图片大小/调整大小的错误，使用用户友好的消息
      if (
        error instanceof ImageSizeError ||
        error instanceof ImageResizeError
      ) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // 通常 queryModelWithStreaming 不应抛出错误，而是将错误作为合成助手消息
      // 产出。但如果因 bug 抛出异常，我们可能处于已发出 tool_use 块但
      // 未发出 tool_result 的状态。
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      // 暴露真实错误而非误导性的"[Request interrupted by user]" ——
      // 这条路径是模型/运行时失败，而非用户操作。SDK 消费者之前看到
      // 幽灵中断（如 Node 18 缺少 Array.prototype.with()），掩盖了真正原因。
      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      // 为追踪 bug，向内部大声记录日志
      logAntError('Query error', error)
      return { reason: 'model_error', error }
    }

    // 模型响应完成后执行后采样 hooks
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // 需要先处理流式中断。使用 streamingToolExecutor 时，必须消费
    // getRemainingResults()，以便执行器为排队中/进行中的工具生成
    // 合成 tool_result 块。否则 tool_use 块将缺少匹配的 tool_result 块。
    if (toolUseContext.abortController.signal.aborted) {
      if (streamingToolExecutor) {
        // 消费剩余结果 —— 执行器为已中断的工具生成合成 tool_results，
        // 因为它在 executeTool() 中检查了中断信号
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          'Interrupted by user',
        )
      }
      // chicago MCP：中断时自动取消隐藏 + 释放锁。与 stopHooks.ts 中自然
      // turn 结束路径的清理相同。仅限主线程 —— 见 stopHooks.ts 了解子 Agent
      // 释放主线程锁的原因。
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // Failures are silent — this is dogfooding cleanup, not critical path
        }
      }

      // Skip the interruption message for submit-interrupts — the queued
      // user message that follows provides sufficient context.
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      return { reason: 'aborted_streaming' }
    }

    // 产出上一轮的工具使用摘要 —— haiku（~1s）在模型流式传输期间（5-30s）已解析完成
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // Prompt-too-long 恢复：流式循环扣留了错误（见上 withheldByCollapse /
      // withheldByReactive）。先尝试折叠排空（代价低，保留粒度化上下文），
      // 然后 reactive compact（完整摘要）。各阶段单次尝试 —— 如果重试
      // 仍然 413，下一阶段处理或错误浮现。
      const isWithheld413 =
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage &&
        isPromptTooLongMessage(lastMessage)
      // 媒体大小拒绝（图片/PDF/多图片）可通过 reactive compact 的
      // strip-retry 恢复。与 PTL 不同，媒体错误跳过折叠排空 ——
      // 折叠不剥离图片。mediaRecoveryEnabled 是流循环前提升的门控
      //（与扣留检查同值 —— 两者必须一致，否则扣留的消息会丢失）。
      // 如果超大媒体在受保护的尾部，压缩后的 turn 会再次触发媒体错误；
      // hasAttemptedReactiveCompact 防止死循环，错误浮现。
      const isWithheldMedia =
        mediaRecoveryEnabled &&
        reactiveCompact?.isWithheldMediaSizeError(lastMessage)
      if (isWithheld413) {
        // 首先排空所有已暂存的上下文折叠。门控条件是上一次 transition
        // 不是 collapse_drain_retry —— 如果已排空但重试仍 413，
        // 落到 reactive compact。
        if (
          feature('CONTEXT_COLLAPSE') &&
          contextCollapse &&
          state.transition?.reason !== 'collapse_drain_retry'
        ) {
          const drained = contextCollapse.recoverFromOverflow(
            messagesForQuery,
            querySource,
          )
          if (drained.committed > 0) {
            const next: State = {
              messages: drained.messages,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              transition: {
                reason: 'collapse_drain_retry',
                committed: drained.committed,
              },
            }
            state = next
            continue
          }
        }
      }
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        const compacted = await reactiveCompact.tryReactiveCompact({
          hasAttempted: hasAttemptedReactiveCompact,
          querySource,
          aborted: toolUseContext.abortController.signal.aborted,
          messages: messagesForQuery,
          cacheSafeParams: {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
        })

        if (compacted) {
          // task_budget：与上面主动路径相同的结转。messagesForQuery 在此仍持有
          // 压缩前的数组（413 失败尝试的输入）。
          if (params.taskBudget) {
            const preCompactContext =
              finalContextTokensFromLastResponse(messagesForQuery)
            taskBudgetRemaining = Math.max(
              0,
              (taskBudgetRemaining ?? params.taskBudget.total) -
                preCompactContext,
            )
          }

          const postCompactMessages = buildPostCompactMessages(compacted)
          for (const msg of postCompactMessages) {
            yield msg
          }
          const next: State = {
            messages: postCompactMessages,
            toolUseContext,
            autoCompactTracking: undefined,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact: true,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'reactive_compact_retry' },
          }
          state = next
          continue
        }

        // 无法恢复 —— 暴露被扣留的错误并退出。不要落到 stop hooks：
        // 模型从未产出有效响应，hooks 没有有意义的内容可评估。对
        // prompt-too-long 运行 stop hooks 会造成死循环：
        // error → hook blocking → retry → error → …（hook 每轮注入更多 token）。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
      } else if (feature('CONTEXT_COLLAPSE') && isWithheld413) {
        // reactiveCompact 已编译移除，但 contextCollapse 扣留了错误且
        // 无法恢复（暂存队列为空/过期）。暴露错误。同样的提前返回原因 ——
        // 不要落到 stop hooks。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'prompt_too_long' }
      }

      // 检查 max_output_tokens 并注入恢复消息。错误在流中已被扣留；
      // 仅在恢复用尽时才暴露。
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // 逐步升级重试：如果使用了默认的 8k 上限并达到限制，用 64k 重试
        // 同一请求 —— 无 meta 消息，无多轮交互。每 turn 触发一次
        //（由 override 检查守卫），如果 64k 也达到上限，则落到多轮恢复。
        // 第三方默认：false（未在 Bedrock/Vertex 上验证）
        const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_otk_slot_v1',
          false,
        )
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ) {
          logEvent('tengu_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: State = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // 恢复已用尽 —— 现在暴露被扣留的错误。
        yield lastMessage
      }

      // 最后一条消息是 API 错误时跳过 stop hooks（限速、prompt-too-long、
      // 认证失败等）。模型从未产出真实响应 —— hooks 评估它会造成死循环：
      // error → hook blocking → retry → error → …
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'completed' }
      }

      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
      )

      if (stopHookResult.preventContinuation) {
        return { reason: 'stop_hook_prevented' }
      }

      if (stopHookResult.blockingErrors.length > 0) {
        const next: State = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          // 保留 reactive compact 守卫 —— 如果 compact 已运行且无法从
          // prompt-too-long 恢复，在 stop-hook blocking 错误后重试会得到
          // 相同结果。在此重置为 false 曾导致无限循环：
          // compact → still too long → error → stop hook blocking → compact → …
          // 消耗数千次 API 调用。
          hasAttemptedReactiveCompact,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            logForDebugging(
              `Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
            )
          }
          logEvent('tengu_token_budget_completed', {
            ...decision.completionEvent,
            queryChainId: queryChainIdForAnalytics,
            queryDepth: queryTracking.depth,
          })
        }
      }

      return { reason: 'completed' }
    }

    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    queryCheckpoint('query_tool_execution_start')


    if (streamingToolExecutor) {
      logEvent('tengu_streaming_tool_execution_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    } else {
      logEvent('tengu_streaming_tool_execution_not_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        if (
          update.message.type === 'attachment' &&
          update.message.attachment.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    queryCheckpoint('query_tool_execution_end')

    // 工具批次完成后生成工具使用摘要 —— 传递给下一次递归调用
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId // subagents don't surface in mobile UI — skip the Haiku call
    ) {
      // 提取最后的助手文本块作为上下文
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = lastAssistantMessage.message.content.filter(
          block => block.type === 'text',
        )
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      // 收集工具信息用于摘要生成
      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        // 找到对应的 tool_result
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      // 启动摘要生成而不阻塞下一个 API 调用
      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    // 在工具调用期间被中断
    if (toolUseContext.abortController.signal.aborted) {
      // chicago MCP：工具调用中被中断时自动取消隐藏 + 释放锁。
      // 这是 CU 最可能的 Ctrl+C 路径（如慢速截图）。
      // 仅限主线程 —— 见 stopHooks.ts 了解子 Agent 的原因。
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // Failures are silent — this is dogfooding cleanup, not critical path
        }
      }
      // Skip the interruption message for submit-interrupts — the queued
      // user message that follows provides sufficient context.
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: true,
        })
      }
      // 中断时返回前检查 maxTurns
      const nextTurnCountOnAbort = turnCount + 1
      if (maxTurns && nextTurnCountOnAbort > maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      return { reason: 'aborted_tools' }
    }

    // 如果 hook 指示阻止继续，在此停止
    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    if (tracking?.compacted) {
      tracking.turnCounter++
      logEvent('tengu_post_autocompact_turn', {
        turnId:
          tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        turnCounter: tracking.turnCounter,

        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // 注意：必须在工具调用完成后再做这些，因为 API 会拒绝
    // tool_result 消息与普通用户消息交错。

    // 插桩：追踪附件处理前的消息数量
    logEvent('tengu_query_before_attachments', {
      messagesForQueryCount: messagesForQuery.length,
      assistantMessagesCount: assistantMessages.length,
      toolResultsCount: toolResults.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在处理附件前获取排队命令的快照。
    // 这些将作为附件发送，以便 Claude 在当前 turn 中响应它们。
    //
    // 排空待处理通知。LocalShellTask 完成是 'next'（当 MONITOR_TOOL 开启时）
    // 且无需 Sleep 即可排空。其他任务类型（agent/workflow/framework）仍默认
    // 'later' —— Sleep flush 覆盖那些。如果所有任务类型都迁移到 'next'，
    // 此分支可移除。
    //
    // Slash 命令从 turn 中段排空中排除 —— 它们必须通过 processSlashCommand
    // 在 turn 结束后处理（经由 useQueueProcessor），而非作为文本发给模型。
    // Bash 模式命令已被 getQueuedCommandAttachments 中的
    // INLINE_NOTIFICATION_MODES 排除。
    //
    // Agent 作用域：队列是进程级单例，由协调器和所有进程内子 Agent 共享。
    // 每个循环只排空发给自己的内容 —— 主线程排空 agentId===undefined，
    // 子 Agent 排空自己的 agentId。用户提示（mode:'prompt'）仍只发到
    // 主线程；子 Agent 永远看不到提示流。
    // eslint-disable-next-line custom-rules/require-tool-match-name -- ToolUseBlock.name has no aliases
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = getCommandsByMaxPriority(
      sleepRan ? 'later' : 'next',
    ).filter(cmd => {
      if (isSlashCommand(cmd)) return false
      if (isMainThread) return cmd.agentId === undefined
      // 子 Agent 只排空发给自己的 task-notification —— 永远不排空
      // 用户提示，即使有人给它盖了 agentId。
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    })

    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // 内存预取消费：仅在已就绪且未在更早迭代中被消费时。
    // 如果尚未就绪，跳过（零等待）下次迭代重试 —— 预取在 turn 结束前
    // 有和循环迭代一样多的机会。readFileState（跨迭代累计）过滤掉
    // 模型已经 Read/Wrote/Edited 的记忆 —— 包括更早迭代中的，
    // 这是每次迭代的 toolUseBlocks 数组会遗漏的。
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }


    // 注入预取的技能发现。collectSkillDiscoveryPrefetch 发出
    // hidden_by_main_turn —— 当预取在此点之前解析完成时为 true
    //（AKI@250ms / Haiku@573ms vs turn 持续时间 2-30s，应 >98%）。
    if (skillPrefetch && pendingSkillPrefetch) {
      const skillAttachments =
        await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)
      for (const att of skillAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // 仅移除实际被消费为附件的命令。
    // prompt 和 task-notification 命令在上面被转换为附件。
    const consumedCommands = queuedCommandsSnapshot.filter(
      cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    // 插桩：追踪添加后的文件变更附件
    const fileChangeAttachmentCount = count(
      toolResults,
      tr =>
        tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )

    logEvent('tengu_query_after_attachments', {
      totalToolResultsCount: toolResults.length,
      fileChangeAttachmentCount,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 在 turn 之间刷新工具列表，使新连接的 MCP 服务器可用
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // 每次我们有工具结果并即将递归时，就是一个 turn
    const nextTurnCount = turnCount + 1

    // `claude ps` 的定期任务摘要 —— 在 turn 中段触发，使长时间运行的
    // Agent 仍能刷新工作状态。仅以 !agentId 门控，使所有顶级对话
    //（REPL、SDK、HFI、remote）都生成摘要；子 Agent/fork 不生成。
    if (feature('BG_SESSIONS')) {
      if (
        !toolUseContext.agentId &&
        taskSummaryModule!.shouldGenerateTaskSummary()
      ) {
        taskSummaryModule!.maybeGenerateTaskSummary({
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...toolResults,
          ],
        })
      }
    }

    // 检查是否达到最大轮次限制
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    queryCheckpoint('query_recursive_call')
    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // while (true)
}
