import { nanoid } from "nanoid";
import type { KnowledgeStore, KnowledgeChunk } from "./knowledge-store.js";

/** Structural interface for any knowledge store (real or buffering) */
export interface KnowledgeStoreInterface {
  index(
    text: string,
    sourceType: string,
    sourceRef: string,
    meta?: Record<string, unknown>
  ): Promise<void>;
  query(
    queryText: string,
    topK?: number,
    filter?: { source_type?: string }
  ): Promise<KnowledgeChunk[]>;
}

export interface Event {
  id: string;
  timestamp: string;
  source: string;
  target: string;
  type: "tool_call" | "tool_result" | "agent_start" | "agent_end";
  tool?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
}

export type NodeType =
  | "goal"
  | "sub_question"
  | "search_result"
  | "file_content"
  | "chunk"
  | "finding"
  | "synthesis"
  | "critique"
  | "report";

export interface ContextNode {
  id: string;
  type: NodeType;
  parentId: string | null;
  childIds: string[];
  summary: string;
  content: string | null;
  source: string;
  tokenEstimate: number;
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface ContextTree {
  nodes: Map<string, ContextNode>;
  rootId: string;
}

export interface Context {
  store: Record<string, unknown>;
  events: Event[];
  tree: ContextTree;
  toolResultNodeMap: Map<string, string>;
  knowledgeStore?: KnowledgeStoreInterface;
}

export function createContext(): Context {
  const rootId = nanoid(12);
  const rootNode: ContextNode = {
    id: rootId,
    type: "goal",
    parentId: null,
    childIds: [],
    summary: "",
    content: null,
    source: "system",
    tokenEstimate: 0,
    timestamp: new Date().toISOString(),
    metadata: {},
  };
  const nodes = new Map<string, ContextNode>();
  nodes.set(rootId, rootNode);

  return {
    store: {},
    events: [],
    tree: { nodes, rootId },
    toolResultNodeMap: new Map(),
  };
}

export function estimateTokens(text: string): number {
  // Conservative estimate; use getModelInfo().charsPerToken at runtime
  // This is used for tree node estimates which don't need exact precision
  return Math.ceil(text.length / 3);
}

export function addNode(
  ctx: Context,
  opts: {
    type: NodeType;
    parentId: string | null;
    content: string | null;
    source: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }
): ContextNode {
  const id = nanoid(12);
  const content = opts.content;
  const summary =
    opts.summary ||
    (content
      ? content.length > 300
        ? content.slice(0, 300) + "..."
        : content
      : "");

  const node: ContextNode = {
    id,
    type: opts.type,
    parentId: opts.parentId,
    childIds: [],
    summary,
    content,
    source: opts.source,
    tokenEstimate: content ? estimateTokens(content) : 0,
    timestamp: new Date().toISOString(),
    metadata: opts.metadata || {},
  };

  ctx.tree.nodes.set(id, node);

  if (opts.parentId) {
    const parent = ctx.tree.nodes.get(opts.parentId);
    if (parent) {
      parent.childIds.push(id);
    }
  }

  return node;
}

export function compactNode(ctx: Context, nodeId: string): void {
  const node = ctx.tree.nodes.get(nodeId);
  if (!node || node.content === null) return;
  node.content = null;
}

export function getTreeTokens(ctx: Context): number {
  let total = 0;
  for (const node of ctx.tree.nodes.values()) {
    if (node.content !== null) {
      total += node.tokenEstimate;
    }
  }
  return total;
}

export function serializeTree(
  tree: ContextTree
): { rootId: string; nodes: Record<string, ContextNode> } {
  const nodes: Record<string, ContextNode> = {};
  for (const [id, node] of tree.nodes) {
    nodes[id] = node;
  }
  return { rootId: tree.rootId, nodes };
}

export function addEvent(
  ctx: Context,
  event: Omit<Event, "id" | "timestamp">
): Event {
  const full: Event = {
    id: nanoid(12),
    timestamp: new Date().toISOString(),
    ...event,
  };
  ctx.events.push(full);
  return full;
}

export function setStore(
  ctx: Context,
  key: string,
  value: unknown,
  source: string
): void {
  ctx.store[key] = value;
  addEvent(ctx, {
    source,
    target: "store",
    type: "tool_result",
    tool: "set_store",
    input: { key },
    output: value,
  });
}
