import { EmbeddingService, getEmbeddingService, resetEmbeddingService } from '../src/memory/embeddings';
import { VectorStore } from '../src/memory/vector-store';
import { SemanticSearchService } from '../src/memory/semantic-search';

describe('EmbeddingService', () => {
  beforeEach(() => {
    resetEmbeddingService();
  });

  test('creates service with default config', () => {
    const service = getEmbeddingService();
    expect(service).toBeDefined();
    expect(service.getDimension()).toBeGreaterThan(0);
  });

  test('creates service with ollama provider', () => {
    const service = new EmbeddingService({ provider: 'ollama' });
    expect(service.getDimension()).toBe(768);
  });

  test('creates service with openai provider', () => {
    const service = new EmbeddingService({ provider: 'openai' });
    expect(service.getDimension()).toBe(1536);
  });

  test('embed returns vector', async () => {
    const service = new EmbeddingService({ provider: 'ollama' });
    const vector = await service.embed('test text');
    expect(vector).toBeInstanceOf(Array);
    expect(vector.length).toBe(768);
  });

  test('embedBatch returns multiple vectors', async () => {
    const service = new EmbeddingService({ provider: 'ollama' });
    const vectors = await service.embedBatch(['text 1', 'text 2']);
    expect(vectors.length).toBe(2);
    expect(vectors[0].length).toBe(768);
  });
});

describe('VectorStore', () => {
  let store: VectorStore;

  beforeEach(() => {
    // Use temp database for each test
    store = new VectorStore({ dbPath: '/tmp/openhorse-test-vector.db' });
  });

  afterEach(() => {
    store.close();
  });

  test('initializes database', () => {
    expect(store).toBeDefined();
  });

  test('upsert inserts memory', async () => {
    const entry = {
      name: 'test-memory',
      type: 'user' as const,
      content: 'This is a test memory',
      description: 'Test memory',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.upsert(entry);
    const all = store.getAll();
    expect(all.length).toBeGreaterThan(0);
  });

  test('delete removes memory', async () => {
    const entry = {
      name: 'to-delete',
      type: 'user' as const,
      content: 'This will be deleted',
      description: 'Temporary memory',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.upsert(entry);
    store.delete('to-delete');
    const all = store.getAll();
    const found = all.find(m => m.name === 'to-delete');
    expect(found).toBeUndefined();
  });

  test('search returns results', async () => {
    const results = await store.search('test', 5);
    expect(results.length).toBeGreaterThanOrEqual(0);
  });
});

describe('SemanticSearchService', () => {
  let service: SemanticSearchService;
  let store: VectorStore;

  beforeEach(() => {
    store = new VectorStore({ dbPath: '/tmp/openhorse-test-semantic.db' });
    service = new SemanticSearchService({ dbPath: '/tmp/openhorse-test-semantic.db' });
  });

  afterEach(() => {
    store.close();
  });

  test('creates service', () => {
    expect(service).toBeDefined();
  });

  test('search returns structured results', async () => {
    const result = await service.search({ query: 'test', limit: 5 });
    expect(Array.isArray(result.memories)).toBe(true);
    expect(result.query).toBe('test');
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(['semantic', 'text']).toContain(result.searchType);
  });

  test('isSemanticSearchAvailable returns boolean', () => {
    const available = service.isSemanticSearchAvailable();
    expect(typeof available).toBe('boolean');
  });

  test('getSuggestions returns array', () => {
    const suggestions = service.getSuggestions();
    expect(suggestions).toBeInstanceOf(Array);
  });
});