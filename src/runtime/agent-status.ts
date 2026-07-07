export function agentStepStatus(turn: number): string {
  return turn <= 1 ? 'Working: thinking' : 'Working: reading tool results';
}

export function runningToolsStatus(count: number): string {
  return count === 1 ? 'Working: running tool' : `Working: running ${count} tools`;
}

export function isLegacyTurnStatus(message: string): boolean {
  return /^Turn\s+\d+\.\.\.$/.test(message.trim());
}
