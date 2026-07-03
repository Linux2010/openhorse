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
  const explicit = findExplicitSkillReferences(context.input, registry.getAllSkills());
  const matched = mergeSkillsByName([
    ...explicit,
    ...registry.findMatchingSkills(context.input),
  ]).slice(0, MAX_AUTO_SKILLS);
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
  const registry = getSkillsRegistry();
  return registry.findMatchingSkills(input).length > 0
    || findExplicitSkillReferences(input, registry.getAllSkills()).length > 0;
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

export function normalizeRequestedSkillName(input: string): string {
  return input
    .trim()
    .replace(/^[/@#]+/u, '')
    .replace(/^skill:/iu, '')
    .replace(/[:：,，.。;；!！?？]+$/u, '')
    .toLowerCase();
}

export function parseSkillCommandInput(input: string): { skillName?: string; task: string } {
  const trimmed = input.trim();
  const match = trimmed.match(/^\/(?:skill|use-skill|activate-skill)\s+(\S+)(?:\s+([\s\S]*))?$/iu);
  if (!match) return { task: input };
  return {
    skillName: normalizeRequestedSkillName(match[1]),
    task: (match[2] || '').trim(),
  };
}

function findExplicitSkillReferences(input: string, skills: SkillDefinition[]): SkillDefinition[] {
  const command = parseSkillCommandInput(input);
  if (command.skillName) {
    return skills.filter(skill => skillActivationNames(skill)
      .some(name => normalizeRequestedSkillName(name) === command.skillName));
  }

  return skills.filter(skill => skillActivationNames(skill)
    .some(name => isSkillExplicitlyRequested(input, name)));
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

export function skillActivationNames(skill: Pick<SkillDefinition, 'name' | 'aliases' | 'tags'>): string[] {
  const names = new Set<string>();
  names.add(skill.name);
  for (const alias of skill.aliases || []) {
    if (alias.trim()) names.add(alias.trim());
  }

  const tags = new Set((skill.tags || []).map(tag => tag.toLowerCase()));
  const name = skill.name.toLowerCase();
  const isTeamWorkflow = name.includes('squad')
    || name.includes('team')
    || (tags.has('agent-workflow') && (tags.has('coding') || name.includes('coding')));
  if (isTeamWorkflow) {
    for (const alias of ['团队开发', '编程小队', '开发小队', '团队协作', '协同开发', '工作团队', '团队工作']) {
      names.add(alias);
    }
  }

  return [...names];
}

function mergeSkillsByName(skills: SkillDefinition[]): SkillDefinition[] {
  const seen = new Set<string>();
  const merged: SkillDefinition[] = [];
  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    merged.push(skill);
  }
  return merged;
}

function isSkillExplicitlyRequested(input: string, skillName: string): boolean {
  const escapedName = escapeRegExp(skillName);
  const englishActivator = '(?:use|using|with|apply|activate|load|run)';
  const englishSkillNoun = '(?:skill|workflow|agent)';
  const leftBoundary = '(?:^|[\\s"\'`“”‘’/([{:：])';
  const rightBoundary = '(?=$|[\\s"\'`“”‘’.,;:!?，。；：！？)\\]}])';

  const patterns = [
    new RegExp(`^/${escapedName}${rightBoundary}`, 'iu'),
    new RegExp(`${leftBoundary}${englishActivator}\\s+(?:the\\s+)?(?:${englishSkillNoun}\\s+)?${escapedName}${rightBoundary}`, 'iu'),
    new RegExp(`${leftBoundary}${englishActivator}\\s+${escapedName}\\s+(?:${englishSkillNoun})${rightBoundary}`, 'iu'),
    new RegExp(`${leftBoundary}(?:skill|skills?)\\s*[:：]\\s*${escapedName}${rightBoundary}`, 'iu'),
    new RegExp(`${leftBoundary}${escapedName}\\s+(?:skill|workflow|agent)${rightBoundary}`, 'iu'),
    new RegExp(`(?:使用|用|调用|加载|启用|按|基于|采用)\\s*${escapedName}${rightBoundary}`, 'iu'),
    new RegExp(`${leftBoundary}${escapedName}\\s*(?:技能|工作流|智能体|agent|skill)`, 'iu'),
  ];

  return patterns.some(pattern => pattern.test(input));
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
