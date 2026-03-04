import OpenAI from "openai";
import "dotenv/config";

const baseURL = process.env.BASE_URL || "http://localhost:8000/v1";
const model = process.env.MODEL_NAME || "qwen3-coder-30b-a3b";

export const client = new OpenAI({
  baseURL,
  apiKey: "not-needed",
});

export const MODEL = model;
