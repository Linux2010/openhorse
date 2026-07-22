/**
 * v0.2.24 — Goal model tools unit tests.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const testDir = mkdtempSync(join(tmpdir(), 'openhorse-goal-tools-'));
const sessionsDir = join(testDir, 'sessions');
mkdirSync(sessionsDir, { recursive: true });

jest.mock('../src/services/config-dir', () => {
  const actual = jest.requireActual('../src/services/config-dir');
  return {
    ...actual,
    getProjectSessionGoalPath: (_projectPath: string, sessionId: string) =>
      join(sessionsDir, `${sessionId}.goal.json`),
  };
});

import { GoalCoordinator } from '../src/runtime/goal-coordinator';
import {
  getGoalTool,
  createGoalTool,
  updateGoalTool,
  setGoalCoordinator,
} from '../src/tools/goal';

const ctx = { cwd: process.cwd(), config: { name: 'openhorse', mode: 'development' } };

describe('Goal model tools', () => {
  let coordinator: GoalCoordinator;

  beforeEach(() => {
    coordinator = new GoalCoordinator({ idleDelayMs: 10 });
    coordinator.bind({ id: randomUUID(), projectPath: '/test/project' });
    setGoalCoordinator(coordinator);
  });

  afterEach(() => {
    coordinator.clear();
    setGoalCoordinator(null as unknown as GoalCoordinator);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('get_goal', () => {
    it('returns no-goal message when no goal is set', async () => {
      const result = await getGoalTool.execute({}, ctx);
      expect(result.success).toBe(true);
      expect(result.output).toContain('No goal');
    });

    it('returns goal details when goal exists', async () => {
      coordinator.create('Test goal');
      const result = await getGoalTool.execute({}, ctx);
      expect(result.success).toBe(true);
      expect(result.output).toContain('Test goal');
      expect(result.output).toContain('active');
    });
  });

  describe('create_goal', () => {
    it('creates a goal via tool', async () => {
      const result = await createGoalTool.execute({ objective: 'Run CI' }, ctx);
      expect(result.success).toBe(true);
      expect(result.output).toContain('Run CI');
      expect(coordinator.isActive()).toBe(true);
    });

    it('rejects empty objective', async () => {
      const result = await createGoalTool.execute({ objective: '' }, ctx);
      expect(result.success).toBe(false);
    });
  });

  describe('update_goal', () => {
    it('completes a goal with valid evidence', async () => {
      coordinator.create('Test');
      const result = await updateGoalTool.execute({
        action: 'complete',
        summary: 'All tasks done',
        requirements: [
          { requirement: 'Run tests', met: true, evidence: 'All 112 suites pass' },
          { requirement: 'Build', met: true, evidence: 'tsc zero errors' },
        ],
      }, ctx);
      expect(result.success).toBe(true);
      expect(coordinator.getState()!.status).toBe('complete');
    });

    it('rejects incomplete completion (unmet requirements)', async () => {
      coordinator.create('Test');
      const result = await updateGoalTool.execute({
        action: 'complete',
        requirements: [
          { requirement: 'Run tests', met: false, evidence: 'tests failing' },
        ],
      }, ctx);
      expect(result.success).toBe(false);
    });

    it('blocks a goal with reason', async () => {
      coordinator.create('Test');
      const result = await updateGoalTool.execute({
        action: 'block',
        reason: 'CI infrastructure is down',
      }, ctx);
      expect(result.success).toBe(true);
      expect(coordinator.getState()!.status).toBe('blocked');
    });
  });

  describe('tool metadata', () => {
    it('isReadOnly is false for create_goal', () => {
      expect(createGoalTool.isReadOnly?.({})).toBe(false);
    });
    it('isReadOnly is true for get_goal', () => {
      expect(getGoalTool.isReadOnly?.({})).toBe(true);
    });
    it('isReadOnly is false for update_goal', () => {
      expect(updateGoalTool.isReadOnly?.({})).toBe(false);
    });
  });
});