import { nanoid } from "nanoid";
import type OpenAI from "openai";
import { client, MODEL } from "./llm.js";
import { Context, addEvent } from "./context.js";
import type { MessageDBRow } from "./context.js";
import {
  estimateMessageTokens,
  estimateToolOverhead,
  deriveBudget,
  shouldCompact,
  findCompactableMessages,
  applyCompaction,
} from "./token-budget.js";
import { log as centralLog } from "./logger.js";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export interface ToolHandler {
  definition: ChatCompletionTool;
  handler: (args: Record<string, unknown>, ctx: Context) => Promise<unknown>;
  /** If true, calling this tool immediately ends the agent loop and returns its result */
  terminates?: boolean;
}

export interface AgentStats {
  iterations: number;
  promptTokens: number;
  completionTokens: number;
}

export interface AgentLoopResult {
  result: string;
  stats: AgentStats;
}

export type LogFn = (agent: string, message: string) => void;

export interface AgentLoopOptions {
  name: string;
  systemPrompt: string;
  tools: ToolHandler[];
  userMessage: string;
  ctx: Context;
  maxIterations?: number;
  parentNodeId?: string;
  tokenBudget?: number;
  /** If true, the agent can finish with a text response without being nudged to use tools */
  allowTextResponse?: boolean;
  /** Custom log function; defaults to console.log with timestamp prefix */
  logFn?: LogFn;
  /** Override tool call budget (default: orchestrator=20, others=12) */
  toolCallBudget?: number;
  /** Override tool batch size (default: 5) */
  toolBatchSize?: number;
  /** Override temperature (default: 0.7) */
  temperature?: number;
  /** Override model (default: global MODEL) */
  model?: string;
  /** Override max nudge count (default: 3) */
  maxNudges?: number;
  /** Override LLM client (default: global client) */
  llmClient?: OpenAI;
  /** Custom nudge strategy — returns a nudge message or null */
  nudgeStrategy?: (ctx: Context, agentName: string) => string | null;
  /** Override retry config (default: { maxAttempts: 3, baseDelayMs: 1000 }) */
  retryConfig?: { maxAttempts: number; baseDelayMs: number };
  /** Compaction thresholds */
  compactionTrigger?: number;
  compactionTarget?: number;
}

