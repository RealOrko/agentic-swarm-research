# Task: Evolve the Configurable Swarm Framework into a Fully Externalised Runtime Engine

You are a senior software architect. Your job is to analyse the codebase in this repository — including the existing `docs/design.md` specification and its full implementation — and produce a detailed, actionable specification for the **next evolution** of the framework.

## The Vision

The v1 design (documented in `docs/design.md`, now fully implemented) made agents, topology, limits, and tool parameters YAML-configurable. But the **tool implementations**, **tool schemas**, **meta-tool wiring**, **synthesis strategies**, **nudge strategies**, and **prompts** still live as TypeScript source code inside `src/`. Adding a new tool, agent role, or synthesis strategy still requires writing TypeScript and rebuilding.

**The v2 design eliminates this entirely.** The `configs/` folder becomes a **self-contained, portable swarm package**. The TypeScript runtime becomes a **pure execution engine** with zero domain-specific knowledge baked in. Everything that defines *what* a swarm does — as opposed to *how* the engine runs — lives in the config package.

Concretely:

1. **Tools become single-file pure JavaScript modules** — each file in `configs/<swarm>/tools/` exports a `schema` (OpenAI function-calling JSON schema) and a `handler` (async function). The runtime dynamically loads these at startup and injects a **runtime context** providing capabilities (HTTP fetch, filesystem, child processes, knowledge store, agent spawning). No TypeScript compilation. No registry code changes. Drop a `.js` file, reference it in the YAML, and the tool exists.

2. **Meta-tools become a generic pattern** — today, `research_question`, `synthesize_findings`, and `critique` are each hand-coded TypeScript files that know how to spawn a specific agent type. In v2, the concept of "calling this tool spawns that agent" is **derived entirely from topology edges**. The runtime reads the topology, sees `{ from: orchestrator, to: researcher, via: research_question }`, and auto-generates the bridge tool that spawns the target agent and returns its result. The tool's schema can be defined inline in the edge or in a tool file. No per-agent-type bridge code.

3. **Terminal tools become declarative** — today `submit_finding`, `submit_critique`, and `submit_report` are separate TypeScript files. In v2, any tool can be marked `terminates: true` in the YAML. The runtime auto-generates a simple passthrough tool with the declared schema. The tool file is optional — only needed if the terminal tool has custom logic beyond "return the args and end the loop."

4. **Prompts are co-located in the config package** — `configs/<swarm>/prompts/` contains all system prompt markdown files. The runtime resolves prompt paths relative to the config package root, not `src/`. Built-in prompts in `src/prompts/` serve only as defaults for backward compatibility.

5. **Synthesis strategies become pluggable JavaScript modules** — `configs/<swarm>/strategies/` can contain custom synthesis implementations. The YAML references them by path. The runtime provides the same injected context (agent spawning, knowledge store) so strategies can orchestrate sub-agents however they want.

6. **Nudge strategies become pluggable JavaScript modules** — each agent definition can reference a nudge strategy file. The runtime loads it and calls it when the agent produces text instead of tool calls. Default nudge behaviour is built into the engine for backward compatibility.

7. **A config package is fully portable** — copying `configs/my-swarm/` to another machine (with the same runtime installed) is sufficient to run a completely different multi-agent system. No code changes. No rebuilds. The package contains: `swarm.yaml`, `tools/*.js`, `prompts/*.md`, and optionally `strategies/*.js` and `nudges/*.js`.

8. **The runtime is domain-agnostic** — it knows how to: run a ReAct agent loop, manage a worker pool, execute tool calls, evaluate topology edges, manage token budgets, do message compaction, and write results. It does NOT know what "research" or "synthesis" or "critique" mean. Those concepts exist only in config packages.

## Current Architecture (for orientation)

Read `docs/design.md` for the full v1 specification. Here is a summary of what's already implemented:

