/**
 * Turn-time skills runtime.
 *
 * The loader/registry owns discovery. This module turns a user input into the
 * active skill prompts and the tool list that should be visible for one turn.
 */

import { resolve, relative } from 'path';
import type { OpenHorseTool } from '../framework/tool';
import { getSkillsRegistry } from './registry';
import type { SkillDefinition } from './types';
import { MAX_AUTO_SKILLS } from './types';

export interface SkillRuntimeContext {
  cwd: string;
  input: string;
  tools: OpenHorseTool[];
  projectPath?: string;
  sessionId?: string;
}

export interface AppliedSkill {
  name: string;
  description: string;
  prompt: string;
  tools?: string[];
  source?: string;
  sourceType?: SkillDefinition['sourceType'];
  resourceRoot?: string;
  priority?: number;
}

export interface SkillResolution {
  skills: AppliedSkill[];
  promptInjection: string;
  tools: OpenHorseTool[];
  scopedToolNames: string[];
  toolScopeActive: boolean;
}

export function resolveSkillsForTurn(context: SkillRuntimeContext): SkillResolution {
  const registry = getSkillsRegistry();
  const matched = registry
    .findMatchingSkills(context.input)
    .slice(0, MAX_AUTO_SKILLS);
  const skills = matched.map(toAppliedSkill);
  const scopedToolNames = buildScopedToolNames(skills);
  const toolScopeActive = scopedToolNames.length > 0;
  const tools = toolScopeActive
    ? context.tools.filter(tool => scopedToolNames.includes(tool.name))
    : context.tools;

  return {
    skills,
    promptInjection: renderActiveSkillsPrompt(skills, toolScopeActive ? tools.map(tool => tool.name) : []),
    tools,
    scopedToolNames,
    toolScopeActive,
  };
}

export function hasMatchingSkill(input: string): boolean {
  return getSkillsRegistry().findMatchingSkills(input).length > 0;
}

export function resolveSkillResourcePath(skill: AppliedSkill | SkillDefinition, relativePath: string): string {
  const root = skill.resourceRoot || skill.source;
  if (!root) {
    throw new Error(`Skill ${skill.name} does not have a resource root`);
  }

  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, resolvedPath);
  if (rel.startsWith('..') || rel === '..' || resolve(rel) === rel) {
    throw new Error(`Skill resource escapes root: ${relativePath}`);
  }
  return resolvedPath;
}

function toAppliedSkill(skill: SkillDefinition): AppliedSkill {
  return {
    name: skill.name,
    description: skill.description,
    prompt: skill.prompt,
    tools: skill.tools,
    source: skill.source,
    sourceType: skill.sourceType,
    resourceRoot: skill.resourceRoot || skill.source,
    priority: skill.priority,
  };
}

function buildScopedToolNames(skills: AppliedSkill[]): string[] {
  const names = new Set<string>();
  for (const skill of skills) {
    for (const toolName of skill.tools || []) {
      names.add(toolName);
    }
  }
  return [...names];
}

function renderActiveSkillsPrompt(skills: AppliedSkill[], activeToolNames: string[]): string {
  if (skills.length === 0) return '';

  const lines: string[] = [
    '## Active Skills',
    '',
    'The following SKILL.md instructions are active for this turn. Follow them as task-specific guidance.',
    '',
  ];

  if (activeToolNames.length > 0) {
    lines.push(`Tool scope for this turn: ${activeToolNames.join(', ')}`);
    lines.push('Do not call tools outside this scoped list for this turn.');
    lines.push('');
  }

  for (const skill of skills) {
    lines.push(`### ${skill.name}`);
    lines.push(`Description: ${skill.description || '(none)'}`);
    if (skill.sourceType) lines.push(`Source type: ${skill.sourceType}`);
    if (skill.resourceRoot) {
      lines.push(`Resource root: ${skill.resourceRoot}`);
      lines.push('Resolve any relative paths mentioned by this skill from the resource root above.');
    }
    if (skill.tools?.length) lines.push(`Declared tools: ${skill.tools.join(', ')}`);
    lines.push('');
    lines.push(skill.prompt.trim());
    lines.push('');
  }

  return lines.join('\n').trim();
}
