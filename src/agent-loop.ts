import { client, MODEL } from "./llm.js";
import { Context, addEvent } from "./context.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export interface ToolHandler {
  definition: ChatCompletionTool;
  handler: (args: Record<string, unknown>, ctx: Context) => Promise<unknown>;
  /** If true, calling this tool immediately ends the agent loop and returns its result */
  terminates?: boolean;
}

export interface AgentLoopOptions {
  name: string;
  systemPrompt: string;
  tools: ToolHandler[];
  userMessage: string;
  ctx: Context;
  maxIterations?: number;
}

function log(agent: string, message: string): void {
  const timestamp = new Date().toISOString().split("T")[1].slice(0, 8);
  console.log(`  [${timestamp}] [${agent}] ${message}`);
}

export async function agentLoop(opts: AgentLoopOptions): Promise<string> {
  const { name, systemPrompt, tools, userMessage, ctx, maxIterations = 15 } = opts;

  log(name, `started`);

  addEvent(ctx, {
    source: name,
    target: name,
    type: "agent_start",
    input: { userMessage },
  });

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  const toolDefs = tools.map((t) => t.definition);
  const toolMap = new Map(
    tools.map((t) => [t.definition.function.name, t])
  );

  for (let i = 0; i < maxIterations; i++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      temperature: 0.7,
    });

    const choice = response.choices[0];
    const message = choice.message;

    messages.push(message as ChatCompletionMessageParam);

    // If no tool calls, the agent is done — return its text response
    if (!message.tool_calls || message.tool_calls.length === 0) {
      const result = message.content || "";

      log(name, `finished (${i + 1} iterations)`);

      addEvent(ctx, {
        source: name,
        target: name,
        type: "agent_end",
        output: result,
        metadata: { iterations: i + 1 },
      });

      return result;
    }

    // Log tool calls
    const toolNames = message.tool_calls.map((tc) => tc.function.name);
    if (toolNames.length > 1) {
      log(name, `calling ${toolNames.length} tools in parallel: ${toolNames.join(", ")}`);
    }

    // Execute tool calls concurrently
    const executions = message.tool_calls.map(async (toolCall) => {
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
    });

    const results = await Promise.all(executions);

    // Check if any terminating tool was called
    const terminating = results.find((r) => r.terminates);
    if (terminating) {
      log(name, `finished via ${terminating.toolCall.function.name} (${i + 1} iterations)`);

      addEvent(ctx, {
        source: name,
        target: name,
        type: "agent_end",
        output: terminating.result,
        metadata: { iterations: i + 1, terminatedBy: terminating.toolCall.function.name },
      });

      return terminating.result;
    }

    // Append tool results to messages
    for (const { toolCall, result } of results) {
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  log(name, `max iterations (${maxIterations}) reached`);

  addEvent(ctx, {
    source: name,
    target: name,
    type: "agent_end",
    output: "Max iterations reached",
    metadata: { maxIterations },
  });

  return "Max iterations reached — returning partial results.";
}