### What's Already Configurable (v1)
- **Agents**: name, role, systemPrompt (file path), model, temperature, execution mode, tools list, limits (maxIterations, toolCallBudget, tokenBudgetFraction, maxNudges), env vars
- **Topology**: entrypoint, edges (from/to/via/cardinality/condition/maxCycles), terminal agent+tool
- **Tool parameters**: per-tool defaults (topResults, maxContentChars, timeoutMs, etc.) via `tools:` section
- **Synthesis**: strategy selection (tournament/single-pass) with per-strategy config
- **Global**: model, baseUrl, apiKey, temperature, limits (maxWorkers, workerTimeoutMs, toolBatchSize), tokenBudget settings
- **Presets**: `configs/quick.yaml`, `configs/deep.yaml`, `configs/careful.yaml`, `configs/code-analysis.yaml`, `configs/parallel-blitz.yaml`

### What's Still Hardcoded (v1 gaps that v2 must close)

| Component | Current Location | What's Hardcoded |
|-----------|-----------------|-------------------|
| Tool implementations | `src/tools/*.ts` | The handler logic (fetch, parse, grep, etc.) |
| Tool schemas | Inside each `src/tools/*.ts` | The OpenAI function JSON schema |
| Meta-tool bridges | `src/tools/research.ts`, `synthesize.ts`, `critique.ts` | Per-agent-type spawn logic |
| Terminal tools | `src/tools/submitFinding.ts`, `submitCritique.ts`, `submitReport.ts` | Per-role termination handlers |
| Synthesis strategies | `src/synthesis/strategies.ts` | Tournament and single-pass implementations |
| Nudge strategies | `src/nudge/orchestrator-nudge.ts` | Orchestrator-specific workflow nudging |
| ToolRegistry wiring | `src/tool-registry.ts` | Built-in tool registration, meta-tool factory bindings |
| Prompt resolution | `src/config/loader.ts` | Falls back to `src/prompts/` for built-in prompts |
| Report writing | `src/tools/submitReport.ts` | Hardcoded report output format and file writing |

## What You Must Analyse

Read and understand every source file, paying particular attention to:

1. **`src/tool-registry.ts`** — How tools are registered, how factories are bound, how `resolve()` works, how meta-tools get special treatment. This is the primary target for refactoring: it must become a generic loader that discovers tools from the config package.

2. **`src/tools/*.ts`** — Every tool implementation. Note how each one:
   - Defines its OpenAI function schema inline
   - Accepts config defaults from the factory pattern
   - Uses runtime context (knowledge store, agent factory, context DB)
   - Some are "meta-tools" that spawn other agents
   - Some are "terminal tools" that end the agent loop
   Understand exactly what runtime capabilities each tool needs, because this defines the **injected context API** that external JS tool files will receive.

3. **`src/agent-loop.ts`** — The generic ReAct loop. Note how it detects terminating tools, handles nudges, does compaction. The loop itself should remain in TypeScript — it's engine code. But the nudge strategy callback and tool resolution need to support external JS modules.

4. **`src/agent-factory.ts`** — How agents are created and workers spawned. This already abstracts agent creation well. The key change: it needs to resolve tools from the config package (external JS files) rather than from the built-in registry.

5. **`src/synthesis/strategies.ts`** — The strategy interface and implementations. This must become a plugin loader that can load custom strategies from JS files while keeping built-in strategies as defaults.

6. **`src/swarm-runner.ts`** — The top-level orchestrator. This is where config package resolution, tool loading, and the full startup sequence lives. It needs to become the "config package interpreter."

7. **`src/config/loader.ts`** — How YAML configs are loaded, merged with defaults, and validated. This needs to understand the new config package structure (directory with swarm.yaml + tools/ + prompts/ + strategies/).

8. **`src/config/validate.ts`** — Validation rules. New rules needed: tool JS files must exist and export the right shape, strategy JS files must export the right interface, prompt files referenced in agent definitions must exist in the package.

9. **`src/worker.ts`** — The worker entry point. Workers need to receive tool definitions (including external JS tool code or paths) so they can resolve tools in the child process. Consider: should external tool JS be serialized into WorkerInput, or should workers load from disk?

