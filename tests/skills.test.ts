import { getSkillsLoader, parseSkillFile } from '../src/skills/loader';
import { getSkillsRegistry, resetSkillsRegistry } from '../src/skills/registry';
import { resolveSkillResourcePath, resolveSkillsForTurn } from '../src/skills/runtime';
import type { SkillDefinition } from '../src/skills/types';
import { buildTool, type OpenHorseTool } from '../src/framework/tool';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const originalCwd = process.cwd();
const originalConfigDir = process.env.OPENHORSE_CONFIG_DIR;

function makeTool(name: string): OpenHorseTool {
  return buildTool({
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ success: true, output: '' }),
  });
}

function writeSkill(root: string, name: string, body: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf-8');
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalConfigDir !== undefined) {
    process.env.OPENHORSE_CONFIG_DIR = originalConfigDir;
  } else {
    delete process.env.OPENHORSE_CONFIG_DIR;
  }
  resetSkillsRegistry();
});

describe('SkillsLoader', () => {
  test('parseSkillFile parses valid skill', () => {
    const content = `---
name: test-skill
description: A test skill
trigger: /test
---
# Test Skill

This is a test skill prompt.`;

    const skill = parseSkillFile(content, '/path/to/SKILL.md');
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('test-skill');
    expect(skill?.description).toBe('A test skill');
    expect(skill?.trigger).toBe('/test');
    expect(skill?.prompt).toContain('Test Skill');
  });

  test('parseSkillFile returns null for invalid skill', () => {
    const content = 'No frontmatter here';
    const skill = parseSkillFile(content, '/path/to/SKILL.md');
    expect(skill).toBeNull();
  });

  test('loader loads skills', () => {
    const loader = getSkillsLoader();
    const skills = loader.load();
    expect(skills.length).toBeGreaterThan(0);
  });

  test('loader finds builtin skills', () => {
    const loader = getSkillsLoader();
    loader.load();
    const skill = loader.getSkill('code-review');
    expect(skill).toBeDefined();
    expect(skill?.name).toBe('code-review');
  });

  test('shouldTrigger detects string trigger', () => {
    const loader = getSkillsLoader();
    const skill: SkillDefinition = {
      name: 'test',
      description: 'Test skill',
      trigger: '/test',
      prompt: 'test',
    };

    expect(loader.shouldTrigger(skill, '/test something')).toBe(true);
    expect(loader.shouldTrigger(skill, 'no match')).toBe(false);
  });

  test('shouldTrigger detects regex trigger', () => {
    const loader = getSkillsLoader();
    const skill: SkillDefinition = {
      name: 'test',
      description: 'Test skill',
      trigger: /review\s+\w+/i,
      prompt: 'test',
    };

    expect(loader.shouldTrigger(skill, 'review code')).toBe(true);
    expect(loader.shouldTrigger(skill, 'no match')).toBe(false);
  });

  test('findMatchingSkills returns matches', () => {
    const loader = getSkillsLoader();
    loader.load();
    const matches = loader.findMatchingSkills('/review code');
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some(s => s.name === 'code-review')).toBe(true);
  });
});

describe('SkillsRegistry', () => {
  test('registry initializes', () => {
    const registry = getSkillsRegistry();
    registry.initialize();
    const skills = registry.getAllSkills();
    expect(skills.length).toBeGreaterThan(0);
  });

  test('registry has skill', () => {
    const registry = getSkillsRegistry();
    registry.initialize();
    expect(registry.hasSkill('code-review')).toBe(true);
  });

  test('registry executes skill', () => {
    const registry = getSkillsRegistry();
    registry.initialize();
    const result = registry.executeSkill('code-review', {
      cwd: process.cwd(),
      input: '/review',
      tools: [],
    });

    expect(result.skill).toBe('code-review');
    expect(result.triggered).toBe(true);
    expect(result.prompt).toBeDefined();
  });

  test('registry generates system prompt injection', () => {
    const registry = getSkillsRegistry();
    registry.initialize();
    const injection = registry.generateSystemPromptInjection();
    expect(injection).toContain('Available Skills');
    expect(injection).toContain('code-review');
  });

  test('registry returns summary', () => {
    const registry = getSkillsRegistry();
    registry.initialize();
    const summary = registry.getSummary();
    expect(summary.count).toBeGreaterThan(0);
    expect(summary.names).toContain('code-review');
  });
});

describe('Skills runtime', () => {
  test('injects full matched skill prompt and scopes tools for the turn', () => {
    resetSkillsRegistry();
    const tools = ['read_file', 'glob', 'grep', 'write_file'].map(makeTool);

    const resolution = resolveSkillsForTurn({
      cwd: process.cwd(),
      input: '/review src',
      tools,
    });

    expect(resolution.skills.map(s => s.name)).toContain('code-review');
    expect(resolution.promptInjection).toContain('# Code Review Skill');
    expect(resolution.promptInjection).toContain('Resource root:');
    expect(resolution.toolScopeActive).toBe(true);
    expect(resolution.tools.map(t => t.name).sort()).toEqual(['glob', 'grep', 'read_file']);
  });

  test('project skills override user and builtin skills with the same name', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.OPENHORSE_CONFIG_DIR = configDir;
    process.chdir(projectDir);

    writeSkill(join(configDir, 'skills'), 'code-review', `---
name: code-review
description: User review
trigger: /review
priority: 100
---
User skill prompt`);

    writeSkill(join(projectDir, '.openhorse', 'skills'), 'code-review', `---
name: code-review
description: Project review
trigger: /review
priority: 1
---
Project skill prompt`);

    resetSkillsRegistry();
    const skill = getSkillsRegistry().getSkill('code-review');

    expect(skill?.description).toBe('Project review');
    expect(skill?.prompt).toContain('Project skill prompt');
    expect(skill?.sourceType).toBe('project');

    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('resolves skill resources from the skill root and blocks escapes', () => {
    resetSkillsRegistry();
    const resolution = resolveSkillsForTurn({
      cwd: process.cwd(),
      input: '/review src',
      tools: ['read_file', 'glob', 'grep'].map(makeTool),
    });

    const skill = resolution.skills.find(s => s.name === 'code-review');
    expect(skill).toBeDefined();

    const resolved = resolveSkillResourcePath(skill!, 'assets/example.txt');
    expect(resolved).toContain('/code-review/assets/example.txt');
    expect(() => resolveSkillResourcePath(skill!, '../outside.txt')).toThrow('escapes root');
  });
});
