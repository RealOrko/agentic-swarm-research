import * as lancedb from "@lancedb/lancedb";
import { pipeline } from "@xenova/transformers";
import { nanoid } from "nanoid";

export interface KnowledgeChunk {
  id: string;
  text: string;
  vector: number[];
  source_type: "code" | "web_page" | "search_snippet" | "grep_match";
  source_ref: string; // file path or URL
  metadata: string; // JSON string for extra data (line range, title, query)
}

const CHUNK_TARGET = 500;
const CHUNK_OVERLAP = 50;

type FeatureExtractionPipeline = Awaited<
  ReturnType<typeof pipeline<"feature-extraction">>
>;

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
  private db: lancedb.Connection;
  private table: lancedb.Table | null = null;
  private extractor: FeatureExtractionPipeline;

  private constructor(
    db: lancedb.Connection,
    extractor: FeatureExtractionPipeline
  ) {
    this.db = db;
    this.extractor = extractor;
  }

  static async create(sessionDir?: string): Promise<KnowledgeStore> {
    const extractor = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );
    const dbPath = sessionDir || `/tmp/research-kb-${Date.now()}`;
    const db = await lancedb.connect(dbPath);
    return new KnowledgeStore(db, extractor);
  }

  /** Embed an array of texts into vectors */
  private async embedTexts(texts: string[]): Promise<number[][]> {
    const output = await this.extractor(texts, {
      pooling: "mean",
      normalize: true,
    });
    // output.data is a flat Float32Array, reshape into per-text vectors
    const dim = output.dims[output.dims.length - 1];
    const vectors: number[][] = [];
    for (let i = 0; i < texts.length; i++) {
      vectors.push(
        Array.from(output.data.slice(i * dim, (i + 1) * dim) as Float32Array)
      );
    }
    return vectors;
  }

  /** Embed a single query text */
  private async embedQuery(text: string): Promise<number[]> {
    const output = await this.extractor(text, {
      pooling: "mean",
      normalize: true,
    });
    return Array.from(output.data as Float32Array);
  }

  async index(
    text: string,
    sourceType: string,
    sourceRef: string,
    meta?: Record<string, unknown>
  ): Promise<void> {
    if (!text || text.trim().length === 0) return;

    const chunks = chunkText(text);
    const vectors = await this.embedTexts(chunks);

    const rows: KnowledgeChunk[] = chunks.map((chunk, i) => ({
      id: nanoid(12),
      text: chunk,
      vector: vectors[i],
      source_type: sourceType as KnowledgeChunk["source_type"],
      source_ref: sourceRef,
      metadata: JSON.stringify(meta || {}),
    }));

    const data = rows as unknown as Record<string, unknown>[];
    if (!this.table) {
      this.table = await this.db.createTable("chunks", data);
    } else {
      await this.table.add(data);
    }
  }

  async query(
    queryText: string,
    topK = 5,
    filter?: { source_type?: string }
  ): Promise<KnowledgeChunk[]> {
    if (!this.table) return [];

    const queryVector = await this.embedQuery(queryText);

    let q = this.table.search(queryVector).limit(topK);
    if (filter?.source_type) {
      q = q.where(`source_type = '${filter.source_type}'`);
    }

    const results = await q.toArray();
    return results.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      text: r.text as string,
      vector: r.vector as number[],
      source_type: r.source_type as KnowledgeChunk["source_type"],
      source_ref: r.source_ref as string,
      metadata: r.metadata as string,
    }));
  }
}
