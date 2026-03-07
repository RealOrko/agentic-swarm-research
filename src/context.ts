import { nanoid } from "nanoid";
import Database from "better-sqlite3";
import type { KnowledgeStore } from "./knowledge-store.js";

// ── Types ──────────────────────────────────────────────────────────────

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

export interface MessageDBRow {
  seq: number;
  role: string;
  content: string | null;
  tool_call_id: string | null;
  tool_calls_json: string | null;
  node_id: string | null;
}

export interface Context {
  sessionId: string;
  store: Record<string, unknown>;
  knowledgeStore?: KnowledgeStore;
  db: ContextDB;
}

// ── Max output size for events (avoid storing huge file contents) ────

const MAX_EVENT_OUTPUT_CHARS = 1000;

function truncateOutput(output: unknown): unknown {
  if (output === undefined || output === null) return output;
  const str = typeof output === "string" ? output : JSON.stringify(output);
  if (str.length <= MAX_EVENT_OUTPUT_CHARS) return output;
  return typeof output === "string"
    ? str.slice(0, MAX_EVENT_OUTPUT_CHARS) + "...[truncated]"
    : JSON.parse(JSON.stringify(output, (_k, v) => {
        if (typeof v === "string" && v.length > MAX_EVENT_OUTPUT_CHARS) {
          return v.slice(0, MAX_EVENT_OUTPUT_CHARS) + "...[truncated]";
        }
        return v;
      }));
}

// ── SQLite-backed context database ──────────────────────────────────

export class ContextDB {
  private db: Database.Database;
  private _insertEvent: Database.Statement;
  private _insertNode: Database.Statement;
  private _updateNodeContent: Database.Statement;
  private _compactNode: Database.Statement;
  private _addChild: Database.Statement;
  private _getNode: Database.Statement;
  private _getNodesByType: Database.Statement;
  private _getNodeChildren: Database.Statement;
  private _queryEvents: Database.Statement;
  private _countEventsByType: Database.Statement;
  private _countEvents: Database.Statement;
  private _allNodes: Database.Statement;
  private _allEvents: Database.Statement;
  private _insertMessage: Database.Statement;
  private _getMessages: Database.Statement;
  private _updateMessageContent: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.initTables();

