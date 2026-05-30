/**
 * openhorse - Vector Store
 *
 * 基于 sqlite-vec 的向量存储层
 */

import Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';  // Issue #32 #3.4: 用于 hashProject
import { getEmbeddingService, type EmbeddingConfig } from './embeddings';
import type { MemoryEntry, MemoryType } from './types';

// ============================================================================
// Types
// ============================================================================

export interface SearchResult {
  id: string;
  name: string;
  type: MemoryType;
  content: string;
  description: string;
  score: number;
  createdAt: number;
}

export interface VectorStoreConfig {
  dbPath?: string;
  embeddingConfig?: EmbeddingConfig;
}

// ============================================================================
// Vector Store
// ============================================================================

export class VectorStore {
  private db: Database.Database;
  private embeddingService: ReturnType<typeof getEmbeddingService>;
  private initialized: boolean = false;

  constructor(config?: VectorStoreConfig) {
    // Determine database path
    const configHome = process.env.OPENHORSE_CONFIG_HOME || join(process.env.HOME || '', '.openhorse');
    const dbPath = config?.dbPath || join(configHome, 'vector.db');

    // Ensure directory exists
    const dbDir = join(dbPath, '..');
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    // Initialize database
    this.db = new Database(dbPath);

    // Get embedding service
    this.embeddingService = getEmbeddingService(config?.embeddingConfig);

    // Initialize tables
    this.initialize();
  }