10. **`configs/*.yaml`** — The existing preset configs. These need to be migrated to the new config package format as working examples.

## What You Must Produce

### Section 1: Config Package Specification

Define the **complete directory structure** and **file format** for a v2 config package:

```
configs/<swarm-name>/
├── swarm.yaml              # Main config (v2 schema)
├── tools/                  # Tool implementations
│   ├── <tool-name>.js      # Each exports { schema, handler }
│   └── ...
├── prompts/                # System prompts
│   ├── <agent-name>.md     # Markdown prompt files
│   └── ...
├── strategies/             # Custom synthesis strategies (optional)
│   └── <strategy-name>.js  # Each exports { synthesize }
└── nudges/                 # Custom nudge strategies (optional)
    └── <agent-name>.js     # Each exports { nudge }
```

Define the **exact contract** for each file type:

- **Tool JS files**: What must they export? What's the function signature for `handler`? What's in the injected runtime context? How do they declare dependencies on capabilities (fetch, fs, spawn)?
- **Strategy JS files**: What must they export? What parameters do they receive?
- **Nudge JS files**: What must they export? What context do they receive?

### Section 2: v2 YAML Schema

Define the complete v2 YAML schema, showing how it extends v1. Key additions:

- `tools.<name>.file` — path to the tool's JS implementation (relative to package root)
- `tools.<name>.schema` — inline schema definition (alternative to defining in the JS file)
- `tools.<name>.terminates` — boolean, declares this tool ends the agent loop
- `tools.<name>.spawns` — agent name, declares this tool spawns that agent (replaces hardcoded meta-tools)
- `topology.edges[].toolSchema` — inline schema for auto-generated bridge tools
- `agents.<name>.nudgeStrategy` — path to nudge JS file
- `synthesis.strategies.<name>.file` — path to strategy JS file

Show how the **existing v1 configs can be expressed in v2 format** with zero behavior change.

### Section 3: Tool Runtime Context API

Define the **complete API surface** that tool handler functions receive. This is critical — it's the contract between the engine and user-defined tools. Analyse every existing tool in `src/tools/*.ts` to extract the minimal set of capabilities they use:

```javascript
// The context object passed to every tool handler
interface ToolRuntimeContext {
  // What capabilities does this need to expose?
  // Analyse: webSearch needs fetch, knowledge store indexing
  // Analyse: fetchPage needs fetch, HTML parsing, knowledge store
  // Analyse: grepCode needs child_process.exec
  // Analyse: searchCode needs child_process.exec (vector-kv CLI)
  // Analyse: queryKnowledge needs knowledge store queries
  // Analyse: meta-tools need agent spawning
  // Analyse: terminal tools need context DB, file writing
}
```

Be precise. Every method, every parameter. This API is the stability surface — tools depend on it.

### Section 4: Auto-Generated Bridge Tools (Meta-Tool Elimination)

Explain exactly how the runtime auto-generates bridge tools from topology edges:

- When a topology edge says `{ from: A, to: B, via: my_tool, cardinality: fan-out }`, the runtime creates a tool called `my_tool` that:
  1. Has a schema (from `tools.my_tool.schema`, `tools.my_tool.file`, or a default `{ question: string }`)
  2. When called, spawns agent B as a worker
  3. Passes the tool arguments as the user message (or a configured template)
  4. Returns B's result to A

- How does this interact with `cardinality: single` vs `fan-out`?
- How does the `condition` field on feedback edges work with auto-generated bridge results?
- What happens when the tool file exists AND the edge defines `spawns`? (Tool runs, THEN spawns? Or tool IS the spawn?)

### Section 5: Terminal Tool Auto-Generation

Explain how tools with `terminates: true` are auto-generated:

- Default behavior: accept the declared schema args, return them, and signal the agent loop to stop
- Optional: if a tool JS file exists, it runs the handler THEN terminates (e.g., `submit_report` needs to write files)
- How does the `submit_final_report` pattern work? It needs access to the context DB to write the report and execution trace. Define how this special case is handled without hardcoding it.

