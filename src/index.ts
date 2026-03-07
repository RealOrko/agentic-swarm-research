import { runResearch } from "./orchestrator.js";
import { logRaw, logError, closeLogger } from "./logger.js";

const HELP = `
agentic-research - Multi-agent research system

USAGE
  agentic-research [options] "<research question>"

OPTIONS
  --vector-key <key>  Vector-KV key for semantic code search.
                      Index a codebase first with:
                        vector-kv index <key> /path/to/codebase
  --help, -h          Show this help message

EXAMPLES
  # Pure web research
  agentic-research "What are the leading approaches to quantum computing?"

  # Code + web research
  agentic-research --vector-key my-project "How does the parser handle errors?"

ENVIRONMENT
  BASE_URL      LLM endpoint (default: http://localhost:8000/v1)
  MODEL_NAME    Model to use (default: mistral-small-24b)
  SEARXNG_URL   SearXNG instance for web search
  MAX_WORKERS   Max parallel worker agents (default: 5)
`.trimStart();

const args = process.argv.slice(2);
let vectorKvKey: string | undefined;
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
  } else if (args[i].startsWith("-")) {
    console.error(`Unknown option: ${args[i]}\n`);
    process.stdout.write(HELP);
    process.exit(1);
  } else {
    remaining.push(args[i]);
  }
}

const goal = remaining.join(" ");

if (!goal) {
  console.error("Error: no research question provided.\n");
  process.stdout.write(HELP);
  process.exit(1);
}

try {
  const ctx = await runResearch(goal, vectorKvKey);

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
