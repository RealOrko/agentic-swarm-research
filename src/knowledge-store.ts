import { nanoid } from "nanoid";

const VECTOR_KV_BASE = "http://localhost:30080";

const CHUNK_TARGET = 500;
const CHUNK_OVERLAP = 50;

export interface KnowledgeChunk {
  id: string;
  text: string;
  vector: number[];
  source_type: "code" | "web_page" | "search_snippet" | "grep_match";
  source_ref: string; // file path or URL
  metadata: string; // JSON string for extra data (line range, title, query)
}

/** Split text into ~500-char chunks with overlap */
function chunkText(text: string): string[] {
  if (text.length <= CHUNK_TARGET) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= CHUNK_TARGET) {
      current = current ? current + "\n\n" + para : para;
    } else {
      if (current) chunks.push(current);
      // If a single paragraph exceeds target, split at sentence boundaries
      if (para.length > CHUNK_TARGET) {
        const sentences = para.split(/(?<=[.!?])\s+/);
        let sentBuf = "";
        for (const sent of sentences) {
          if (sentBuf.length + sent.length + 1 <= CHUNK_TARGET) {
            sentBuf = sentBuf ? sentBuf + " " + sent : sent;
          } else {
            if (sentBuf) chunks.push(sentBuf);
            sentBuf = sent;
          }
        }
        current = sentBuf;
      } else {
        current = para;
      }
    }
  }
  if (current) chunks.push(current);

  // Add overlap: prepend tail of previous chunk to each subsequent chunk
  if (chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const overlap = prev.slice(-CHUNK_OVERLAP);
      chunks[i] = overlap + chunks[i];
    }
  }

  return chunks;
}

export class KnowledgeStore {
  private sessionId: string;
  private baseUrl: string;

  constructor(sessionId: string, baseUrl?: string) {
    this.sessionId = sessionId;
    this.baseUrl = baseUrl || VECTOR_KV_BASE;
  }

  private key(): string {
    return `research::${this.sessionId}`;
  }

  async index(
    text: string,
    sourceType: string,
    sourceRef: string,
    meta?: Record<string, unknown>
  ): Promise<void> {
    if (!text || text.trim().length === 0) return;

    const chunks = chunkText(text);

    for (const chunk of chunks) {
      const payload = JSON.stringify({
        id: nanoid(12),
        text: chunk,
        source_type: sourceType,
        source_ref: sourceRef,
        metadata: meta || {},
      });

      try {
        await fetch(`${this.baseUrl}/${encodeURIComponent(this.key())}`, {
          method: "POST",
          body: payload,
        });
      } catch {
        // Silently skip failed indexing — non-critical
      }
    }
  }

  async query(
    queryText: string,
    topK = 5,
    filter?: { source_type?: string }
  ): Promise<KnowledgeChunk[]> {
    const fetchLimit = filter?.source_type ? topK * 5 : topK;
    const url = `${this.baseUrl}/${encodeURIComponent(this.key())}?q=${encodeURIComponent(queryText)}&k=${fetchLimit}`;

    let results: Array<{ content: string; distance: number }>;
    try {
      const response = await fetch(url);
      if (!response.ok) return [];
      results = (await response.json()) as Array<{
        content: string;
        distance: number;
      }>;
    } catch {
      return [];
    }

    const chunks: KnowledgeChunk[] = [];
    for (const r of results) {
      try {
        const parsed = JSON.parse(r.content);
        if (filter?.source_type && parsed.source_type !== filter.source_type)
          continue;
        chunks.push({
          id: parsed.id || nanoid(12),
          text: parsed.text,
          vector: [],
          source_type: parsed.source_type,
          source_ref: parsed.source_ref,
          metadata: JSON.stringify(parsed.metadata || {}),
        });
        if (chunks.length >= topK) break;
      } catch {
        // Skip malformed entries
      }
    }

    return chunks;
  }
}
