import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { pipeline } from "@xenova/transformers";
import { nanoid } from "nanoid";

const DEFAULT_DB_PATH = resolve("data", "knowledge.db");

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
const EMBEDDING_DIM = 384; // Xenova/all-MiniLM-L6-v2

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

/** Convert a number[] vector to a Buffer of float32 for sqlite-vec */
function vectorToBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export class KnowledgeStore {
  private db: Database.Database;
  private extractor: FeatureExtractionPipeline;
  private insertChunk: Database.Statement;
  private insertVec: Database.Statement;
  private searchVec: Database.Statement;

  private constructor(
    db: Database.Database,
    extractor: FeatureExtractionPipeline
  ) {
    this.db = db;
    this.extractor = extractor;

    this.insertChunk = db.prepare(`
      INSERT INTO chunks (id, rowid_ref, text, source_type, source_ref, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.insertVec = db.prepare(`
      INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)
    `);
    this.searchVec = db.prepare(`
      SELECT rowid, distance FROM chunks_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `);
  }

  static async create(sessionDir?: string): Promise<KnowledgeStore> {
    const extractor = await pipeline(
      "feature-extraction",
      "Xenova/all-MiniLM-L6-v2"
    );

    const dbPath = sessionDir
      ? `${sessionDir}/knowledge.db`
      : DEFAULT_DB_PATH;

    // Ensure the directory exists
    mkdirSync(resolve(dbPath, ".."), { recursive: true });

    const db = new Database(dbPath);
    sqliteVec.load(db);

    // WAL mode for concurrent read access from worker processes
    db.pragma("journal_mode = WAL");

    // Metadata table (text + source info, keyed by integer rowid_ref matching vec table)
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        rowid_ref INTEGER NOT NULL,
        text TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        metadata TEXT DEFAULT '{}'
      )
    `);

    // Vector table for similarity search
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        embedding float[${EMBEDDING_DIM}]
      )
    `);

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

    const insertBatch = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const id = nanoid(12);
        // Insert into vec table first to get the rowid
        const result = this.insertVec.run(null, vectorToBuffer(vectors[i]));
        const rowid = result.lastInsertRowid;
        // Insert metadata row linked by rowid
        this.insertChunk.run(
          id,
          rowid,
          chunks[i],
          sourceType,
          sourceRef,
          JSON.stringify(meta || {})
        );
      }
    });

    insertBatch();
  }

  async query(
    queryText: string,
    topK = 5,
    filter?: { source_type?: string }
  ): Promise<KnowledgeChunk[]> {
    const queryVector = await this.embedQuery(queryText);
    const queryBuf = vectorToBuffer(queryVector);

    // Fetch more than topK if filtering, so we can post-filter
    const fetchLimit = filter?.source_type ? topK * 5 : topK;
    const vecResults = this.searchVec.all(queryBuf, fetchLimit) as Array<{
      rowid: number;
      distance: number;
    }>;

    if (vecResults.length === 0) return [];

    // Look up metadata for matched rowids
    const placeholders = vecResults.map(() => "?").join(",");
    let sql = `
      SELECT id, rowid_ref, text, source_type, source_ref, metadata
      FROM chunks WHERE rowid_ref IN (${placeholders})
    `;
    if (filter?.source_type) {
      sql += ` AND source_type = ?`;
    }

    const params: (string | number)[] = vecResults.map((r) => r.rowid);
    if (filter?.source_type) {
      params.push(filter.source_type);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: string;
      rowid_ref: number;
      text: string;
      source_type: string;
      source_ref: string;
      metadata: string;
    }>;

    // Build a map for ordering by distance
    const distanceMap = new Map(vecResults.map((r) => [r.rowid, r.distance]));
    const rowMap = new Map(rows.map((r) => [r.rowid_ref, r]));

    // Return in distance order, filtered
    const results: KnowledgeChunk[] = [];
    for (const vr of vecResults) {
      const row = rowMap.get(vr.rowid);
      if (!row) continue;
      results.push({
        id: row.id,
        text: row.text,
        vector: [], // don't return the full vector in query results
        source_type: row.source_type as KnowledgeChunk["source_type"],
        source_ref: row.source_ref,
        metadata: row.metadata,
      });
      if (results.length >= topK) break;
    }

    return results;
  }
}