    this._insertEvent = db.prepare(`
      INSERT INTO events (id, session_id, timestamp, source, target, type, tool, input, output, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._insertNode = db.prepare(`
      INSERT INTO context_nodes (id, session_id, type, parent_id, child_ids, summary, content, source, token_estimate, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._updateNodeContent = db.prepare(`
      UPDATE context_nodes SET content = ?, summary = ?, token_estimate = ? WHERE id = ? AND session_id = ?
    `);
    this._compactNode = db.prepare(`
      UPDATE context_nodes SET content = NULL WHERE id = ? AND session_id = ?
    `);
    this._addChild = db.prepare(`
      UPDATE context_nodes SET child_ids = ? WHERE id = ? AND session_id = ?
    `);
    this._getNode = db.prepare(`
      SELECT * FROM context_nodes WHERE id = ? AND session_id = ?
    `);
    this._getNodesByType = db.prepare(`
      SELECT * FROM context_nodes WHERE session_id = ? AND type = ?
    `);
    this._getNodeChildren = db.prepare(`
      SELECT child_ids FROM context_nodes WHERE id = ? AND session_id = ?
    `);
    this._queryEvents = db.prepare(`
      SELECT * FROM events WHERE session_id = ? AND type = ? AND tool = ?
    `);
    this._countEventsByType = db.prepare(`
      SELECT type, COUNT(*) as count FROM events WHERE session_id = ? GROUP BY type
    `);
    this._countEvents = db.prepare(`
      SELECT COUNT(*) as count FROM events WHERE session_id = ?
    `);
    this._allNodes = db.prepare(`
      SELECT * FROM context_nodes WHERE session_id = ?
    `);
    this._allEvents = db.prepare(`
      SELECT * FROM events WHERE session_id = ?
    `);
    this._insertMessage = db.prepare(`
      INSERT INTO messages (session_id, agent_id, seq, role, content, tool_call_id, tool_calls_json, node_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this._getMessages = db.prepare(`
      SELECT seq, role, content, tool_call_id, tool_calls_json, node_id
      FROM messages WHERE session_id = ? AND agent_id = ? ORDER BY seq
    `);
    this._updateMessageContent = db.prepare(`
      UPDATE messages SET content = ? WHERE session_id = ? AND agent_id = ? AND seq = ?
    `);
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        type TEXT NOT NULL,
        tool TEXT,
        input TEXT,
        output TEXT,
        metadata TEXT DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS context_nodes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        parent_id TEXT,
        child_ids TEXT DEFAULT '[]',
        summary TEXT,
        content TEXT,
        source TEXT NOT NULL,
        token_estimate INTEGER DEFAULT 0,
        timestamp TEXT NOT NULL,
        metadata TEXT DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type, tool);
      CREATE INDEX IF NOT EXISTS idx_nodes_session ON context_nodes(session_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_parent ON context_nodes(parent_id);
      CREATE INDEX IF NOT EXISTS idx_nodes_type ON context_nodes(session_id, type);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_calls_json TEXT,
        node_id TEXT,
        UNIQUE(session_id, agent_id, seq)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(session_id, agent_id);
    `);
  }

  // ── Event operations ──────────────────────────────────────────────

  insertEvent(sessionId: string, event: Event): void {
    this._insertEvent.run(
      event.id,
      sessionId,
      event.timestamp,
      event.source,
      event.target,
      event.type,
      event.tool || null,
      event.input !== undefined ? JSON.stringify(event.input) : null,
      event.output !== undefined ? JSON.stringify(truncateOutput(event.output)) : null,
      event.metadata ? JSON.stringify(event.metadata) : "{}"
    );
  }

  queryEvents(sessionId: string, type: string, tool: string): Event[] {
    const rows = this._queryEvents.all(sessionId, type, tool) as EventRow[];
    return rows.map(rowToEvent);
  }

  countEventsByType(sessionId: string): Record<string, number> {
    const rows = this._countEventsByType.all(sessionId) as Array<{ type: string; count: number }>;
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.type] = row.count;
    }
    return result;
  }

  countEvents(sessionId: string): number {
    const row = this._countEvents.get(sessionId) as { count: number };
    return row.count;
  }

  hasEvent(sessionId: string, type: string, tool: string): boolean {
    const sql = `SELECT 1 FROM events WHERE session_id = ? AND type = ? AND tool = ? LIMIT 1`;
    return this.db.prepare(sql).get(sessionId, type, tool) !== undefined;
  }

  getAllEvents(sessionId: string): Event[] {
    const rows = this._allEvents.all(sessionId) as EventRow[];
    return rows.map(rowToEvent);
  }

  // ── Node operations ───────────────────────────────────────────────

  insertNode(sessionId: string, node: ContextNode): void {
    this._insertNode.run(
      node.id,
      sessionId,
      node.type,
      node.parentId,
      JSON.stringify(node.childIds),
      node.summary,
      node.content,
      node.source,
      node.tokenEstimate,
      node.timestamp,
      JSON.stringify(node.metadata)
    );
  }

  getNode(sessionId: string, nodeId: string): ContextNode | null {
    const row = this._getNode.get(nodeId, sessionId) as NodeRow | undefined;
    return row ? rowToNode(row) : null;
  }

  getNodesByType(sessionId: string, type: NodeType): ContextNode[] {
    const rows = this._getNodesByType.all(sessionId, type) as NodeRow[];
    return rows.map(rowToNode);
  }

  updateNodeContent(sessionId: string, nodeId: string, content: string, summary: string, tokenEstimate: number): void {
    this._updateNodeContent.run(content, summary, tokenEstimate, nodeId, sessionId);
  }

  compactNode(sessionId: string, nodeId: string): void {
    this._compactNode.run(nodeId, sessionId);
  }

  addChildToNode(sessionId: string, parentId: string, childId: string): void {
    const row = this._getNodeChildren.get(parentId, sessionId) as { child_ids: string } | undefined;
    if (!row) return;
    const children: string[] = JSON.parse(row.child_ids);
    if (!children.includes(childId)) {
      children.push(childId);
      this._addChild.run(JSON.stringify(children), parentId, sessionId);
    }
  }

  getAllNodes(sessionId: string): ContextNode[] {
    const rows = this._allNodes.all(sessionId) as NodeRow[];
    return rows.map(rowToNode);
  }

  getTreeTokens(sessionId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(token_estimate), 0) as total FROM context_nodes WHERE session_id = ? AND content IS NOT NULL`
    ).get(sessionId) as { total: number };
    return row.total;
  }

  // ── Message operations ─────────────────────────────────────────

  insertMessage(sessionId: string, agentId: string, seq: number, msg: {
    role: string;
    content?: string | null;
    toolCallId?: string;
    toolCallsJson?: string;
    nodeId?: string;
  }): void {
    this._insertMessage.run(
      sessionId, agentId, seq,
      msg.role,
      msg.content ?? null,
      msg.toolCallId ?? null,
      msg.toolCallsJson ?? null,
      msg.nodeId ?? null
    );
  }

  getMessages(sessionId: string, agentId: string): MessageDBRow[] {
    return this._getMessages.all(sessionId, agentId) as MessageDBRow[];
  }

  updateMessageContent(sessionId: string, agentId: string, seq: number, content: string): void {
    this._updateMessageContent.run(content, sessionId, agentId, seq);
  }

  appendToMessageContent(sessionId: string, agentId: string, seq: number, suffix: string): void {
    this.db.prepare(
      `UPDATE messages SET content = content || ? WHERE session_id = ? AND agent_id = ? AND seq = ?`
    ).run(suffix, sessionId, agentId, seq);
  }
}

// ── Row types for SQLite results ────────────────────────────────────

interface EventRow {
  id: string;
  session_id: string;
  timestamp: string;
  source: string;
  target: string;
  type: string;
  tool: string | null;
  input: string | null;
  output: string | null;
  metadata: string;
}

interface NodeRow {
  id: string;
  session_id: string;
  type: string;
  parent_id: string | null;
  child_ids: string;
  summary: string;
  content: string | null;
  source: string;
  token_estimate: number;
  timestamp: string;
  metadata: string;
}

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    timestamp: row.timestamp,
    source: row.source,
    target: row.target,
    type: row.type as Event["type"],
    tool: row.tool || undefined,
    input: row.input ? JSON.parse(row.input) : undefined,
    output: row.output ? JSON.parse(row.output) : undefined,
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

function rowToNode(row: NodeRow): ContextNode {
  return {
    id: row.id,
    type: row.type as NodeType,
    parentId: row.parent_id,
    childIds: JSON.parse(row.child_ids || "[]"),
    summary: row.summary,
    content: row.content,
    source: row.source,
    tokenEstimate: row.token_estimate,
    timestamp: row.timestamp,
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

// ── Context factory ─────────────────────────────────────────────────

export function createContext(db: ContextDB, sessionId?: string): Context {
  const sid = sessionId || nanoid(12);
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

  db.insertNode(sid, rootNode);

  const ctx: Context = {
    sessionId: sid,
    store: { _rootId: rootId },
    db,
  };

  return ctx;
}

/** Get the root node ID for a context */
export function getRootId(ctx: Context): string {
  return ctx.store._rootId as string;
}

// ── Convenience functions (replace old in-memory operations) ────────

export function estimateTokens(text: string): number {
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

  ctx.db.insertNode(ctx.sessionId, node);

  if (opts.parentId) {
    ctx.db.addChildToNode(ctx.sessionId, opts.parentId, id);
  }

  return node;
}

export function compactNode(ctx: Context, nodeId: string): void {
  ctx.db.compactNode(ctx.sessionId, nodeId);
}

export function getTreeTokens(ctx: Context): number {
  return ctx.db.getTreeTokens(ctx.sessionId);
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
  ctx.db.insertEvent(ctx.sessionId, full);
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

// ── Serialization helpers (for report export) ───────────────────────

export function serializeTree(ctx: Context): { rootId: string; nodes: Record<string, ContextNode> } {
  const rootId = getRootId(ctx);
  const allNodes = ctx.db.getAllNodes(ctx.sessionId);
  const nodes: Record<string, ContextNode> = {};
  for (const node of allNodes) {
    nodes[node.id] = node;
  }
  return { rootId, nodes };
}
