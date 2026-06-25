/**
 * Tool Artifacts unit tests
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  storeArtifact,
  retrieveArtifact,
  truncateForContext,
  ARTIFACT_THRESHOLD,
  cleanupArtifacts,
} from '../src/core/tool-artifacts';
import { getProjectArtifactsDir } from '../src/services/config-dir';

const TEST_PROJECT = '/tmp/openhorse-artifact-test';

describe('tool-artifacts', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_PROJECT)) {
      fs.rmSync(TEST_PROJECT, { recursive: true, force: true });
    }
    fs.mkdirSync(TEST_PROJECT, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_PROJECT)) {
      fs.rmSync(TEST_PROJECT, { recursive: true, force: true });
    }
  });

  test('ARTIFACT_THRESHOLD is 10KB', () => {
    expect(ARTIFACT_THRESHOLD).toBe(10_240);
  });

  test('storeArtifact creates a file and returns reference', () => {
    const output = 'Hello, artifact!';
    const artifact = storeArtifact(TEST_PROJECT, 'read_file', output, Buffer.byteLength(output));

    expect(artifact).not.toBeNull();
    expect(artifact!.id).toMatch(/^read_file-\d+-[a-z0-9]+$/);
    expect(artifact!.outputBytes).toBe(Buffer.byteLength(output));
    expect(artifact!.truncated).toBe(false);
    expect(fs.existsSync(artifact!.path)).toBe(true);
    expect(artifact!.path.startsWith(getProjectArtifactsDir(TEST_PROJECT))).toBe(true);
  });

  test('retrieveArtifact returns the stored content', () => {
    const output = 'Test content for retrieval';
    const artifact = storeArtifact(TEST_PROJECT, 'grep', output, Buffer.byteLength(output));

    const retrieved = retrieveArtifact(artifact!.path);
    expect(retrieved).toBe(output);
  });

  test('storeArtifact returns null for empty project path', () => {
    const artifact = storeArtifact('', 'test', 'data', 4);
    expect(artifact).toBeNull();
  });

  test('truncateForContext truncates large outputs', () => {
    const largeOutput = 'A'.repeat(20_000);
    const truncated = truncateForContext(largeOutput, 100);

    // Truncated output should be close to maxBytes (header + tail + message)
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(250);
    expect(truncated).toContain('AAAA');
    expect(truncated).toContain('truncated');
    expect(truncated).toContain('20000B total');
    expect(truncated).toContain('see artifact for full output');
  });

  test('truncateForContext returns unchanged for small outputs', () => {
    const small = 'Small output';
    expect(truncateForContext(small, 100)).toBe(small);
  });

  test('truncateForContext handles non-ASCII characters', () => {
    const chinese = '中文'.repeat(5000);
    const truncated = truncateForContext(chinese, 100);

    expect(truncated).toContain('truncated');
    expect(truncated).toContain('total');
  });

  test('cleanupArtifacts removes old files', () => {
    const artifact = storeArtifact(TEST_PROJECT, 'test', 'data', 4);
    // Make the file old
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
    fs.utimesSync(artifact!.path, oldTime, oldTime);

    cleanupArtifacts(TEST_PROJECT);

    expect(fs.existsSync(artifact!.path)).toBe(false);
  });

  test('cleanupArtifacts keeps recent files', () => {
    const artifact = storeArtifact(TEST_PROJECT, 'test', 'data', 4);
    // File is current (default)

    cleanupArtifacts(TEST_PROJECT);

    expect(fs.existsSync(artifact!.path)).toBe(true);
  });
});
