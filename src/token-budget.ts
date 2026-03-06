import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Context } from "./context.js";
import { compactNode } from "./context.js";
import { getModelInfo } from "./llm.js";

function charsToTokens(chars: number): number {
  return Math.ceil(chars / getModelInfo().charsPerToken);
}

export function estimateMessageTokens(
  messages: ChatCompletionMessageParam[]
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      total += charsToTokens(msg.content.length);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ("text" in part && typeof part.text === "string") {
          total += charsToTokens(part.text.length);
        }
      }
    }
    // Count tool call arguments
    if ("tool_calls" in msg && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += charsToTokens(tc.function.arguments.length);
      }
    }
  }
  return total;
}

/**
 * Estimate token cost of tool definitions (schemas sent with every request).
 */
export function estimateToolOverhead(tools: ChatCompletionTool[]): number {
  if (tools.length === 0) return 0;
  const json = JSON.stringify(tools);
  return charsToTokens(json.length);
}

/**
 * Derive an agent's message budget from the model context window.
 * Reserves space for tool definitions and a response margin.
 */
export function deriveBudget(
  role: "orchestrator" | "researcher" | "code-researcher" | "synthesizer" | "critic",
  toolOverhead: number
): number {
  const { maxContextTokens } = getModelInfo();

  // Reserve tokens for the model's response generation
  const responseReserve = Math.min(4096, Math.floor(maxContextTokens * 0.15));

  // Available = context - tool defs - response reserve
  const available = maxContextTokens - toolOverhead - responseReserve;

  // Each role gets a fraction of available context for messages
  const fractions: Record<string, number> = {
    orchestrator: 0.45,
    "code-researcher": 0.35,
    researcher: 0.30,
    synthesizer: 0.40,
    critic: 0.30,
  };

  const fraction = fractions[role] || 0.30;
  return Math.floor(available * fraction);
}

export function shouldCompact(
  messages: ChatCompletionMessageParam[],
  budget: number
): boolean {
  return estimateMessageTokens(messages) > budget * 0.85;
}

interface CompactTarget {
  messageIndex: number;
  toolCallId: string;
  nodeId: string;
  tokenEstimate: number;
}

export function findCompactableMessages(
  messages: ChatCompletionMessageParam[],
  nodeMap: Map<string, string>
): CompactTarget[] {
  const targets: CompactTarget[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "tool") continue;

    const toolCallId = "tool_call_id" in msg ? msg.tool_call_id : undefined;
    if (!toolCallId) continue;

    const nodeId = nodeMap.get(toolCallId);
    if (!nodeId) continue;

    const content = typeof msg.content === "string" ? msg.content : "";
    const tokenEstimate = charsToTokens(content.length);

    targets.push({ messageIndex: i, toolCallId, nodeId, tokenEstimate });
  }

  // Sort largest first for maximum compaction impact
  targets.sort((a, b) => b.tokenEstimate - a.tokenEstimate);
  return targets;
}

export function applyCompaction(
  messages: ChatCompletionMessageParam[],
  targets: CompactTarget[],
  ctx: Context,
  budget: number
): number {
  let compacted = 0;
  const targetTokens = budget * 0.75;

  for (const target of targets) {
    if (estimateMessageTokens(messages) <= targetTokens) break;

    const node = ctx.tree.nodes.get(target.nodeId);
    if (!node) continue;

    const summary = node.summary || "[Compacted]";
    messages[target.messageIndex] = {
      role: "tool",
      tool_call_id: target.toolCallId,
      content: `[Compacted] ${summary}`,
    };

    compactNode(ctx, target.nodeId);
    compacted++;
  }

  return compacted;
}
