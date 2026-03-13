import type { SwarmConfig } from "./types.js";

/**
 * Build a default SwarmConfig that reproduces the current hardcoded behavior.
 * Environment variables are read for backward compatibility where the
 * codebase currently does so (e.g. BASE_URL, MODEL_NAME, MAX_WORKERS, etc.).
 */
export function buildDefaultConfig(): SwarmConfig {
  return {
    version: "1",

    global: {
      model: process.env.MODEL_NAME || "qwen3-coder-next",
      baseUrl: process.env.BASE_URL || "http://localhost:8000/v1",
      apiKey: "not-needed",
      charsPerToken: parseInt(process.env.CHARS_PER_TOKEN || "", 10) || 3,
      temperature: 0.7,
      dbPath: "data/knowledge.db",
      resultsDir: "results",
      vectorKvBaseUrl: "http://localhost:30080",
      limits: {
        maxWorkers: parseInt(process.env.MAX_WORKERS || "", 10) || 5,
        workerTimeoutMs: 300000,
        wallClockTimeoutMs: null,
        toolBatchSize: 5,
      },
      tokenBudget: {
        responseReserveFraction: 0.15,
        responseReserveMax: 4096,
        compactionTrigger: 0.85,
        compactionTarget: 0.75,
      },
    },

    tools: {
      web_search: {
        enabled: true,
        defaults: {
          topResults: 8,
          searxngUrl: process.env.SEARXNG_URL || "http://localhost:8080",
        },
      },
      fetch_page: {
        enabled: true,
        defaults: {
          maxContentChars: 4000,
          timeoutMs: 10000,
          maxRetries: 3,
        },
      },
      grep_code: {
        enabled: true,
        defaults: {
          maxResults: 30,
          maxResultsCap: 100,
          timeoutMs: 15000,
        },
      },
      search_code: {
        enabled: true,
        defaults: {
          numResults: 5,
          numResultsCap: 20,
          timeoutMs: 30000,
        },
      },
      query_knowledge: {
        enabled: true,
        defaults: {
          topK: 5,
          topKCap: 10,
        },
      },
      submit_finding: {
        enabled: true,
        terminates: true,
        defaults: {},
      },
      submit_critique: {
        enabled: true,
        terminates: true,
        defaults: {},
      },
    },

    agents: {
      orchestrator: {
        name: "orchestrator",
        role: "orchestrator",
        systemPrompt: "prompts/orchestrator.md",
        model: null,
        temperature: null,
        execution: "in-process",
        allowTextResponse: false,
        tools: [
          "research_question",
          "synthesize_findings",
          "critique",
          "submit_final_report",
        ],
        limits: {
          maxIterations: 100,
          toolCallBudget: 20,
          tokenBudgetFraction: 0.45,
          maxNudges: 3,
        },
        env: {},
      },
      researcher: {
        name: "researcher",
        role: "researcher",
        systemPrompt: "prompts/researcher.md",
        model: null,
        temperature: null,
        execution: "worker",
        allowTextResponse: false,
        tools: [
          "web_search",
          "fetch_page",
          "query_knowledge",
          "grep_code",
          "search_code",
          "submit_finding",
        ],
        limits: {
          maxIterations: 15,
          toolCallBudget: 12,
          tokenBudgetFraction: 0.30,
          maxNudges: 3,
        },
        env: {},
      },
      synthesizer: {
        name: "synthesizer",
        role: "synthesizer",
        systemPrompt: "prompts/synthesizer.md",
        model: null,
        temperature: null,
        execution: "worker",
        allowTextResponse: true,
        tools: [],
        limits: {
          maxIterations: 3,
          toolCallBudget: 12,
          tokenBudgetFraction: 0.40,
          maxNudges: 3,
        },
        env: {},
      },
      critic: {
        name: "critic",
        role: "critic",
        systemPrompt: "prompts/critic.md",
        model: null,
        temperature: null,
        execution: "worker",
        allowTextResponse: false,
        tools: ["submit_critique"],
        limits: {
          maxIterations: 3,
          toolCallBudget: 12,
          tokenBudgetFraction: 0.30,
          maxNudges: 3,
        },
        env: {},
      },
    },

    topology: {
      entrypoint: "orchestrator",
      edges: [
        {
          from: "orchestrator",
          to: "researcher",
          via: "research_question",
          cardinality: "fan-out",
        },
        {
          from: "orchestrator",
          to: "synthesizer",
          via: "synthesize_findings",
          cardinality: "single",
          strategy: { type: "tournament" },
        },
        {
          from: "orchestrator",
          to: "critic",
          via: "critique",
          cardinality: "single",
        },
        {
          from: "critic",
          to: "orchestrator",
          via: "feedback",
          cardinality: "single",
          condition: "result.approved === false",
          maxCycles: 2,
        },
      ],
      terminal: { agent: "orchestrator", tool: "submit_final_report" },
    },

    synthesis: {
      default: "tournament",
      strategies: {
        tournament: {
          maxDepth: 3,
          baseCaseSize: 3,
          synthesizerAgent: "synthesizer",
        },
      },
    },
  };
}
