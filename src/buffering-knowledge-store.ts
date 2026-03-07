/**
 * Lightweight KnowledgeStore substitute for child process workers.
 *
 * This module deliberately avoids importing @lancedb/lancedb or
 * @xenova/transformers so that worker processes stay lightweight.
 */

export interface KnowledgeIndexRequest {
  text: string;
  sourceType: string;
  sourceRef: string;
  meta?: Record<string, unknown>;
}

export class BufferingKnowledgeStore {
  private buffer: KnowledgeIndexRequest[] = [];

  async index(
    text: string,
    sourceType: string,
    sourceRef: string,
    meta?: Record<string, unknown>
  ): Promise<void> {
    if (!text || text.trim().length === 0) return;
    this.buffer.push({ text, sourceType, sourceRef, meta });
  }

  async query(
    _queryText: string,
    _topK?: number,
    _filter?: { source_type?: string }
  ): Promise<never[]> {
    return [];
  }

  getBuffer(): KnowledgeIndexRequest[] {
    return this.buffer;
  }
}
