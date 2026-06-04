#!/usr/bin/env node
/**
 * openhorse - Ink UI CLI Entry Point
 *
 * v0.1.13: Uses OpenClaude's custom Ink render engine
 * (not npm `ink`) for proper terminal input handling.
 */

import React from 'react';
import render from './ink/root.js';
import { App } from './ui/ink/components/App.js';

const VERSION = '0.1.13';

// Parse command line arguments
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
openhorse v${VERSION}
  Universal Agent Harness Framework

Usage:
  openhorse              Start interactive REPL
  openhorse --help       Show this help message
  openhorse --version    Show version
`);
  process.exit(0);
}
if (args.includes('--version') || args.includes('-v')) {
  console.log(`openhorse v${VERSION}`);
  process.exit(0);
}

// Render Ink App
const instance = await render(<App model="glm-5" />);

// Handle process exit
process.on('SIGINT', () => {
  instance.unmount();
  process.exit(0);
});
