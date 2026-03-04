import { nanoid } from "nanoid";

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

export interface Context {
  store: Record<string, unknown>;
  events: Event[];
}

export function createContext(): Context {
  return { store: {}, events: [] };
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
