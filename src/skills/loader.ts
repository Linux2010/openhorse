/**
 * openhorse - Skills Loader
 *
 * 扫描并加载 Skills 目录中的技能定义
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { load as loadYaml } from 'js-yaml';
import {
  type SkillDefinition,
  type SkillSource,
  SKILL_FILE_NAME,
  SKILLS_DIR_NAMES,
  DEFAULT_SKILL_PRIORITY,
} from './types';
import { getConfigHome } from '../services/config-dir';

// ============================================================================
// Skill Parser
// ============================================================================

/**
 * Parse SKILL.md file
 * Format: Markdown with YAML frontmatter
 */
export function parseSkillFile(content: string, sourcePath: string): SkillDefinition | null {
  try {
    // Extract frontmatter (between --- lines)
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

    if (!frontmatterMatch) {
      console.warn(`[SkillsLoader] No frontmatter in ${sourcePath}`);
      return null;
    }

    const frontmatter = loadYaml(frontmatterMatch[1]) as Record<string, any>;

    // Extract prompt (content after frontmatter)
    const promptMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
    const prompt = promptMatch ? promptMatch[1].trim() : '';

    // Build skill definition
    const skill: SkillDefinition = {
      name: frontmatter.name || basename(sourcePath).replace(/\.md$/, ''),
      description: frontmatter.description || '',
      trigger: frontmatter.trigger,
      prompt,
      tools: frontmatter.tools,
      auto: frontmatter.auto ?? false,
      priority: frontmatter.priority ?? DEFAULT_SKILL_PRIORITY,
      source: sourcePath,
      tags: frontmatter.tags || [],
    };

    return skill;
  } catch (err: any) {
    console.warn(`[SkillsLoader] Failed to parse ${sourcePath}: ${err.message}`);
    return null;
  }
}

// ============================================================================
// Directory Scanner
// ============================================================================

/**
 * Scan a directory for skills
 */
export function scanSkillsDirectory(dirPath: string, type: 'user' | 'project' | 'builtin'): SkillDefinition[] {
  if (!existsSync(dirPath)) {
    return [];
  }

  const skills: SkillDefinition[] = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = join(dirPath, entry.name);
      const skillFile = join(skillDir, SKILL_FILE_NAME);

      if (!existsSync(skillFile)) {
        // No SKILL.md, skip
        continue;
      }

      const content = readFileSync(skillFile, 'utf-8');
      const skill = parseSkillFile(content, skillFile);

      if (skill) {
        skill.source = skillDir;
        skills.push(skill);
      }
    }
  } catch (err: any) {
    console.warn(`[SkillsLoader] Failed to scan ${dirPath}: ${err.message}`);
  }

  return skills;
}

// ============================================================================
// Skills Loader
// ============================================================================

export class SkillsLoader {
  /** Loaded skills */
  private skills: Map<string, SkillDefinition> = new Map();

  /** Skill sources */
  private sources: Map<string, SkillSource> = new Map();

  /** Auto-trigger skills */
  private autoSkills: SkillDefinition[] = [];

  /** Last scan time */
  private lastScan: number = 0;

  /** Load all skills from configured directories */
  load(): SkillDefinition[] {
    this.clear();

    // 1. Load builtin skills (src/skills/builtin/)
    try {
      // Builtin skills are packaged with the application
      const builtinSkillsDir = join(__dirname, SKILLS_DIR_NAMES.BUILTIN);
      const builtinSkills = scanSkillsDirectory(builtinSkillsDir, 'builtin');
      for (const skill of builtinSkills) {
        this.registerSkill(skill, { path: builtinSkillsDir, type: 'builtin' });
      }
    } catch {
      // Builtin directory may not exist in some environments
    }

    // 2. Load user skills (~/.openhorse/skills/)
    const userSkillsDir = join(getConfigHome(), SKILLS_DIR_NAMES.USER);
    const userSkills = scanSkillsDirectory(userSkillsDir, 'user');
    for (const skill of userSkills) {
      this.registerSkill(skill, { path: userSkillsDir, type: 'user' });
    }

    // 3. Load project skills (.openhorse/skills/)
    const projectSkillsDir = join(process.cwd(), SKILLS_DIR_NAMES.PROJECT);
    const projectSkills = scanSkillsDirectory(projectSkillsDir, 'project');
    for (const skill of projectSkills) {
      // Project skills override user/builtin skills with same name
      this.registerSkill(skill, { path: projectSkillsDir, type: 'project' });
    }

    this.autoSkills = Array.from(this.skills.values()).filter(skill => !!skill.auto);
    this.lastScan = Date.now();
    return this.getSkills();
  }

