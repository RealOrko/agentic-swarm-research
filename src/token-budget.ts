import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { Context, MessageDBRow } from "./context.js";
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
  role: "orchestrator" | "researcher" | "synthesizer" | "critic",
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
  seq: number;
  nodeId: string;
  tokenEstimate: number;
}

/**
 * Find tool result messages that have associated context nodes and can be compacted.
 * Works directly with DB message rows — no in-memory node map needed.
 */
export function findCompactableMessages(
  dbMessages: MessageDBRow[]
): CompactTarget[] {
  const targets: CompactTarget[] = [];

  for (const msg of dbMessages) {
    if (msg.role !== "tool") continue;
    if (!msg.node_id) continue;

    const content = msg.content || "";
    // Skip already-compacted messages
    if (content.startsWith("[Compacted]")) continue;

    const tokenEstimate = charsToTokens(content.length);
    targets.push({ seq: msg.seq, nodeId: msg.node_id, tokenEstimate });
  }

  // Sort largest first for maximum compaction impact
  targets.sort((a, b) => b.tokenEstimate - a.tokenEstimate);
  return targets;
}

/**
 * Apply compaction by updating message content directly in the DB.
 * Replaces large tool results with short summaries from the linked context node.
 */
export function applyCompaction(
  ctx: Context,
  agentId: string,
  targets: CompactTarget[],
  budget: number,
  currentEstimate: number
): number {
  let compacted = 0;
  const targetTokens = budget * 0.75;
  let estimate = currentEstimate;

  for (const target of targets) {
    if (estimate <= targetTokens) break;

    // Look up the node summary from the database
    const node = ctx.db.getNode(ctx.sessionId, target.nodeId);
    if (!node) continue;

    const summary = node.summary || "[Compacted]";
    const newContent = `[Compacted] ${summary}`;
    const newTokens = charsToTokens(newContent.length);
    const savedTokens = target.tokenEstimate - newTokens;

    // Update message content directly in DB
    ctx.db.updateMessageContent(ctx.sessionId, agentId, target.seq, newContent);

    // Compact node content in DB (set to NULL)
    compactNode(ctx, target.nodeId);

    estimate -= savedTokens;
    compacted++;
  }

  return compacted;
}
