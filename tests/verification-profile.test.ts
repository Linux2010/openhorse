import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  collectVerificationCommandResult,
  formatVerificationGateNotice,
  selectVerificationProfile,
  shouldGateCompletion,
  summarizeVerificationState,
} from '../src/services/verification-profile';

describe('verification-profile', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openhorse-verification-profile-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('selects npm checks for Node and TypeScript changes', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: {
        build: 'tsc',
        test: 'jest',
        lint: 'eslint src/',
      },
    }), 'utf8');

    const profile = selectVerificationProfile(root, ['src/index.ts', 'tests/index.test.ts']);

    expect(profile).toMatchObject({
      profile: 'node',
      required: true,
      commands: ['npm run build', 'npm test -- --runInBand', 'npm run lint'],
    });
  });

  it('does not require commands for documentation-only changes', () => {
    const profile = selectVerificationProfile(root, ['docs/targets/agent-loop-final-form.md']);

    expect(profile).toMatchObject({
      profile: 'docs',
      required: false,
      commands: [],
    });
  });

  it('selects Python checks for pyproject based changes', () => {
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
    mkdirSync(join(root, 'src'), { recursive: true });

    const profile = selectVerificationProfile(root, ['src/app.py']);

    expect(profile).toMatchObject({
      profile: 'python',
      required: true,
      commands: ['uv run pytest', 'uv run ruff check .'],
    });
  });

  it('collects verification command results from exec_command calls only', () => {
    expect(collectVerificationCommandResult({
      toolName: 'exec_command',
      args: { command: 'npm run build' },
      success: true,
      outputBytes: 123,
    })).toEqual({
      command: 'npm run build',
      success: true,
      outputBytes: 123,
    });

    expect(collectVerificationCommandResult({
      toolName: 'exec_command',
      args: { command: 'echo hello' },
      success: true,
    })).toBeNull();
    expect(collectVerificationCommandResult({
      toolName: 'read_file',
      args: { path: 'package.json' },
      success: true,
    })).toBeNull();

    expect(collectVerificationCommandResult({
      toolName: 'exec_command',
      args: { command: 'npm run prepublishOnly' },
      success: true,
    })).toMatchObject({
      command: 'npm run prepublishOnly',
      success: true,
    });
  });

  it('summarizes whether expected verification has passed', () => {
    const profile = {
      profile: 'node' as const,
      required: true,
      commands: ['npm run build', 'npm test -- --runInBand'],
      changedFiles: ['src/index.ts'],
      reason: 'Node changes',
    };

    expect(summarizeVerificationState(profile, [
      { command: 'npm run build', success: true },
    ])).toMatchObject({
      claimAllowed: false,
      passedCommands: ['npm run build'],
      missingCommands: ['npm test -- --runInBand'],
    });

    expect(summarizeVerificationState(profile, [
      { command: 'npm run build', success: true },
      { command: 'npm test -- --runInBand', success: true },
    ])).toMatchObject({
      claimAllowed: true,
      missingCommands: [],
      failedCommands: [],
    });

    expect(summarizeVerificationState(profile, [
      { command: 'npm run build', success: true },
      { command: 'npm test -- --runInBand', success: false, error: 'failed' },
    ])).toMatchObject({
      claimAllowed: false,
      failedCommands: ['npm test -- --runInBand'],
      missingCommands: ['npm test -- --runInBand'],
    });
  });

  it('treats broad equivalent Node verification commands as satisfying inferred checks', () => {
    const profile = {
      profile: 'node' as const,
      required: true,
      commands: ['npm run build', 'npm test -- --runInBand'],
      changedFiles: ['src/index.ts'],
      reason: 'Node changes',
    };

    expect(summarizeVerificationState(profile, [
      { command: 'npm run build', success: true },
      { command: 'npm test', success: true },
    ])).toMatchObject({
      claimAllowed: true,
      missingCommands: [],
    });

    expect(summarizeVerificationState(profile, [
      { command: 'npm run prepublishOnly', success: true },
    ])).toMatchObject({
      claimAllowed: true,
      missingCommands: [],
    });
  });

  it('formats a completion gate notice for incomplete verification', () => {
    const summary = {
      profile: 'node' as const,
      required: true,
      commandsRun: ['npm run build'],
      passedCommands: ['npm run build'],
      failedCommands: [],
      missingCommands: ['npm test -- --runInBand'],
      claimAllowed: false,
      skippedReason: 'Some expected verification commands have not passed yet.',
    };

    expect(shouldGateCompletion(summary)).toBe(true);
    expect(formatVerificationGateNotice(summary)).toContain('[OpenHorse Verification Gate]');
    expect(formatVerificationGateNotice(summary)).toContain('Missing checks:');
    expect(formatVerificationGateNotice(summary)).toContain('- npm test -- --runInBand');
  });
});
