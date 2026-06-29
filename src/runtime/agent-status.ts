export function agentStepStatus(turn: number): string {
  return turn <= 1 ? 'Thinking...' : 'Reading tool results...';
}

export function runningToolsStatus(count: number): string {
  return count === 1 ? 'Running tool...' : `Running ${count} tools...`;
}

export function isLegacyTurnStatus(message: string): boolean {
  return /^Turn\s+\d+\.\.\.$/.test(message.trim());
}
