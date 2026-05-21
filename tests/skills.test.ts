import { getSkillsLoader, parseSkillFile } from '../src/skills/loader';
import { getSkillsRegistry } from '../src/skills/registry';
import type { SkillDefinition } from '../src/skills/types';

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