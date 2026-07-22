/**
 * v0.2.24 — Goal sidecar unit tests.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

// Mock the config-dir path before importing the sidecar module
const testDir = mkdtempSync(join(tmpdir(), 'openhorse-goal-sidecar-'));
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

import {
  createGoalSidecar,
  loadGoalSidecar,
  saveGoalSidecar,
  transitionGoalStatus,
  accumulateGoalUsage,
  isGoalOverBudget,
  shouldMarkBlocked,
  type GoalSidecarV1,
} from '../src/services/goal-sidecar';

const session = { id: randomUUID(), projectPath: '/test/project' };

describe('GoalSidecar', () => {
  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('create + save + load', () => {
    it('creates a new active goal', () => {
      const g = createGoalSidecar('goal-1', session, 'Fix all tests', null);
      expect(g.status).toBe('active');
      expect(g.objective).toBe('Fix all tests');
      expect(g.revision).toBe(1);
      expect(g.accounting.turnCount).toBe(0);
    });

    it('persists and reloads round-trip', () => {
      const g = createGoalSidecar('goal-2', session, 'Run full CI', 50000);
      saveGoalSidecar(g);
      const loaded = loadGoalSidecar(session);
      expect(loaded).not.toBeNull();
      expect(loaded!.goalId).toBe('goal-2');
      expect(loaded!.objective).toBe('Run full CI');
      expect(loaded!.tokenBudget).toBe(50000);
      expect(loaded!.revision).toBe(2); // incremented on save
    });

    it('returns null for missing sidecar', () => {
      const ghost = { id: 'nonexistent', projectPath: '/nowhere' };
      expect(loadGoalSidecar(ghost)).toBeNull();
    });

    it('returns null for corrupt sidecar', () => {
      const corruptPath = join(sessionsDir, `${session.id}.goal.json`);
      writeFileSync(corruptPath, '{not json', 'utf-8');
      const bad = { id: session.id, projectPath: session.projectPath };
      expect(loadGoalSidecar(bad)).toBeNull();
    });
  });

  describe('status transitions', () => {
    it('transitions active -> paused -> active', () => {
      const g = createGoalSidecar('goal-3', session, 'test');
      expect(g.status).toBe('active');
      transitionGoalStatus(g, 'paused');
      expect(g.status).toBe('paused');
      transitionGoalStatus(g, 'active');
      expect(g.status).toBe('active');
    });

    it('transitions to blocked with metadata', () => {
      const g = createGoalSidecar('goal-4', session, 'test');
      transitionGoalStatus(g, 'blocked', {
        blocked: { reason: 'CI down', consecutiveTurns: 3 },
      });
      expect(g.status).toBe('blocked');
      expect(g.blocked?.reason).toBe('CI down');
    });

    it('transitions to complete with evidence', () => {
      const g = createGoalSidecar('goal-5', session, 'test');
      transitionGoalStatus(g, 'complete', {
        completion: {
          requirements: [{ requirement: 'r1', met: true, evidence: 'pass' }],
          summary: 'All done',
          proposedAt: Date.now(),
        },
      });
      expect(g.status).toBe('complete');
      expect(g.completion?.summary).toBe('All done');
    });
  });

  describe('accounting', () => {
    it('accumulates usage across turns', () => {
      const g = createGoalSidecar('goal-6', session, 'test');
      accumulateGoalUsage(g, { promptTokens: 100, completionTokens: 50, cost: 0.001 }, 5000);
      expect(g.accounting.promptTokens).toBe(100);
      expect(g.accounting.turnCount).toBe(1);
      expect(g.accounting.elapsedMs).toBe(5000);

      accumulateGoalUsage(g, { promptTokens: 200, completionTokens: 100, cost: 0.002 }, 3000);
      expect(g.accounting.promptTokens).toBe(300);
      expect(g.accounting.turnCount).toBe(2);
      expect(g.accounting.elapsedMs).toBe(8000);
    });
  });

  describe('budget', () => {
    it('is not over budget when limit is null', () => {
      const g = createGoalSidecar('goal-7', session, 'test', null);
      g.accounting.cost = 9999;
      expect(isGoalOverBudget(g)).toBe(false);
    });

    it('is over budget when cost >= limit', () => {
      const g = createGoalSidecar('goal-8', session, 'test', 5);
      g.accounting.cost = 5;
      expect(isGoalOverBudget(g)).toBe(true);
    });
  });

  describe('blocking detection', () => {
    it('marks blocked after 3 consecutive same reasons', () => {
      const g = createGoalSidecar('goal-9', session, 'test');
      g.lastContinueReason = 'EACCES';
      g.blocked = { reason: 'EACCES', consecutiveTurns: 2 };
      expect(shouldMarkBlocked(g, 'EACCES')).toBe(true);
    });

    it('does not mark blocked on first occurrence', () => {
      const g = createGoalSidecar('goal-10', session, 'test');
      expect(shouldMarkBlocked(g, 'ENOENT')).toBe(false);
    });
  });
});