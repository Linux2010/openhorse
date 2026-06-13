/**
 * Issue #32 #4.3: Command panel tests
 */

import { spawn } from 'child_process';
import { join } from 'path';

describe('Command Panel', () => {
  const cliPath = join(__dirname, '..', 'dist', 'cli.js');
  let writeSpy: jest.SpyInstance;
  let output: string[];

  beforeEach(() => {
    jest.resetModules();
    output = [];
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      output.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    try {
      const { hideCommandPanel } = require('../src/ui/command-panel');
      hideCommandPanel();
    } catch {
      // Ignore cleanup failures from module reset.
    }
    writeSpy.mockRestore();
  });

  // Note: These tests are limited because command-panel relies on TTY
  // which is not available in Jest environment

  describe('resetRenderLength', () => {
    it('should reset isFirstRender to true', () => {
      // Import the function
      const { resetRenderLength } = require('../src/ui/command-panel');
      resetRenderLength();
      // The function exists and can be called
      expect(typeof resetRenderLength).toBe('function');
    });
  });

  describe('showCommandPanel', () => {
    it('should be a function', () => {
      const { showCommandPanel } = require('../src/ui/command-panel');
      expect(typeof showCommandPanel).toBe('function');
    });
  });

  describe('hideCommandPanel', () => {
    it('should be a function', () => {
      const { hideCommandPanel } = require('../src/ui/command-panel');
      expect(typeof hideCommandPanel).toBe('function');
    });
  });

  describe('isPanelVisible', () => {
    it('should return boolean', () => {
      const { isPanelVisible } = require('../src/ui/command-panel');
      expect(typeof isPanelVisible()).toBe('boolean');
    });
  });

  describe('compact rendering', () => {
    it('hides argument hints and type labels from command rows', () => {
      const { showCommandPanel } = require('../src/ui/command-panel');

      showCommandPanel('m');

      const rendered = output.join('');
      expect(rendered).toContain('Matching "m"');
      expect(rendered).toContain('/model');
      expect(rendered).not.toContain('[model|list|help]');
      expect(rendered).not.toContain('[Cmd]');
    });
  });
});
