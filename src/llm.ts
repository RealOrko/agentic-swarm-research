import OpenAI from "openai";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const baseURL = process.env.BASE_URL || "http://localhost:8000/v1";
const model = process.env.MODEL_NAME || "mistral-small-24b";

export const client = new OpenAI({
  baseURL,
  apiKey: "not-needed",
});

export const MODEL = model;

/** Cached model info, populated by discoverModel() */
export interface ModelInfo {
  maxContextTokens: number;
  charsPerToken: number;
}

let _modelInfo: ModelInfo | null = null;

/**
 * Query the model server for context window size.
 * Call once at startup; results are cached.
 */
export async function discoverModel(silent = false): Promise<ModelInfo> {
  if (_modelInfo) return _modelInfo;

  let maxContext = 32768; // fallback default
  try {
    const resp = await client.models.list();
    for await (const m of resp) {
      if (m.id === model) {
        // vLLM exposes max_model_len on the model object
        const raw = m as unknown as Record<string, unknown>;
        if (typeof raw.max_model_len === "number") {
          maxContext = raw.max_model_len;
        }
        break;
      }
    }
  } catch {
    // If model discovery fails, use fallback
  }

  // Qwen tokenizers average ~3 chars/token for mixed English/code
  // GPT-style models average ~4. Use env override if needed.
  const charsPerToken = Number(process.env.CHARS_PER_TOKEN) || 3;

  _modelInfo = { maxContextTokens: maxContext, charsPerToken };
  if (!silent) {
    log("system", `Model: ${model} | context: ${maxContext} tokens | chars/token: ${charsPerToken}`);
  }
  return _modelInfo;
}

export function getModelInfo(): ModelInfo {
  if (!_modelInfo) {
    // Return conservative defaults if not yet discovered
    return { maxContextTokens: 32768, charsPerToken: 3 };
  }
  return _modelInfo;
}