### Section 6: Refactoring Plan (Source-File Level)

For every source file that changes, specify:

- **What changes** — exact functions, interfaces, imports affected
- **What stays** — explicitly call out what doesn't change (prevents scope creep)
- **New files** — any new source files needed in `src/`

Minimum files affected:
- `src/tool-registry.ts` → becomes a dynamic loader
- `src/tools/*.ts` → become **default/fallback** implementations, or are deleted in favor of config package tools
- `src/swarm-runner.ts` → config package resolution, external tool loading
- `src/agent-factory.ts` → tool resolution from config package
- `src/worker.ts` → external tool loading in child processes
- `src/config/types.ts` → v2 schema types
- `src/config/loader.ts` → config package discovery and loading
- `src/config/validate.ts` → new validation rules for JS files
- `src/synthesis/strategies.ts` → plugin loading for custom strategies
- `src/nudge/orchestrator-nudge.ts` → becomes a default, loadable nudge strategy

### Section 7: Security Considerations

External JS execution introduces risks. Address:

- **Sandboxing**: Should tool JS files run in a VM context (`vm.runInNewContext`)? Or trusted execution with injected context only?
- **Capability restriction**: Can tool JS files `require()` arbitrary modules? Or only use the injected context?
- **File system access**: Should tools have unrestricted fs access, or scoped to the config package directory?
- **Network access**: Should tools have unrestricted fetch, or only to configured endpoints?
- **What's the trust model?** — config packages are written by the swarm operator (same person running the system), so full trust is likely appropriate. But document the decision and the option to add restrictions later.

### Section 8: Migration Path

Define how to get from v1 to v2 incrementally:

1. What's the backward compatibility story? Can v1 YAML configs still work?
2. How are the existing `src/tools/*.ts` implementations migrated to `configs/` JS files?
3. What's the fallback when a tool is referenced in YAML but has no `.js` file? (Use built-in if available?)
4. Can v1 and v2 config packages coexist?

### Section 9: Example Config Packages

Provide **three complete config packages** showing the full power of v2:

**Package A: The Default Research Swarm** — equivalent to current behavior, but with all tools externalised as JS files. This proves backward compatibility.

**Package B: A Code Review Swarm** — a completely different use case with custom agents (reviewer, test-writer, security-auditor), custom tools (run_tests, lint_check, read_diff), custom prompts, and a pipeline topology. This proves the framework is domain-agnostic.

**Package C: A Debate/Adversarial Swarm** — two opposing agents (advocate, adversary) with a judge, custom synthesis (argument weighing), and a multi-round feedback loop. This proves complex topologies work.

For each package, show the complete directory listing, the full `swarm.yaml`, at least 2 tool JS files, and all prompt files. These should be realistic and runnable.

### Section 10: Risks and Trade-offs

Address:

- **Dynamic JS loading vs TypeScript type safety** — what's lost, what's gained?
- **Debugging external tools** — error messages, stack traces, source maps?
- **Performance** — dynamic import overhead, VM context creation cost?
- **Versioning** — how does a config package declare which runtime version it's compatible with?
- **Testing** — how do you test a config package without running a full swarm?
- **IDE support** — can we provide TypeScript type definitions for the tool context API so tool authors get autocomplete?

## Constraints

- The output must be a **complete, implementable specification** — not a wishlist. Every interface, every file path, every function signature.
- Maintain **full backward compatibility** with v1 configs. A v1 YAML file must still work with the v2 runtime.
- The runtime engine (`src/`) remains TypeScript. Only the config package contents (tools, strategies, nudges) are JavaScript.
- Do NOT propose changes to the core agent loop mechanics (ReAct iteration, compaction, token budgeting). These are engine internals. Focus on the **configuration surface** and **plugin loading**.
- Keep the existing SQLite context DB, worker pool, and JSON-line worker protocol. These are proven infrastructure.
- The specification must handle the **worker process boundary** — tools defined as JS files must work both in the main process (for in-process agents) and in worker child processes.
