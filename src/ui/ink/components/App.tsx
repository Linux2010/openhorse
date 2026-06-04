/**
 * openhorse v0.1.13 - Ink UI App
 *
 * Architecture mirrors OpenClaude's REPL:
 * - Multi-line input with cursor position (Shift+Enter for newline)
 * - Separate streamingText state for streaming preview
 * - Border above input area like Claude Code's prompt border
 * - Status bar at bottom with separator line
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Box from '../../../ink/components/Box.js';
import Text from '../../../ink/components/Text.js';
import useApp from '../../../ink/hooks/use-app.js';
import useInput from '../../../ink/hooks/use-input.js';
import type { InputEvent, Key } from '../../../ink/events/input-event.js';
import { StatusBar } from './StatusBar.js';
import { CommandPanel, DEFAULT_COMMANDS } from './CommandPanel.js';
import { LLMService } from '../../../services/llm.js';
import { loadConfig } from '../../../services/config.js';

export interface AppProps {
  model?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'error';
  content: string;
}

// Calculate cursor position in multi-line text
function getCursorInfo(text: string, cursorOffset: number) {
  const lines = text.split('\n');
  let lineStart = 0;
  let currentLine = 0;
  let currentCol = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineEnd = lineStart + lines[i]!.length;
    if (cursorOffset <= lineEnd) {
      currentLine = i;
      currentCol = cursorOffset - lineStart;
      break;
    }
    lineStart = lineEnd + 1; // +1 for the \n
  }
  return { line: currentLine, col: currentCol, totalLines: lines.length, lines };
}

export function App({ model: initialModel }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [cursorOffset, setCursorOffset] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const [llm, setLlm] = useState<LLMService | null>(null);
  const [history, setHistory] = useState<{ role: string; content: string }[]>([]);
  const [tokens, setTokens] = useState(0);
  const [cost, setCost] = useState(0);
  const [ctxPercent, setCtxPercent] = useState(0);

  // Command panel state
  const [showPanel, setShowPanel] = useState(false);
  const [panelIdx, setPanelIdx] = useState(0);

  // Abort controller for in-flight requests
  const abortRef = useRef<AbortController | null>(null);

  // Streaming text state — separate from messages (mirrors OpenClaude's pattern)
  const [streamingText, setStreamingText] = useState<string>('');
  const streamingTextRef = useRef('');

  // Model to display
  const [activeModel, setActiveModel] = useState(initialModel || 'glm-5');

  // Terminal width for input wrapping display
  const [termWidth, setTermWidth] = useState(process.stdout.columns || 80);

  useEffect(() => {
    const onResize = () => setTermWidth(process.stdout.columns || 80);
    process.stdout.on('resize', onResize);
    return () => process.stdout.off('resize', onResize);
  }, []);

  // Initialize LLM
  useEffect(() => {
    try {
      const config = loadConfig();
      if (config.apiKey) {
        const service = new LLMService({
          apiKey: config.apiKey,
          baseUrl: config.apiBaseUrl,
          model: config.model || initialModel || 'glm-5',
        });
        setLlm(service);
        setActiveModel(config.model || initialModel || 'glm-5');
      }
    } catch {
      // No config or no API key — UI still works
    }
  }, [initialModel]);

  // Execute a command
  const executeCommand = useCallback((name: string) => {
    switch (name) {
      case 'help':
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Commands: /help, /exit, /model <name>, /status, /compact, /clear'
        }]);
        break;
      case 'exit':
        exit();
        break;
      case 'status':
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Model: ${activeModel} | Tokens: ${tokens} | Cost: $${cost.toFixed(4)} | Context: ${ctxPercent}%`
        }]);
        break;
      case 'compact':
        setHistory([]);
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: 'Conversation history cleared.'
        }]);
        setTokens(0);
        setCost(0);
        setCtxPercent(0);
        break;
      case 'clear':
        setMessages([]);
        setHistory([]);
        setTokens(0);
        setCost(0);
        setCtxPercent(0);
        break;
      default:
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Unknown command: /${name}`
        }]);
    }
  }, [exit, activeModel, tokens, cost, ctxPercent]);

  // Send message to LLM
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;

    // Add user message to display
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setCursorOffset(0);

    if (!llm) {
      setMessages(prev => [...prev, {
        role: 'error',
        content: 'LLM not configured. Set OPENHORSE_API_KEY.'
      }]);
      return;
    }

    setWaiting(true);
    setStreamingText('');
    streamingTextRef.current = '';

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const newHistory = [...history, { role: 'user', content: text }];
      setMessages(prev => [...prev, { role: 'assistant', content: '' }]);

      let fullResponse = '';
      await llm.chatStream(
        newHistory.map(h => ({ role: h.role as 'user' | 'assistant' | 'system', content: h.content })),
        {
          onChunk: (chunk: string) => {
            fullResponse += chunk;
            streamingTextRef.current = fullResponse;
            setStreamingText(fullResponse);
          },
        }
      );

      setMessages(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (lastIdx >= 0 && updated[lastIdx].role === 'assistant') {
          updated[lastIdx] = { role: 'assistant', content: fullResponse };
        }
        return updated;
      });

      setStreamingText('');
      streamingTextRef.current = '';
      setHistory(prev => [...prev, { role: 'assistant', content: fullResponse }]);

      const totalChars = text.length + fullResponse.length;
      setTokens(prev => prev + totalChars);
      setCost(prev => prev + 0.0001);
      setCtxPercent(prev => Math.min(99, prev + Math.round(totalChars / 100)));

    } catch (err: any) {
      if (err.name === 'AbortError') {
        setMessages(prev => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx].role === 'assistant') {
            updated[lastIdx] = { role: 'assistant', content: streamingTextRef.current || 'Cancelled.' };
          }
          return updated;
        });
      } else {
        setMessages(prev => [...prev, {
          role: 'error',
          content: `Error: ${err.message || String(err)}`
        }]);
      }
      setStreamingText('');
      streamingTextRef.current = '';
    } finally {
      setWaiting(false);
      abortRef.current = null;
    }
  }, [llm, history]);

  // Keyboard input handler — full readline shortcuts (mirrors OpenClaude's useTextInput)
  useInput((char: string, key: Key) => {
    // Ctrl+C to exit
    if (key.ctrl && char === 'c') {
      exit();
      return;
    }

    // Command panel navigation
    if (showPanel) {
      const panelCommands = DEFAULT_COMMANDS;
      if (key.return) {
        const cmd = panelCommands[panelIdx];
        if (cmd) {
          setShowPanel(false);
          executeCommand(cmd.name);
        }
        return;
      }
      if (key.escape) { setShowPanel(false); return; }
      if (key.upArrow) { setPanelIdx(prev => Math.max(0, prev - 1)); return; }
      if (key.downArrow) { setPanelIdx(prev => Math.min(panelCommands.length - 1, prev + 1)); return; }
      return;
    }

    // Helper: move cursor to start of current line
    const startOfLine = () => {
      const text = input;
      const pos = cursorOffset;
      for (let i = pos - 1; i >= 0; i--) {
        if (text[i] === '\n') { setCursorOffset(i + 1); return; }
      }
      setCursorOffset(0);
    };

    // Helper: move cursor to end of current line
    const endOfLine = () => {
      const nlIdx = input.indexOf('\n', cursorOffset);
      setCursorOffset(nlIdx === -1 ? input.length : nlIdx);
    };

    // Helper: move cursor to previous word boundary
    const prevWord = () => {
      let i = cursorOffset - 1;
      if (i < 0) return setCursorOffset(0);
      // Skip whitespace
      while (i >= 0 && input[i] === ' ') i--;
      // Skip word characters
      while (i >= 0 && input[i] !== ' ' && input[i] !== '\n') i--;
      setCursorOffset(i + 1);
    };

    // Helper: move cursor to next word boundary
    const nextWord = () => {
      let i = cursorOffset;
      // Skip non-whitespace
      while (i < input.length && input[i] !== ' ') i++;
      // Skip whitespace
      while (i < input.length && input[i] === ' ') i++;
      setCursorOffset(i);
    };

    // Helper: delete word before cursor
    const deleteWordBefore = () => {
      let i = cursorOffset - 1;
      if (i < 0) return;
      while (i >= 0 && input[i] === ' ') i--;
      const end = i + 1;
      while (i >= 0 && input[i] !== ' ' && input[i] !== '\n') i--;
      const start = i + 1;
      const before = input.slice(0, start);
      const after = input.slice(end);
      setInput(before + after);
      setCursorOffset(start);
    };

    // Helper: kill to end of line
    const killToLineEnd = () => {
      const nlIdx = input.indexOf('\n', cursorOffset);
      const end = nlIdx === -1 ? input.length : nlIdx;
      if (end > cursorOffset) {
        const killed = input.slice(cursorOffset, end);
        killRing.unshift(killed);
        if (killRing.length > 10) killRing.pop();
        setInput(input.slice(0, cursorOffset) + input.slice(end));
      }
    };

    // Helper: kill to start of line
    const killToLineStart = () => {
      let lineStart = 0;
      for (let i = cursorOffset - 1; i >= 0; i--) {
        if (input[i] === '\n') { lineStart = i + 1; break; }
      }
      if (cursorOffset > lineStart) {
        const killed = input.slice(lineStart, cursorOffset);
        killRing.unshift(killed);
        if (killRing.length > 10) killRing.pop();
        setInput(input.slice(0, lineStart) + input.slice(cursorOffset));
        setCursorOffset(lineStart);
      }
    };

    // Helper: yank (paste) from kill ring
    const yank = () => {
      if (killRing.length === 0) return;
      const text = killRing[0];
      const before = input.slice(0, cursorOffset);
      const after = input.slice(cursorOffset);
      setInput(before + text + after);
      setCursorOffset(cursorOffset + text.length);
    };

    // ─── Ctrl shortcuts (readline/emacs style) ─────────────────────
    if (key.ctrl) {
      switch (char) {
        case 'a': startOfLine(); return;          // Ctrl+A → start of line
        case 'b': setCursorOffset(prev => Math.max(0, prev - 1)); return; // Ctrl+B ← left
        case 'e': endOfLine(); return;             // Ctrl+E → end of line
        case 'f': setCursorOffset(prev => Math.min(input.length, prev + 1)); return; // Ctrl+F → right
        case 'h': // Ctrl+H = backspace
          if (cursorOffset > 0) {
            setInput(input.slice(0, cursorOffset - 1) + input.slice(cursorOffset));
            setCursorOffset(cursorOffset - 1);
          }
          return;
        case 'k': killToLineEnd(); return;         // Ctrl+K → kill to line end
        case 'u': killToLineStart(); return;       // Ctrl+U → kill to line start
        case 'w': deleteWordBefore(); return;      // Ctrl+W → delete word before
        case 'y': yank(); return;                   // Ctrl+Y → yank (paste)
        case 'n': // Ctrl+N → down
          if (key.upArrow || key.downArrow) return; // handled below
          // Move down one line
          const ci_n = getCursorInfo(input, cursorOffset);
          if (ci_n.line < ci_n.totalLines - 1) {
            const nextLen = ci_n.lines[ci_n.line + 1]!.length;
            const nc = Math.min(ci_n.col, nextLen);
            let no = 0;
            for (let j = 0; j <= ci_n.line; j++) no += ci_n.lines[j]!.length + 1;
            setCursorOffset(no + nc);
          }
          return;
        case 'p': // Ctrl+P → up
          // Move up one line
          const ci_p = getCursorInfo(input, cursorOffset);
          if (ci_p.line > 0) {
            const prevLen = ci_p.lines[ci_p.line - 1]!.length;
            const pc = Math.min(ci_p.col, prevLen);
            let po = 0;
            for (let j = 0; j < ci_p.line - 1; j++) po += ci_p.lines[j]!.length + 1;
            setCursorOffset(po + pc);
          }
          return;
      }
    }

    // ─── Alt/Meta shortcuts ────────────────────────────────────────
    if (key.meta) {
      switch (char) {
        case 'b': prevWord(); return;              // Alt+B → prev word
        case 'f': nextWord(); return;              // Alt+F → next word
        case 'd': { // Alt+D → delete word after
          let i = cursorOffset;
          while (i < input.length && input[i] !== ' ') i++;
          const end = i;
          i = cursorOffset;
          while (i < input.length && input[i] === ' ') i++;
          const wordEnd = i > end ? i : end;
          if (wordEnd > cursorOffset) {
            const killed = input.slice(cursorOffset, wordEnd);
            killRing.unshift(killed);
            if (killRing.length > 10) killRing.pop();
            setInput(input.slice(0, cursorOffset) + input.slice(wordEnd));
          }
          return;
        }
        case 'y': { // Alt+Y → yank-pop (cycle kill ring)
          if (killRing.length > 1) {
            const last = killRing.shift();
            if (last) killRing.push(last);
            yank();
          }
          return;
        }
      }
      // Meta+Enter inserts newline
      if (key.return) {
        const before = input.slice(0, cursorOffset);
        const after = input.slice(cursorOffset);
        const newText = before + '\n' + after;
        setInput(newText);
        setCursorOffset(cursorOffset + 1);
        return;
      }
    }

    // ─── Ctrl+Arrow / Home / End / Delete ──────────────────────────
    if (key.ctrl && key.leftArrow) { prevWord(); return; }      // Ctrl+Left → prev word
    if (key.ctrl && key.rightArrow) { nextWord(); return; }     // Ctrl+Right → next word
    if (key.home) { startOfLine(); return; }                     // Home → start of line
    if (key.end) { endOfLine(); return; }                         // End → end of line
    if (key.delete) { // Delete → delete char after cursor
      if (cursorOffset < input.length) {
        setInput(input.slice(0, cursorOffset) + input.slice(cursorOffset + 1));
      }
      return;
    }

    // Shift+Enter inserts newline (multi-line input)
    if (key.return && key.shift) {
      const before = input.slice(0, cursorOffset);
      const after = input.slice(cursorOffset);
      const newText = before + '\n' + after;
      setInput(newText);
      setCursorOffset(cursorOffset + 1);
      return;
    }

    // Enter to send (only if cursor is on last line)
    if (key.return) {
      const lastNewlineIdx = input.lastIndexOf('\n');
      const cursorOnLastLine = lastNewlineIdx === -1 || cursorOffset > lastNewlineIdx;
      if (cursorOnLastLine && input.trim()) {
        sendMessage(input);
      }
      return;
    }

    // Backspace
    if (key.backspace) {
      if (cursorOffset > 0) {
        const before = input.slice(0, cursorOffset - 1);
        const after = input.slice(cursorOffset);
        const newText = before + after;
        setInput(newText);
        setCursorOffset(cursorOffset - 1);
      }
      return;
    }

    // Arrow keys
    if (key.leftArrow) {
      setCursorOffset(prev => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow) {
      setCursorOffset(prev => Math.min(input.length, prev + 1));
      return;
    }
    if (key.upArrow) {
      const cursorInfo = getCursorInfo(input, cursorOffset);
      if (cursorInfo.line > 0) {
        const prevLineLen = cursorInfo.lines[cursorInfo.line - 1]!.length;
        const newCol = Math.min(cursorInfo.col, prevLineLen);
        let newOffset = 0;
        for (let i = 0; i < cursorInfo.line - 1; i++) {
          newOffset += cursorInfo.lines[i]!.length + 1;
        }
        setCursorOffset(newOffset + newCol);
      }
      return;
    }
    if (key.downArrow) {
      const cursorInfo = getCursorInfo(input, cursorOffset);
      if (cursorInfo.line < cursorInfo.totalLines - 1) {
        const nextLineLen = cursorInfo.lines[cursorInfo.line + 1]!.length;
        const newCol = Math.min(cursorInfo.col, nextLineLen);
        let newOffset = 0;
        for (let i = 0; i <= cursorInfo.line; i++) {
          newOffset += cursorInfo.lines[i]!.length + 1;
        }
        setCursorOffset(newOffset + newCol);
      }
      return;
    }

    // Slash at start of empty input opens command panel
    if (char === '/' && input === '') {
      setShowPanel(true);
      setPanelIdx(0);
      return;
    }

    // Ignore escape, tab
    if (key.escape || key.tab) {
      return;
    }

    // Accumulate text at cursor position
    if (char && !key.return && char !== '\r' && char !== '\n') {
      const before = input.slice(0, cursorOffset);
      const after = input.slice(cursorOffset);
      const newText = before + char + after;
      setInput(newText);
      setCursorOffset(cursorOffset + char.length);
    }
  });

  // Handle /model command
  useEffect(() => {
    if (input.startsWith('/model ')) {
      const newModel = input.slice(7).trim();
      if (newModel && llm) {
        setActiveModel(newModel);
        const config = loadConfig();
        setLlm(new LLMService({
          apiKey: config.apiKey || '',
          baseUrl: config.apiBaseUrl,
          model: newModel,
        }));
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Model switched to: ${newModel}`
        }]);
        setInput('');
        setCursorOffset(0);
      }
    } else if (input === '/model') {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Current model: ${activeModel}`
      }]);
      setInput('');
      setCursorOffset(0);
    }
  }, [input]);

  // Render multi-line input with cursor
  const renderedInput = useMemo(() => {
    const cursorInfo = getCursorInfo(input, cursorOffset);
    const effectiveWidth = termWidth - 4; // Account for ❯ prompt and padding

    return cursorInfo.lines.map((line, lineIdx) => {
      const cursorInThisLine = lineIdx === cursorInfo.line;
      const col = cursorInThisLine ? cursorInfo.col : -1;

      // Wrap long lines
      const wrappedLines: string[] = [];
      let remaining = line;
      while (remaining.length > 0) {
        wrappedLines.push(remaining.slice(0, effectiveWidth));
        remaining = remaining.slice(effectiveWidth);
      }

      return wrappedLines.map((wrappedLine, wrapIdx) => {
        if (cursorInThisLine && wrapIdx === 0 && col <= wrappedLine.length) {
          const before = wrappedLine.slice(0, col);
          const after = wrappedLine.slice(col);
          return (
            <Box key={`${lineIdx}-${wrapIdx}`}>
              {lineIdx === 0 && wrapIdx === 0 && <Text color="cyan" bold>❯ </Text>}
              {lineIdx !== 0 && wrapIdx === 0 && <Text>  </Text>}
              {lineIdx === 0 && wrapIdx !== 0 && <Text>  </Text>}
              <Text>{before}</Text>
              <Text inverseColor>{after.length > 0 ? after[0] || ' ' : ' '}</Text>
              <Text>{after.slice(1)}</Text>
            </Box>
          );
        }
        return (
          <Box key={`${lineIdx}-${wrapIdx}`}>
            {lineIdx === 0 && wrapIdx === 0 && <Text color="cyan" bold>❯ </Text>}
            {(lineIdx !== 0 || wrapIdx !== 0) && <Text>  </Text>}
            <Text>{wrappedLine}</Text>
          </Box>
        );
      });
    }).flat();
  }, [input, cursorOffset, termWidth]);

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Messages area */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {messages.length === 0 && streamingText === '' && (
          <Text dimColor>Type a message. Enter to send, Shift+Enter for newline, / for commands.</Text>
        )}
        {messages.map((msg, i) => {
          if (msg.role === 'user') {
            return (
              <Box key={i} flexDirection="column">
                {msg.content.split('\n').map((line, j) => (
                  <Text key={j}>{j === 0 ? '❯ ' : '  '}{line}</Text>
                ))}
              </Box>
            );
          }
          if (msg.role === 'error') {
            return <Text key={i} color="red">{msg.content}</Text>;
          }
          if (msg.role === 'assistant') {
            if (i === messages.length - 1 && waiting && streamingText) {
              return <Text key={i}>{streamingText}</Text>;
            }
            return <Text key={i}>{msg.content}</Text>;
          }
          return null;
        })}
        {waiting && !streamingText && <Text color="cyan" dimColor>▌</Text>}
      </Box>

      {/* Command panel overlay */}
      {showPanel && (
        <CommandPanel
          onSelect={(cmd) => { setShowPanel(false); executeCommand(cmd.name); }}
          onCancel={() => setShowPanel(false)}
        />
      )}

      {/* Input area with border — mirrors OpenClaude's prompt border */}
      {!showPanel && (
        <Box flexDirection="column">
          {/* Border line above input area (like Claude Code's borderBottom) */}
          <Box borderLeft={false} borderRight={false} borderTop={false} borderBottom width="100%" borderColor="gray">
            <Text color="gray" dimColor>{'─'.repeat(Math.max(0, termWidth))}</Text>
          </Box>

          {/* Input lines */}
          <Box flexDirection="column" paddingX={1} paddingTop={1}>
            {renderedInput}
            {input === '' && (
              <Box>
                <Text color="cyan" bold>❯ </Text>
                <Text inverseColor> </Text>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {/* Separator above status bar */}
      <Box width="100%" paddingX={1}>
        <Text color="gray" dimColor>{'─'.repeat(Math.max(0, termWidth - 2))}</Text>
      </Box>

      {/* Status bar */}
      <StatusBar
        model={activeModel}
        tokens={tokens}
        cost={cost}
        ctxPercent={ctxPercent}
      />
    </Box>
  );
}
