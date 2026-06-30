import { getSkillsLoader, normalizeSkillSourcePath, parseSkillFile } from '../src/skills/loader';
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

  test('parseSkillFile normalizes markdown link source locators', () => {
    const content = `---
name: chronicle
description: Screen history
---
# Chronicle`;

    const source = '[$chronicle](/Users/hope/.codex/skills/chronicle/SKILL.md)';
    const skill = parseSkillFile(content, source);

    expect(normalizeSkillSourcePath(source)).toBe('/Users/hope/.codex/skills/chronicle/SKILL.md');
    expect(skill?.name).toBe('chronicle');
    expect(skill?.source).toBe('/Users/hope/.codex/skills/chronicle/SKILL.md');
  });

  test('parseSkillFile accepts BOM and CRLF frontmatter', () => {
    const content = '\uFEFF---\r\nname: crlf-skill\r\ndescription: CRLF skill\r\n---\r\n# Body';

    const skill = parseSkillFile(content, '/path/to/crlf/SKILL.md');

    expect(skill?.name).toBe('crlf-skill');
    expect(skill?.description).toBe('CRLF skill');
    expect(skill?.prompt).toBe('# Body');
  });

  test('parseSkillFile accepts legacy markdown-only skills without warning', () => {
    const content = `# GitHub Contribution Skill

Automated GitHub contribution workflow.

## Usage
Run the workflow.`;

    const skill = parseSkillFile(content, '/Users/hope/.openhorse/skills/github-contribution/SKILL.md');

    expect(skill?.name).toBe('github-contribution');
    expect(skill?.description).toBe('Automated GitHub contribution workflow.');
    expect(skill?.prompt).toContain('GitHub Contribution Skill');
  });

  test('parseSkillFile returns null for invalid skill', () => {
    const content = 'No frontmatter here';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const skill = parseSkillFile(content, '/path/to/SKILL.md');
      expect(skill).toBeNull();
    } finally {
      warn.mockRestore();
    }
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

  test('configured skills paths load external roots and direct skill directories', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-extra-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    const externalRoot = join(tempRoot, 'external-root');
    const directSkillDir = join(tempRoot, 'direct-skill');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.OPENHORSE_CONFIG_DIR = configDir;
    process.chdir(projectDir);

    writeFileSync(join(configDir, 'openhorse.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
      skills: {
        paths: [externalRoot, directSkillDir],
      },
    }), 'utf-8');

    writeSkill(externalRoot, 'coding-squad', `---
name: coding-squad
description: External squad workflow
trigger: coding-squad
---
External squad prompt`);

    mkdirSync(directSkillDir, { recursive: true });
    writeFileSync(join(directSkillDir, 'SKILL.md'), `---
name: direct-skill
description: Direct skill path
trigger: direct-skill
---
Direct prompt`, 'utf-8');

    resetSkillsRegistry();
    const registry = getSkillsRegistry();

    expect(registry.getSkill('coding-squad')?.description).toBe('External squad workflow');
    expect(registry.getSkill('coding-squad')?.sourceType).toBe('configured');
    expect(registry.getSkill('direct-skill')?.description).toBe('Direct skill path');
    expect(registry.getSkill('direct-skill')?.sourceType).toBe('configured');

    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('project skills override configured skills with the same name', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'openhorse-skills-priority-'));
    const configDir = join(tempRoot, 'home');
    const projectDir = join(tempRoot, 'project');
    const externalRoot = join(tempRoot, 'external-root');
    mkdirSync(configDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    process.env.OPENHORSE_CONFIG_DIR = configDir;
    process.chdir(projectDir);

    writeFileSync(join(configDir, 'openhorse.json'), JSON.stringify({
      defaultModel: 'gpt-4o',
      skills: {
        paths: [externalRoot],
      },
    }), 'utf-8');

    writeSkill(externalRoot, 'code-review', `---
name: code-review
description: Configured review
trigger: /review
priority: 100
---
Configured skill prompt`);

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
