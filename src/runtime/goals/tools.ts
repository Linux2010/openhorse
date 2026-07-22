/**
 * v0.2.24 — Goal Model Tools.
 *
 * get_goal, create_goal, update_goal tool definitions for the Agent.
 * These tools allow the model to read and request changes to the
 * persistent goal. Actual state changes go through GoalCoordinator.
 */

import type { RuntimeGoalSnapshot } from './types';
import type { GoalCoordinator } from './coordinator';

export interface GoalToolBindings {
  coordinator: GoalCoordinator;
}

export function buildGetGoalTool(): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    name: 'get_goal',
    description: 'Read the current persistent goal for this session. Returns null if no goal is active.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  };
}

export function executeGetGoal(bindings: GoalToolBindings): RuntimeGoalSnapshot | null {
  return bindings.coordinator.snapshot();
}

export function buildCreateGoalTool(): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    name: 'create_goal',
    description: 'Create a persistent goal for this session. Only use when the user explicitly requests a long-running goal. Rejects if a goal already exists.',
    parameters: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description: 'The goal objective. Must be clear, specific, and verifiable.',
        },
        token_budget: {
          type: 'number',
          description: 'Optional token budget. Only set when the user explicitly provides a budget.',
        },
      },
      required: ['objective'],
    },
  };
}

export function executeCreateGoal(
  bindings: GoalToolBindings,
  objective: string,
  tokenBudget?: number,
): { ok: true; goal: RuntimeGoalSnapshot } | { ok: false; error: string } {
  const result = bindings.coordinator.create(objective);
  if (!result.ok) return { ok: false, error: result.error };

  if (tokenBudget && tokenBudget > 0) {
    bindings.coordinator.setBudget(tokenBudget);
  }

  const snap = bindings.coordinator.snapshot();
  return snap ? { ok: true, goal: snap } : { ok: false, error: 'Goal was created but snapshot is unavailable.' };
}

export function buildUpdateGoalTool(): {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  return {
    name: 'update_goal',
    description: 'Request a status change for the current goal. The request is audited before the change takes effect.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['complete', 'blocked'],
          description: 'The requested target status: "complete" when all requirements are verified; "blocked" when the same blocker persisted for 3+ turns.',
        },
      },
      required: ['status'],
    },
  };
}

export function executeUpdateGoal(
  bindings: GoalToolBindings,
  status: 'complete' | 'blocked',
): { ok: true; message: string } | { ok: false; error: string } {
  const goal = bindings.coordinator.goal;
  if (!goal) return { ok: false, error: 'No active goal to update.' };
  if (goal.status !== 'active') return { ok: false, error: `Goal is not active (current status: ${goal.status}).` };

  return {
    ok: true,
    message: `Goal ${status} request recorded. Audit will verify before applying.`,
  };
}