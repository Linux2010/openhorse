import { randomUUID } from 'crypto';
import type { TaskContract } from './types';

const MAX_LINE = 180;

function truncate(text: string, max = MAX_LINE): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? trimmed.slice(0, max - 3) + '...' : trimmed;
}

function splitMeaningfulLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map(line => line.replace(/^[-*+\d.)\s]+/, '').trim())
    .filter(Boolean);
}

function unique(items: string[]): string[] {
  return [...new Set(items.map(item => truncate(item)).filter(Boolean))];
}

export function createTaskContract(input: string, cwd: string): TaskContract {
  const now = Date.now();
  const lines = splitMeaningfulLines(input);
  const objective = truncate(lines[0] || input || 'Continue the current task');

  const requirementHints = /(must|should|required|require|need|ensure|verify|test|build|run|希望|需要|必须|要求|确保|验证|测试|完成)/i;
  const prohibitionHints = /(do not|don't|never|avoid|without|禁止|不要|不能|不准|避免)/i;
  const verificationHints = /(test|build|tsc|lint|verify|验证|测试|通过|运行|检查)/i;

  const requirements = unique(lines.filter(line => requirementHints.test(line)));
  const prohibitions = unique(lines.filter(line => prohibitionHints.test(line)));
  const successCriteria = unique([
    ...lines.filter(line => verificationHints.test(line)),
    requirements.length === 0 ? `Address the objective: ${objective}` : '',
  ]);

  return {
    id: randomUUID(),
    objective,
    userIntent: input.trim(),
    requirements,
    successCriteria,
    constraints: [],
    prohibitions,
    allowedScope: { cwd },
    createdAt: now,
    updatedAt: now,
  };
}

export function updateTaskContract(
  previous: TaskContract | undefined,
  input: string,
  cwd: string,
): TaskContract {
  if (!previous) {
    return createTaskContract(input, cwd);
  }

  const next = createTaskContract(input, cwd);
  return {
    ...previous,
    objective: next.objective,
    userIntent: input.trim(),
    requirements: unique([...previous.requirements, ...next.requirements]),
    successCriteria: unique([...previous.successCriteria, ...next.successCriteria]),
    prohibitions: unique([...previous.prohibitions, ...next.prohibitions]),
    allowedScope: { ...previous.allowedScope, cwd },
    updatedAt: Date.now(),
  };
}

