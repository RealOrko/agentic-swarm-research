/**
 * Dynamic tool loader — loads external JS tool files from config packages.
 *
 * External tool files export:
 *   export const schema = { type: "function", function: { name, description, parameters } };
 *   export async function handler(args, ctx) { return result; }
 *
 * The runtime injects a ToolRuntimeContext providing capabilities
 * (HTTP fetch, child_process exec, knowledge store, agent spawning).
 */

import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import type { ToolHandler } from "./agent-loop.js";
import type { Context } from "./context.js";
import type { AgentFactory } from "./agent-factory.js";
import type { KnowledgeStore } from "./knowledge-store.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * The context object passed to every external tool handler.
 * This is the contract between the engine and user-defined tools.
 */
export interface ExternalToolContext {
  /** The current execution context (SQLite DB, session, events, nodes) */
  ctx: Context;
  /** HTTP fetch (global fetch) */
  fetch: typeof globalThis.fetch;
  /** Execute a child process synchronously */
  exec: typeof execFileSync;
  /** Knowledge store for session-level vector indexing/querying */
  knowledgeStore: KnowledgeStore | null;
  /** Spawn a sub-agent by name (only available for meta-tools) */
  spawnAgent?: (agentName: string, userMessage: string) => Promise<{ result: string }>;
  /** Tool-specific config defaults from YAML */
  config: Record<string, unknown>;
  /** Structured logging */
  log: (message: string) => void;
  /** The vector-kv key for the current session (if available) */
  vectorKey?: string;
}

/** Shape of an external tool JS module */
export interface ExternalToolModule {
  schema: ChatCompletionTool;
  handler: (args: Record<string, unknown>, ctx: ExternalToolContext) => Promise<unknown>;
}

/**
 * Load an external tool from a JS file path.
 * The file must export `schema` and `handler`.
 */
export async function loadExternalTool(
  jsPath: string,
  toolName: string,
): Promise<ExternalToolModule> {
  // Use file:// URL for dynamic import (required on all platforms)
  const fileUrl = pathToFileURL(jsPath).href;
  const mod = await import(fileUrl);

  if (!mod.schema) {
    throw new Error(`External tool "${toolName}" (${jsPath}) must export a 'schema' object`);
  }
  if (typeof mod.handler !== "function") {
    throw new Error(`External tool "${toolName}" (${jsPath}) must export a 'handler' function`);
  }

  return {
    schema: mod.schema as ChatCompletionTool,
    handler: mod.handler as ExternalToolModule["handler"],
  };
}

/**
 * Build an ExternalToolContext for passing to external tool handlers.
 */
export function buildExternalToolContext(
  ctx: Context,
  config: Record<string, unknown>,
  log: (message: string) => void,
  agentFactory?: AgentFactory,
  vectorKey?: string,
): ExternalToolContext {
  const extCtx: ExternalToolContext = {
    ctx,
    fetch: globalThis.fetch,
    exec: execFileSync,
    knowledgeStore: ctx.knowledgeStore ?? null,
    config,
    log,
    vectorKey,
  };

  // Only provide spawnAgent if agentFactory is available
  if (agentFactory) {
    extCtx.spawnAgent = async (agentName: string, userMessage: string) => {
      const workerResult = await agentFactory.spawnWorker(agentName, userMessage, ctx);
      return { result: workerResult.result };
    };
  }

  return extCtx;
}

/**
 * Wrap an external tool module into a ToolHandler compatible with the agent loop.
 */
export function wrapExternalTool(
  mod: ExternalToolModule,
  toolConfig: Record<string, unknown>,
  terminates: boolean,
  getContext: () => ExternalToolContext,
): ToolHandler {
  return {
    definition: mod.schema,
    terminates,
    handler: async (args: Record<string, unknown>, ctx: Context): Promise<unknown> => {
      const extCtx = getContext();
      return mod.handler(args, extCtx);
    },
  };
}
