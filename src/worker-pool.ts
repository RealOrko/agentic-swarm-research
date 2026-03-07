import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log as centralLog, logError as centralLogError } from "./logger.js";
import type { AgentStats } from "./agent-loop.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Types ──────────────────────────────────────────────────────────────

export interface WorkerToolConfig {
  type: string;
}

export interface WorkerInput {
  name: string;
  systemPrompt: string;
  userMessage: string;
  maxIterations: number;
  allowTextResponse?: boolean;
  tokenBudget?: number;
  tools: WorkerToolConfig[];
  sessionId: string;
  env: {
    BASE_URL: string;
    MODEL_NAME: string;
    SEARXNG_URL?: string;
    CHARS_PER_TOKEN?: string;
  };
}

export interface WorkerResultMessage {
  type: "result";
  result: string;
  stats: AgentStats;
}

export interface WorkerLogMessage {
  type: "log";
  message: string;
  pid: number;
}

export type WorkerMessage = WorkerResultMessage | WorkerLogMessage;

// ── Logging ─────────────────────────────────────────────────────────────

function poolLog(workerName: string, status: string, detail?: string): void {
  const padded = workerName.padEnd(28);
  const suffix = detail ? ` (${detail})` : "";
  const counts = `[${activeWorkers}/${MAX_WORKERS} active, ${pool.pending} queued]`;
  centralLog("pool", `${padded} ${status} ${counts}${suffix}`);
}

function workerLog(workerName: string, message: string, pid?: number): void {
  centralLog(workerName, message, pid);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ── Semaphore ──────────────────────────────────────────────────────────

class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  get pending(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

// ── Aggregate Stats ─────────────────────────────────────────────────────

export interface PoolStats {
  spawned: number;
  completed: number;
  failed: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

const _poolStats: PoolStats = {
  spawned: 0,
  completed: 0,
  failed: 0,
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
};

export function getPoolStats(): Readonly<PoolStats> {
  return { ..._poolStats };
}

export function resetPoolStats(): void {
  _poolStats.spawned = 0;
  _poolStats.completed = 0;
  _poolStats.failed = 0;
  _poolStats.totalPromptTokens = 0;
  _poolStats.totalCompletionTokens = 0;
}

// ── Worker Pool ────────────────────────────────────────────────────────

const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || "5", 10);
const pool = new Semaphore(MAX_WORKERS);
let activeWorkers = 0;

const WORKER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Spawn a sub-agent in a child process.
 * Returns the parsed result once the child exits.
 */
export async function spawnAgent(input: WorkerInput): Promise<WorkerResultMessage> {
  _poolStats.spawned++;
  poolLog(input.name, "SPAWN");

  // Check if we need to queue
  const willWait = pool.pending > 0 || activeWorkers >= MAX_WORKERS;
  if (willWait) {
    poolLog(input.name, "QUEUED");
  }

  await pool.acquire();

  activeWorkers++;
  if (willWait) {
    poolLog(input.name, "RUNNING");
  }

  const startTime = Date.now();

  try {
    const result = await runWorker(input);
    const duration = Date.now() - startTime;
    _poolStats.completed++;
    _poolStats.totalPromptTokens += result.stats.promptTokens;
    _poolStats.totalCompletionTokens += result.stats.completionTokens;
    activeWorkers--;
    const tokenTotal = result.stats.promptTokens + result.stats.completionTokens;
    poolLog(input.name, "EXIT ok", `${formatDuration(duration)}, ${result.stats.iterations} iters, ~${formatTokens(tokenTotal)} tokens`);
    return result;
  } catch (err) {
    const duration = Date.now() - startTime;
    _poolStats.failed++;
    activeWorkers--;
    const errorMsg = err instanceof Error ? err.message : String(err);
    poolLog(input.name, "ERROR", `${formatDuration(duration)}, ${errorMsg}`);
    throw err;
  } finally {
    pool.release();
  }
}

function runWorker(input: WorkerInput): Promise<WorkerResultMessage> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "worker.ts");

    const child = spawn("npx", ["tsx", workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BASE_URL: input.env.BASE_URL,
        MODEL_NAME: input.env.MODEL_NAME,
        SEARXNG_URL: input.env.SEARXNG_URL || "",
        CHARS_PER_TOKEN: input.env.CHARS_PER_TOKEN || "",
        NODE_NO_WARNINGS: "1",
        // Prevent dotenv from re-loading .env in child
        DOTENV_CONFIG_PATH: "/dev/null",
      },
    });

    // Timeout
    const timer = setTimeout(() => {
      poolLog(input.name, "TIMEOUT", `killed after ${WORKER_TIMEOUT_MS / 1000}s`);
      child.kill("SIGKILL");
    }, WORKER_TIMEOUT_MS);

    // Write input to stdin
    child.stdin.write(JSON.stringify(input) + "\n");
    child.stdin.end();

    // Collect stdout lines
    let stdoutBuf = "";
    let result: WorkerResultMessage | null = null;

    child.stdout.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      // Process complete lines
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() || ""; // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: WorkerMessage = JSON.parse(line);
          if (msg.type === "log") {
            workerLog(input.name, msg.message, msg.pid);
          } else if (msg.type === "result") {
            result = msg;
          }
        } catch {
          // Non-JSON stdout — forward as worker log (should be rare now)
          workerLog(input.name, line);
        }
      }
    });

    // Forward stderr — filter out deprecation warnings
    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Skip known noise patterns
          if (trimmed.includes("DEP0040") || trimmed.includes("punycode")) continue;
          centralLogError(input.name, trimmed, child.pid);
        }
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      // Process any remaining stdout
      if (stdoutBuf.trim()) {
        try {
          const msg: WorkerMessage = JSON.parse(stdoutBuf);
          if (msg.type === "result") {
            result = msg;
          }
        } catch {
          // ignore
        }
      }

      if (result) {
        resolve(result);
      } else {
        reject(
          new Error(
            `exited with code ${code} without producing a result`
          )
        );
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`failed to spawn: ${err.message}`));
    });
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Build the env config for a worker from current process.env */
export function buildWorkerEnv(): WorkerInput["env"] {
  return {
    BASE_URL: process.env.BASE_URL || "http://localhost:8000/v1",
    MODEL_NAME: process.env.MODEL_NAME || "qwen3-coder-30b-a3b",
    SEARXNG_URL: process.env.SEARXNG_URL,
    CHARS_PER_TOKEN: process.env.CHARS_PER_TOKEN,
  };
}
