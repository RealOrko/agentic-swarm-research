import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { SwarmRunner } from "./swarm-runner.js";
import { buildDefaultConfig } from "./config/index.js";
import { log, logRaw, logError, closeLogger } from "./logger.js";

const HELP = `
agentic-research - Multi-agent research system

USAGE
  agentic-research [options] "<research question>"

OPTIONS
  --config <path>       Path to swarm YAML config file (default: built-in defaults)
  --codebase <path>     Path to a codebase directory. Automatically indexes it
                        into vector-kv and enables semantic code search tools.
  --glob <pattern>      Glob filter for --codebase indexing (e.g. "*.ts")
  --vector-key <key>    Use an existing vector-kv key (cannot combine with --codebase)
  --help, -h            Show this help message

EXAMPLES
  # Pure web research
  agentic-research "What are the leading approaches to quantum computing?"

  # Auto-index and research a codebase
  agentic-research --codebase ./my-project "How does the parser handle errors?"

  # Index only TypeScript files
  agentic-research --codebase ./my-project --glob "*.ts" "Analyze the error handling"

  # Use a previously indexed codebase
  agentic-research --vector-key my-project "How does the parser handle errors?"

ENVIRONMENT
  BASE_URL      LLM endpoint (default: http://localhost:8000/v1)
  MODEL_NAME    Model to use (default: qwen3-coder-next)
  SEARXNG_URL   SearXNG instance for web search
  MAX_WORKERS   Max parallel worker agents (default: 5)
`.trimStart();

const args = process.argv.slice(2);
let vectorKvKey: string | undefined;
let configPath: string | undefined;
let codebasePath: string | undefined;
let globPattern: string | undefined;
const remaining: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--help" || args[i] === "-h") {
    process.stdout.write(HELP);
    process.exit(0);
  } else if (args[i] === "--vector-key" && i + 1 < args.length) {
    vectorKvKey = args[i + 1];
    i++;
  } else if (args[i].startsWith("--vector-key=")) {
    vectorKvKey = args[i].slice("--vector-key=".length);
  } else if (args[i] === "--config" && i + 1 < args.length) {
    configPath = args[i + 1];
    i++;
  } else if (args[i].startsWith("--config=")) {
    configPath = args[i].slice("--config=".length);
  } else if (args[i] === "--codebase" && i + 1 < args.length) {
    codebasePath = args[i + 1];
    i++;
  } else if (args[i].startsWith("--codebase=")) {
    codebasePath = args[i].slice("--codebase=".length);
  } else if (args[i] === "--glob" && i + 1 < args.length) {
    globPattern = args[i + 1];
    i++;
  } else if (args[i].startsWith("--glob=")) {
    globPattern = args[i].slice("--glob=".length);
  } else if (args[i].startsWith("-")) {
    console.error(`Unknown option: ${args[i]}\n`);
    process.stdout.write(HELP);
    process.exit(1);
  } else {
    remaining.push(args[i]);
  }
}

if (codebasePath && vectorKvKey) {
  console.error("Error: --codebase and --vector-key cannot be used together.\n");
  process.exit(1);
}

if (globPattern && !codebasePath) {
  console.error("Error: --glob requires --codebase.\n");
  process.exit(1);
}

const goal = remaining.join(" ");

if (!goal) {
  console.error("Error: no research question provided.\n");
  process.stdout.write(HELP);
  process.exit(1);
}

// Auto-index codebase if --codebase was provided
if (codebasePath) {
  const absPath = resolve(codebasePath);
  const name = basename(absPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  vectorKvKey = `${name}-${Date.now()}`;

  log("system", `Indexing codebase: ${absPath} → key "${vectorKvKey}"`);

  const indexArgs = ["index", vectorKvKey, absPath];
  if (globPattern) indexArgs.push("--glob", globPattern);

  try {
    execFileSync("vector-kv", indexArgs, { stdio: "inherit", timeout: 300_000 });
  } catch (indexErr) {
    console.error(`Error: failed to index codebase: ${indexErr}`);
    process.exit(1);
  }

  log("system", `Codebase indexed successfully under key "${vectorKvKey}"`);
}

try {
  // Create runner from config file or built-in defaults
  const runner = configPath
    ? await SwarmRunner.fromFile(configPath)
    : await SwarmRunner.fromConfig(buildDefaultConfig());

  const result = await runner.run(goal, vectorKvKey ? { vectorKey: vectorKvKey } : undefined);

  const ctx = result.ctx;
  const eventCounts = ctx.db.countEventsByType(ctx.sessionId);
  const totalEvents = ctx.db.countEvents(ctx.sessionId);

  logRaw("");
  logRaw("  Execution summary:");
  logRaw(`   Events: ${totalEvents} total`);
  for (const [type, count] of Object.entries(eventCounts)) {
    logRaw(`   - ${type}: ${count}`);
  }
  await closeLogger();
} catch (err) {
  logError("system", `Research failed: ${err}`);
  await closeLogger();
  process.exit(1);
}
