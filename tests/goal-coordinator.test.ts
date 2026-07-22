/**
 * v0.2.24 — GoalCoordinator unit tests.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const testDir = mkdtempSync(join(tmpdir(), 'openhorse-goal-coordinator-'));
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

const session = { id: randomUUID(), projectPath: '/test/project' };

describe('GoalCoordinator', () => {
  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  let coordinator: GoalCoordinator;
  let sessionId: string;

  beforeEach(() => {
    sessionId = randomUUID();
    coordinator = new GoalCoordinator({ idleDelayMs: 10, backoffMs: 20 });
    coordinator.bind({ id: sessionId, projectPath: '/test/project' });
  });

  afterEach(() => {
    coordinator.clear();
    coordinator.removeAllListeners();
  });

  describe('create', () => {
    it('creates a goal in active state', () => {
      const g = coordinator.create('Fix all tests');
      expect(g.status).toBe('active');
      expect(g.objective).toBe('Fix all tests');
      expect(coordinator.isActive()).toBe(true);
    });

    it('rejects duplicate active goals', () => {
      coordinator.create('First goal');
      expect(() => coordinator.create('Second goal')).toThrow(/already active/);
    });

    it('allows new goal after clearing', () => {
      coordinator.create('First');
      coordinator.clear();
      const g = coordinator.create('Second');
      expect(g.objective).toBe('Second');
    });
  });

  describe('pause / resume', () => {
    it('pauses and resumes a goal', () => {
      coordinator.create('test');
      coordinator.pause();
      expect(coordinator.getState()!.status).toBe('paused');
      coordinator.resume();
      expect(coordinator.isActive()).toBe(true);
    });
  });

  describe('complete', () => {
    it('marks complete with evidence', () => {
      coordinator.create('test');
      coordinator.markComplete({
        requirements: [{ requirement: 'r1', met: true, evidence: 'pass' }],
        summary: 'done',
        proposedAt: Date.now(),
      });
      expect(coordinator.getState()!.status).toBe('complete');
      expect(coordinator.isActive()).toBe(false);
    });
  });

  describe('accounting', () => {
    it('accumulates usage on turn complete', () => {
      coordinator.create('test');
      coordinator.onTurnStart();
      coordinator.onTurnComplete({ promptTokens: 100, completionTokens: 50, cost: 0.001 }, 5000);
      const g = coordinator.getState()!;
      expect(g.accounting.promptTokens).toBe(100);
      expect(g.accounting.turnCount).toBe(1);
    });
  });

  describe('clear', () => {
    it('clears the goal', () => {
      coordinator.create('test');
      coordinator.clear();
      expect(coordinator.getState()).toBeNull();
    });
  });

  describe('events', () => {
    it('emits goal_created on create', done => {
      coordinator.once('goal_created', e => {
        expect(e.type).toBe('goal_created');
        done();
      });
      coordinator.create('test');
    });

    it('emits goal_status_changed on pause', done => {
      coordinator.create('test');
      coordinator.once('goal_status_changed', e => {
        expect(e.status).toBe('paused');
        done();
      });
      coordinator.pause();
    });

    it('does not emit continuation when paused', done => {
      coordinator.create('test');
      coordinator.pause();
      coordinator.on('goal_continuation_scheduled', () => {
        done(new Error('Should not schedule continuation when paused'));
      });
      coordinator.onTurnComplete({ promptTokens: 10, completionTokens: 5, cost: 0 }, 100);
      setTimeout(() => done(), 50);
    });
  });
});