#!/usr/bin/env node
/**
 * openhorse - Ink UI CLI Entry Point
 *
 * v0.1.13: Ink React-based terminal UI
 */

import React from 'react';
import { render } from 'ink';
import { App } from './ui/ink/components/App';

// Get version from package.json
const VERSION = require('../package.json').version;

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
render(<App model="glm-5" />);