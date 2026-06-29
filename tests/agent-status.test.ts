import { agentStepStatus, isLegacyTurnStatus, runningToolsStatus } from '../src/runtime/agent-status';

describe('agent status helpers', () => {
  test('uses intentful status text instead of Turn labels', () => {
    expect(agentStepStatus(1)).toBe('Thinking...');
    expect(agentStepStatus(2)).toBe('Reading tool results...');
    expect(agentStepStatus(8)).toBe('Reading tool results...');
  });

  test('summarizes batched tool execution status', () => {
    expect(runningToolsStatus(1)).toBe('Running tool...');
    expect(runningToolsStatus(4)).toBe('Running 4 tools...');
  });

  test('recognizes legacy Turn labels for UI compatibility', () => {
    expect(isLegacyTurnStatus('Turn 2...')).toBe(true);
    expect(isLegacyTurnStatus('Thinking...')).toBe(false);
    expect(isLegacyTurnStatus('Running 3 tools...')).toBe(false);
  });
});