  /** Register a skill */
  private registerSkill(skill: SkillDefinition, source: SkillSource): void {
    const preparedSkill: SkillDefinition = {
      ...skill,
      sourceType: source.type,
      resourceRoot: skill.source,
    };

    // Check for conflicts
    const existing = this.skills.get(preparedSkill.name);
    if (existing) {
      const existingSource = this.sources.get(preparedSkill.name);
      const existingRank = sourceRank(existingSource?.type);
      const incomingRank = sourceRank(source.type);
      const shouldOverride = incomingRank > existingRank
        || (incomingRank === existingRank && (preparedSkill.priority || DEFAULT_SKILL_PRIORITY) > (existing.priority || DEFAULT_SKILL_PRIORITY));

      if (shouldOverride) {
        this.skills.set(preparedSkill.name, preparedSkill);
        this.sources.set(preparedSkill.name, source);
      }
    } else {
      this.skills.set(preparedSkill.name, preparedSkill);
      this.sources.set(preparedSkill.name, source);
    }

    // Track auto-trigger skills
    if (preparedSkill.auto && this.skills.get(preparedSkill.name) === preparedSkill) {
      this.autoSkills.push(preparedSkill);
    }
  }

  /** Get all loaded skills */
  getSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /** Get skill by name */
  getSkill(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  /** Get auto-trigger skills */
  getAutoSkills(): SkillDefinition[] {
    return this.autoSkills;
  }

  /** Get skill source */
  getSource(name: string): SkillSource | undefined {
    return this.sources.get(name);
  }

  /** Check if skill should trigger */
  shouldTrigger(skill: SkillDefinition, input: string): boolean {
    if (!skill.trigger) return false;

    if (typeof skill.trigger === 'string') {
      return input.includes(skill.trigger) || input.startsWith(skill.trigger);
    }

    if (skill.trigger instanceof RegExp) {
      return skill.trigger.test(input);
    }

    // Trigger function
    return skill.trigger(input, { cwd: process.cwd(), input, tools: [] });
  }

  /** Find skills that match input */
  findMatchingSkills(input: string): SkillDefinition[] {
    const matches: SkillDefinition[] = [];

    for (const skill of this.skills.values()) {
      if (this.shouldTrigger(skill, input)) {
        matches.push(skill);
      }
    }

    // Sort by priority (higher first)
    matches.sort((a, b) => (b.priority || 50) - (a.priority || 50));

    return matches;
  }

  /** Clear loaded skills */
  clear(): void {
    this.skills.clear();
    this.sources.clear();
    this.autoSkills = [];
    this.lastScan = 0;
  }

  /** Get last scan time */
  getLastScan(): number {
    return this.lastScan;
  }
}

function sourceRank(type?: SkillSource['type']): number {
  switch (type) {
    case 'project':
      return 3;
    case 'user':
      return 2;
    case 'builtin':
      return 1;
    default:
      return 0;
  }
}

// ============================================================================
// Factory
// ============================================================================

let defaultLoader: SkillsLoader | null = null;

export function getSkillsLoader(): SkillsLoader {
  if (!defaultLoader) {
    defaultLoader = new SkillsLoader();
    defaultLoader.load();
  }
  return defaultLoader;
}

export function resetSkillsLoader(): void {
  if (defaultLoader) {
    defaultLoader.clear();
  }
  defaultLoader = null;
}
