/**
 * openhorse - Embedding Service
 *
 * 支持 Ollama (nomic-embed-text) 和 OpenAI (text-embedding-3-small)
 */

import axios from 'axios';

// ============================================================================
// Types
// ============================================================================

export interface EmbeddingConfig {
  provider: 'ollama' | 'openai';
  model?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface EmbeddingResult {
  vector: number[];
  dimension: number;
}

// ============================================================================
// Embedding Service
// ============================================================================

export class EmbeddingService {
  private config: EmbeddingConfig;
  private dimension: number;

  constructor(config: EmbeddingConfig) {
    this.config = config;

    // Set dimension based on provider/model
    if (config.provider === 'ollama') {
      this.dimension = 768; // nomic-embed-text
    } else {
      this.dimension = 1536; // text-embedding-3-small
    }
  }

  /** Get embedding dimension */
  getDimension(): number {
    return this.dimension;
  }

  /** Embed single text */
  async embed(text: string): Promise<number[]> {
    if (this.config.provider === 'ollama') {
      return this.embedWithOllama(text);
    } else {
      return this.embedWithOpenAI(text);
    }
  }

  /** Embed batch of texts */
  async embedBatch(texts: string[]): Promise<number[][]> {
    // Process in parallel with rate limiting
    const results: number[][] = [];
    const batchSize = 10;

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(t => this.embed(t)));
      results.push(...batchResults);
    }

    return results;
  }

  /** Embed using Ollama */
  private async embedWithOllama(text: string): Promise<number[]> {
    const baseUrl = this.config.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const model = this.config.model || 'nomic-embed-text';

    try {
      const response = await axios.post(`${baseUrl}/api/embeddings`, {
        model,
        prompt: text,
      }, {
        timeout: 30000,
      });

      return response.data.embedding;
    } catch (err: any) {
      // Fallback: return zero vector if Ollama unavailable
      console.warn(`[Embedding] Ollama unavailable: ${err.message}`);
      return new Array(this.dimension).fill(0);
    }
  }

  /** Embed using OpenAI */
  private async embedWithOpenAI(text: string): Promise<number[]> {
    const apiKey = this.config.apiKey || process.env.OPENAI_API_KEY || process.env.OPENHORSE_API_KEY;
    const model = this.config.model || 'text-embedding-3-small';

    if (!apiKey) {
      console.warn('[Embedding] OpenAI API key not configured');
      return new Array(this.dimension).fill(0);
    }

    try {
      const response = await axios.post(
        'https://api.openai.com/v1/embeddings',
        {
          model,
          input: text,
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      return response.data.data[0].embedding;
    } catch (err: any) {
      console.warn(`[Embedding] OpenAI unavailable: ${err.message}`);
      return new Array(this.dimension).fill(0);
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

let defaultService: EmbeddingService | null = null;

export function getEmbeddingService(config?: EmbeddingConfig): EmbeddingService {
  if (!defaultService) {
    // Auto-detect provider from environment
    const provider = process.env.OPENHORSE_EMBEDDING_PROVIDER ||
      (process.env.OLLAMA_BASE_URL ? 'ollama' : 'openai');

    defaultService = new EmbeddingService({
      provider: provider as 'ollama' | 'openai',
      model: process.env.OPENHORSE_EMBEDDING_MODEL,
      baseUrl: process.env.OLLAMA_BASE_URL,
      apiKey: process.env.OPENHORSE_API_KEY,
      ...config,
    });
  }

  return defaultService;
}

export function resetEmbeddingService(): void {
  defaultService = null;
}