function defaultLog(agent: string, message: string): void {
  centralLog(agent, message);
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Strip <think>...</think> blocks that reasoning models emit */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

/** Convert a DB message row to the OpenAI ChatCompletionMessageParam format */
function dbRowToMessage(row: MessageDBRow): ChatCompletionMessageParam {
  switch (row.role) {
    case "system":
      return { role: "system", content: row.content || "" };
    case "user":
      return { role: "user", content: row.content || "" };
    case "tool":
      return { role: "tool", content: row.content || "", tool_call_id: row.tool_call_id! };
    case "assistant": {
      const msg: Record<string, unknown> = { role: "assistant" };
      if (row.content !== null) msg.content = row.content;
      if (row.tool_calls_json) msg.tool_calls = JSON.parse(row.tool_calls_json);
      return msg as unknown as ChatCompletionMessageParam;
    }
    default:
      return { role: "user", content: row.content || "" };
  }
}

export async function agentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const { name, systemPrompt, tools, userMessage, ctx, maxIterations = 15, tokenBudget, allowTextResponse } = opts;
  const log = opts.logFn ?? defaultLog;
  const llmClient = opts.llmClient ?? client;
  const llmModel = opts.model ?? MODEL;
  const temperature = opts.temperature ?? 0.7;
  const maxNudges = opts.maxNudges ?? 3;
  const toolBatchSize = opts.toolBatchSize ?? 5;
  const retryConfig = opts.retryConfig ?? { maxAttempts: 3, baseDelayMs: 1000 };

  const toolDefs = tools.map((t) => t.definition);
  const toolOverhead = estimateToolOverhead(toolDefs);

  // Derive budget: explicit override > role-based derivation from model context
  const budget = tokenBudget || deriveBudget(0.30, toolOverhead);

  log(name, `started (budget: ~${budget} tokens, tool overhead: ~${toolOverhead})`);

  // Token usage accumulator
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  addEvent(ctx, {
    source: name,
    target: name,
    type: "agent_start",
    input: { userMessage },
  });

  // Unique agent ID for message storage — each loop invocation gets its own namespace
  const agentId = nanoid(12);

  // Store initial messages in DB instead of in-memory array
  ctx.db.insertMessage(ctx.sessionId, agentId, 0, {
    role: "system",
    content: systemPrompt,
  });
  ctx.db.insertMessage(ctx.sessionId, agentId, 1, {
    role: "user",
    content: userMessage,
  });
  let nextSeq = 2;

  const toolMap = new Map(
    tools.map((t) => [t.definition.function.name, t])
  );

  let nudgeCount = 0;
  let nonTerminatingToolCalls = 0;
  const effectiveToolCallBudget = opts.toolCallBudget ?? 12;
  const iterationThreshold = Math.floor(maxIterations * 0.8);

  // Find terminating tool name for wrap-up nudges
  const terminatingToolName = tools.find((t) => t.terminates)?.definition.function.name;

  const makeResult = (result: string, iterations: number): AgentLoopResult => ({
    result,
    stats: { iterations, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
  });

  for (let i = 0; i < maxIterations; i++) {
    // Load messages fresh from DB each iteration — prevents V8 heap fragmentation
    // from large tool result strings accumulating in a long-lived array
    let dbRows = ctx.db.getMessages(ctx.sessionId, agentId);
    let messages = dbRows.map(dbRowToMessage);

    // Compaction check before LLM call
    if (shouldCompact(messages, budget, opts.compactionTrigger)) {
      const targets = findCompactableMessages(dbRows);
      if (targets.length > 0) {
        const before = estimateMessageTokens(messages);
        const count = applyCompaction(ctx, agentId, targets, budget, before, opts.compactionTarget);
        // Reload from DB after compaction
        dbRows = ctx.db.getMessages(ctx.sessionId, agentId);
        messages = dbRows.map(dbRowToMessage);
        const after = estimateMessageTokens(messages);
        log(name, `compacted ${count} messages: ~${before} → ~${after} tokens`);
      }
    }

    log(name, `iter ${i + 1}/${maxIterations} (~${estimateMessageTokens(messages)} tokens, ${messages.length} msgs)`);

    let response!: ChatCompletion;
    for (let attempt = 0; attempt < retryConfig.maxAttempts; attempt++) {
      try {
        response = await llmClient.chat.completions.create({
          model: llmModel,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          temperature,
        });
        break;
      } catch (err: unknown) {
        const isRetryable =
          err instanceof Error &&
          (err.constructor.name === "APIConnectionTimeoutError" ||
            err.constructor.name === "APIConnectionError" ||
            ("status" in err && ((err as { status: number }).status === 429 || (err as { status: number }).status >= 500)));
        if (!isRetryable || attempt === retryConfig.maxAttempts - 1) throw err;
        const delay = Math.pow(2, attempt) * retryConfig.baseDelayMs;
        log(name, `API error (${err.constructor.name}), retrying in ${delay / 1000}s (attempt ${attempt + 2}/${retryConfig.maxAttempts})`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    // Accumulate token usage
    if (response.usage) {
      totalPromptTokens += response.usage.prompt_tokens;
      totalCompletionTokens += response.usage.completion_tokens;
    }

    const choice = response.choices[0];
    const message = choice.message;

    // Strip <think> blocks from assistant content before storing
    if (message.content) {
      message.content = stripThinkTags(message.content);
    }

    // Insert assistant message to DB
    ctx.db.insertMessage(ctx.sessionId, agentId, nextSeq++, {
      role: "assistant",
      content: message.content,
      toolCallsJson: message.tool_calls ? JSON.stringify(message.tool_calls) : undefined,
    });

    // If no tool calls — either nudge back to tool use or finish
    if (!message.tool_calls || message.tool_calls.length === 0) {
      const result = message.content || "";

      // If this agent has tools and hasn't been nudged yet, inject a reminder
      // Skip nudging for agents that are expected to produce text output (e.g. synthesizers)
      if (toolDefs.length > 0 && nudgeCount < maxNudges && !allowTextResponse) {
        nudgeCount++;

        // Use custom nudge strategy if provided, otherwise default
        let nudgeMsg = opts.nudgeStrategy?.(ctx, name) ?? "Do not respond with text. You must call a tool now.";

        log(name, `text response detected, nudging to use tools (nudge ${nudgeCount}/${maxNudges})`);
        ctx.db.insertMessage(ctx.sessionId, agentId, nextSeq++, {
          role: "user",
          content: nudgeMsg,
        });
        continue;
      }

      const tokenSummary = `${formatTokens(totalPromptTokens + totalCompletionTokens)} tokens`;
      log(name, `finished (${i + 1} iters, ~${tokenSummary})`);

      addEvent(ctx, {
        source: name,
        target: name,
        type: "agent_end",
        output: result,
        metadata: { iterations: i + 1 },
      });

      return makeResult(result, i + 1);
    }

    // Reset nudge counter after a successful tool call
    nudgeCount = 0;

    // Log tool calls
    const toolNames = message.tool_calls.map((tc) => tc.function.name);
    if (toolNames.length > 1) {
      log(name, `calling ${toolNames.length} tools in parallel: ${toolNames.join(", ")}`);
    }

    // Execute tool calls in batches to avoid memory spikes from simultaneous work
    // Use configured batch size
    const allToolCalls = message.tool_calls;
    const results: Array<{ toolCall: typeof allToolCalls[0]; result: string; terminates: boolean }> = [];

    for (let b = 0; b < allToolCalls.length; b += toolBatchSize) {
      const batch = allToolCalls.slice(b, b + toolBatchSize);
      const batchResults = await Promise.all(batch.map(async (toolCall) => {
        const fnName = toolCall.function.name;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          return { toolCall, result: "Error: invalid JSON in tool call arguments", terminates: false };
        }

        if (toolNames.length === 1) {
          const argSummary = fnName === "web_search"
            ? `"${args.query}"`
            : fnName === "research_question"
              ? `"${args.question}"`
              : "";
          log(name, `calling ${fnName}${argSummary ? ` → ${argSummary}` : ""}`);
        }

        addEvent(ctx, {
          source: name,
          target: fnName,
          type: "tool_call",
          tool: fnName,
          input: args,
        });

        const toolDef = toolMap.get(fnName);
        if (!toolDef) {
          return { toolCall, result: `Error: unknown tool "${fnName}"`, terminates: false };
        }

        try {
          const result = await toolDef.handler(args, ctx);
          const resultStr =
            typeof result === "string" ? result : JSON.stringify(result);

          addEvent(ctx, {
            source: fnName,
            target: name,
            type: "tool_result",
            tool: fnName,
            output: result,
          });

          return { toolCall, result: resultStr, terminates: toolDef.terminates === true };
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);

          addEvent(ctx, {
            source: fnName,
            target: name,
            type: "tool_result",
            tool: fnName,
            output: { error: errorMsg },
          });

          return { toolCall, result: `Error: ${errorMsg}`, terminates: false };
        }
      }));
      results.push(...batchResults);
    }

    // Track non-terminating tool calls for budget enforcement
    const terminating = results.find((r) => r.terminates);
    const nonTerminating = results.filter((r) => !r.terminates);
    nonTerminatingToolCalls += nonTerminating.length;

    // If terminating tool was the SOLE call, return immediately
    if (terminating && nonTerminating.length === 0) {
      const tokenSummary = `${formatTokens(totalPromptTokens + totalCompletionTokens)} tokens`;
      log(name, `finished via ${terminating.toolCall.function.name} (${i + 1} iters, ~${tokenSummary})`);

      addEvent(ctx, {
        source: name,
        target: name,
        type: "agent_end",
        output: terminating.result,
        metadata: { iterations: i + 1, terminatedBy: terminating.toolCall.function.name },
      });

      return makeResult(terminating.result, i + 1);
    }

    // If terminating tool was called alongside other tools, defer it:
    // append all results so the agent can review, then ask it to resubmit
    if (terminating && nonTerminating.length > 0) {
      log(name, `deferring ${terminating.toolCall.function.name} — called alongside ${nonTerminating.length} other tool(s), requiring review`);
    }

    // Insert tool results to DB
    for (const { toolCall, result } of results) {
      let content = result;
      let nodeId: string | undefined;
      try {
        const parsed = JSON.parse(result);
        if (parsed && parsed._nodeId) {
          nodeId = parsed._nodeId;
          const { _nodeId, ...rest } = parsed;
          content = JSON.stringify(rest);
        }
      } catch {
        // Not JSON, use as-is
      }

      ctx.db.insertMessage(ctx.sessionId, agentId, nextSeq++, {
        role: "tool",
        content,
        toolCallId: toolCall.id,
        nodeId,
      });
    }

    // Helper: append a nudge to the last tool result message in DB
    // to avoid role-ordering issues (some APIs reject system/user after tool).
    const appendNudgeToLastToolResult = (nudge: string) => {
      // The last inserted messages are tool results; nextSeq - 1 is the last one
      ctx.db.appendToMessageContent(ctx.sessionId, agentId, nextSeq - 1, `\n\n[SYSTEM NOTE] ${nudge}`);
    };

    // If a terminating tool was deferred, inject a review prompt
    if (terminating && nonTerminating.length > 0) {
      appendNudgeToLastToolResult(
        `You called ${terminating.toolCall.function.name} in the same request as other tools. ` +
        `Review the results above first, then call ${terminating.toolCall.function.name} again with an updated answer.`
      );
    }

    // Wrap-up nudge: if approaching iteration limit or tool call budget exceeded
    if (terminatingToolName && !terminating) {
      const overBudget = nonTerminatingToolCalls >= effectiveToolCallBudget;
      const approachingLimit = i >= iterationThreshold;
      if (overBudget || approachingLimit) {
        const reason = overBudget
          ? `You have made ${nonTerminatingToolCalls} tool calls (budget: ${effectiveToolCallBudget}).`
          : `You are at iteration ${i + 1}/${maxIterations}.`;
        log(name, `wrap-up nudge: ${reason}`);
        appendNudgeToLastToolResult(
          `${reason} You must stop searching and call ${terminatingToolName} NOW ` +
          `with your best answer based on what you have gathered so far. Do not make any more searches.`
        );
      }
    }
  }

  const tokenSummary = `${formatTokens(totalPromptTokens + totalCompletionTokens)} tokens`;
  log(name, `max iterations (${maxIterations}) reached (~${tokenSummary})`);

  addEvent(ctx, {
    source: name,
    target: name,
    type: "agent_end",
    output: "Max iterations reached",
    metadata: { maxIterations },
  });

  return makeResult("Max iterations reached — returning partial results.", maxIterations);
}