  /** Initialize database tables */
  private initialize(): void {
    // Create memories table (without vector column initially)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        description TEXT,
        project TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Create index on type and project
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project)
    `);

    // Try to create vector column using sqlite-vec
    try {
      const dimension = this.embeddingService.getDimension();
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(
          embedding FLOAT[${dimension}]
        )
      `);

      // Link table for vector -> memory
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS memory_vectors (
          memory_id TEXT PRIMARY KEY,
          vector_rowid INTEGER,
          FOREIGN KEY (memory_id) REFERENCES memories(id)
        )
      `);

      this.initialized = true;
    } catch (err: any) {
      // sqlite-vec may not be available - fall back to text search only
      console.warn(`[VectorStore] sqlite-vec not available: ${err.message}`);
      this.initialized = false;
    }
  }

  /** Check if vector search is available */
  isVectorSearchAvailable(): boolean {
    return this.initialized;
  }

  /** Insert or update memory with embedding - Issue #32 #3.3: 使用事务 */
  async upsert(entry: MemoryEntry, projectPath?: string): Promise<void> {
    const projectHash = projectPath ? this.hashProject(projectPath) : 'global';

    // Issue #32 #3.3: 使用事务确保 embed 失败时不写 memories 表
    const upsertTransaction = this.db.transaction((data: {
      name: string;
      type: string;
      content: string;
      description: string;
      projectHash: string;
      createdAt: number;
      updatedAt: number;
    }) => {
      // Insert/update memory record
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO memories (id, name, type, content, description, project, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        data.name,
        data.name,
        data.type,
        data.content,
        data.description,
        data.projectHash,
        data.createdAt,
        data.updatedAt
      );
    });

    // Generate embedding first (before transaction)
    if (this.initialized) {
      try {
        const vector = await this.embeddingService.embed(entry.content);

        // Now execute transaction with the data
        upsertTransaction({
          name: entry.name,
          type: entry.type,
          content: entry.content,
          description: entry.description || entry.content.slice(0, 100),
          projectHash,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        });

        // Delete old vector if exists
        this.db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(entry.name);
        this.db.prepare('DELETE FROM vec_memories WHERE rowid IN (SELECT vector_rowid FROM memory_vectors WHERE memory_id = ?)').run(entry.name);

        // Insert new vector
        const vectorStmt = this.db.prepare(`INSERT INTO vec_memories (embedding) VALUES (?)`);
        const result = vectorStmt.run(JSON.stringify(vector));

        // Link vector to memory
        this.db.prepare('INSERT INTO memory_vectors (memory_id, vector_rowid) VALUES (?, ?)').run(
          entry.name,
          result.lastInsertRowid
        );
      } catch (err: any) {
        console.warn(`[VectorStore] Failed to store embedding: ${err.message}`);
        // embed 失败时不写入 memories 表（事务未执行）
        throw err;
      }
    } else {
      // No vector search - just write memory
      upsertTransaction({
        name: entry.name,
        type: entry.type,
        content: entry.content,
        description: entry.description || entry.content.slice(0, 100),
        projectHash,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      });
    }
  }

  /** Delete memory */
  delete(name: string): void {
    // Delete vector link
    if (this.initialized) {
      this.db.prepare('DELETE FROM vec_memories WHERE rowid IN (SELECT vector_rowid FROM memory_vectors WHERE memory_id = ?)').run(name);
      this.db.prepare('DELETE FROM memory_vectors WHERE memory_id = ?').run(name);
    }

    // Delete memory record
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(name);
  }

  /** Search by similarity */
  async search(query: string, limit: number = 10, projectPath?: string): Promise<SearchResult[]> {
    const projectHash = projectPath ? this.hashProject(projectPath) : undefined;

    // If vector search available, use semantic search
    if (this.initialized) {
      return this.semanticSearch(query, limit, projectHash);
    }

    // Otherwise fall back to text search
    return this.textSearch(query, limit, projectHash);
  }

  /** Semantic search using vectors */
  private async semanticSearch(query: string, limit: number, projectHash?: string): Promise<SearchResult[]> {
    try {
      const queryVector = await this.embeddingService.embed(query);

      // Use sqlite-vec for similarity search
      const sql = projectHash
        ? `
          SELECT m.id, m.name, m.type, m.content, m.description, m.created_at,
                 vec_distance_cosine(v.embedding, ?) as distance
          FROM memories m
          JOIN memory_vectors mv ON m.id = mv.memory_id
          JOIN vec_memories v ON mv.vector_rowid = v.rowid
          WHERE m.project = ?
          ORDER BY distance ASC
          LIMIT ?
        `
        : `
          SELECT m.id, m.name, m.type, m.content, m.description, m.created_at,
                 vec_distance_cosine(v.embedding, ?) as distance
          FROM memories m
          JOIN memory_vectors mv ON m.id = mv.memory_id
          JOIN vec_memories v ON mv.vector_rowid = v.rowid
          ORDER BY distance ASC
          LIMIT ?
        `;

      const stmt = this.db.prepare(sql);
      const params = projectHash
        ? [JSON.stringify(queryVector), projectHash, limit]
        : [JSON.stringify(queryVector), limit];

      const rows = stmt.all(...params) as any[];

      return rows.map(row => ({
        id: row.id,
        name: row.name,
        type: row.type as MemoryType,
        content: row.content,
        description: row.description,
        score: 1 - row.distance, // Convert distance to similarity score
        createdAt: row.created_at,
      }));
    } catch (err: any) {
      console.warn(`[VectorStore] Semantic search failed: ${err.message}`);
      return this.textSearch(query, limit, projectHash);
    }
  }

  /** Text search fallback */
  private textSearch(query: string, limit: number, projectHash?: string): SearchResult[] {
    const sql = projectHash
      ? `
        SELECT id, name, type, content, description, created_at
        FROM memories
        WHERE project = ? AND (content LIKE ? OR name LIKE ? OR description LIKE ?)
        LIMIT ?
      `
      : `
        SELECT id, name, type, content, description, created_at
        FROM memories
        WHERE content LIKE ? OR name LIKE ? OR description LIKE ?
        LIMIT ?
      `;

    const searchTerm = `%${query}%`;
    const stmt = this.db.prepare(sql);
    const params = projectHash
      ? [projectHash, searchTerm, searchTerm, searchTerm, limit]
      : [searchTerm, searchTerm, searchTerm, limit];

    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type as MemoryType,
      content: row.content,
      description: row.description,
      score: 0.5, // Default score for text search
      createdAt: row.created_at,
    }));
  }

  /** Get all memories for a project */
  getAll(projectPath?: string): SearchResult[] {
    const projectHash = projectPath ? this.hashProject(projectPath) : undefined;

    const sql = projectHash
      ? 'SELECT id, name, type, content, description, created_at FROM memories WHERE project = ?'
      : 'SELECT id, name, type, content, description, created_at FROM memories';

    const stmt = this.db.prepare(sql);
    const params = projectHash ? [projectHash] : [];
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type as MemoryType,
      content: row.content,
      description: row.description,
      score: 1,
      createdAt: row.created_at,
    }));
  }

  /** Hash project path - Issue #32 #3.4: 使用 SHA256 避免路径冲突 */
  private hashProject(projectPath: string): string {
    // 使用 SHA256 生成唯一哈希，避免路径冲突
    return createHash('sha256').update(projectPath).digest('hex').slice(0, 16);
  }

  /** Close database */
  close(): void {
    this.db.close();
  }
}

// ============================================================================
// Factory
// ============================================================================

let defaultStore: VectorStore | null = null;

export function getVectorStore(config?: VectorStoreConfig): VectorStore {
  if (!defaultStore) {
    defaultStore = new VectorStore(config);
  }
  return defaultStore;
}

export function resetVectorStore(): void {
  if (defaultStore) {
    defaultStore.close();
    defaultStore = null;
  }
}