export { buildDefaultConfig } from "./defaults.js";
export { loadConfigFromFile, mergeWithDefaults } from "./loader.js";
export { validateConfig } from "./validate.js";
export type {
  SwarmConfig,
  ToolConfig,
  AgentDefinition,
  TopologyEdge,
  ValidationResult,
  ValidationError,
} from "./types.js";
