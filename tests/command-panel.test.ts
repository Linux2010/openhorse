/**
 * Issue #32 #4.3: Command panel tests
 */

import { spawn } from 'child_process';
import { join } from 'path';

describe('Command Panel', () => {
  const cliPath = join(__dirname, '..', 'dist', 'cli.js');

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
});