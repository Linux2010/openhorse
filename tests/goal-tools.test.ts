/**
 * v0.2.24 — Goal model tools unit tests.
 */

import { GoalCoordinator } from '../src/runtime/goals/coordinator';
import {
  buildGetGoalTool,
  buildCreateGoalTool,
  buildUpdateGoalTool,
  executeGetGoal,
  executeCreateGoal,
  executeUpdateGoal,
} from '../src/runtime/goals/tools';

describe('Goal model tools', () => {
  let coordinator: GoalCoordinator;

  beforeEach(() => {
    coordinator = new GoalCoordinator('/test/project', 'test-session');
  });

  describe('get_goal', () => {
    it('returns null when no goal exists', () => {
      const bindings = { coordinator };
      expect(executeGetGoal(bindings)).toBeNull();
    });

    it('returns goal snapshot when goal exists', () => {
      coordinator.create('test objective');
      const bindings = { coordinator };
      const snap = executeGetGoal(bindings);
      expect(snap).not.toBeNull();
      expect(snap!.objective).toBe('test objective');
    });

    it('has tool definition with correct name', () => {
      const tool = buildGetGoalTool();
      expect(tool.name).toBe('get_goal');
    });
  });

  describe('create_goal', () => {
    it('creates a goal from explicit objective', () => {
      const bindings = { coordinator };
      const result = executeCreateGoal(bindings, 'Run CI');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.goal.objective).toBe('Run CI');
    });

    it('rejects empty objective', () => {
      coordinator.create = () => ({ ok: false as const, error: 'Objective cannot be empty.' });
      const bindings = { coordinator };
      const result = executeCreateGoal(bindings, '');
      expect(result.ok).toBe(false);
    });

    it('rejects duplicate goal if active', () => {
      coordinator.create('first goal');
      const bindings = { coordinator };
      const result = executeCreateGoal(bindings, 'second goal');
      expect(result.ok).toBe(false);
    });

    it('has tool definition', () => {
      const tool = buildCreateGoalTool();
      expect(tool.name).toBe('create_goal');
    });
  });

  describe('update_goal', () => {
    it('requests complete status on active goal', () => {
      coordinator.create('test');
      const bindings = { coordinator };
      const result = executeUpdateGoal(bindings, 'complete');
      expect(result.ok).toBe(true);
    });

    it('requests blocked status', () => {
      coordinator.create('test');
      const bindings = { coordinator };
      const result = executeUpdateGoal(bindings, 'blocked');
      expect(result.ok).toBe(true);
    });

    it('rejects update when no goal exists', () => {
      const bindings = { coordinator };
      const result = executeUpdateGoal(bindings, 'complete');
      expect(result.ok).toBe(false);
    });

    it('has tool definition', () => {
      const tool = buildUpdateGoalTool();
      expect(tool.name).toBe('update_goal');
    });
  });
});