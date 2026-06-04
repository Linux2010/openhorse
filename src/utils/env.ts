/**
 * openhorse - Environment utility (simplified stub)
 *
 * Provides terminal detection and environment info.
 * Simplified from OpenClaude's version to avoid deep dependency chains.
 */

export interface EnvInfo {
  terminal: string | undefined;
  termProgram: string | undefined;
  isTmux: boolean;
  isSsh: boolean;
  homeDir: string;
  nodeVersion: string;
  platform: string;
}

function detectTerminal(): string | undefined {
  if (process.env.TERM?.includes('kitty') || process.env.KITTY_WINDOW_ID) return 'kitty';
  if (process.env.TERM_PROGRAM === 'ghostty') return 'ghostty';
  if (process.env.TERM_PROGRAM === 'iTerm.App') return 'iterm2';
  if (process.env.TERM_PROGRAM === 'vscode') return 'xtermjs';
  if (process.env.WT_SESSION) return 'windows-terminal';
  if (process.env.TMUX) return 'tmux';
  return process.env.TERM;
}

const _env: EnvInfo = {
  terminal: detectTerminal(),
  termProgram: process.env.TERM_PROGRAM,
  isTmux: !!process.env.TMUX,
  isSsh: !!process.env.SSH_CONNECTION,
  homeDir: process.env.HOME || '',
  nodeVersion: process.version,
  platform: process.platform,
};

export { _env as env };
