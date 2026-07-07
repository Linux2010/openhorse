import { agentStepStatus, isLegacyTurnStatus, runningToolsStatus } from '../src/runtime/agent-status';

describe('agent status helpers', () => {
  test('uses intentful status text instead of Turn labels', () => {
    expect(agentStepStatus(1)).toBe('Working: thinking');
    expect(agentStepStatus(2)).toBe('Working: reading tool results');
    expect(agentStepStatus(8)).toBe('Working: reading tool results');
  });

  test('summarizes batched tool execution status', () => {
    expect(runningToolsStatus(1)).toBe('Working: running tool');
    expect(runningToolsStatus(4)).toBe('Working: running 4 tools');
  });

  test('recognizes legacy Turn labels for UI compatibility', () => {
    expect(isLegacyTurnStatus('Turn 2...')).toBe(true);
    expect(isLegacyTurnStatus('Working: thinking')).toBe(false);
    expect(isLegacyTurnStatus('Working: running 3 tools')).toBe(false);
  });
});
