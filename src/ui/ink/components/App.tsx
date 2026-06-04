/**
 * openhorse v0.1.13 - Ink UI App
 *
 * Architecture: mirrors OpenClaude's REPL streaming pattern
 * - Separate streamingText state for streaming preview (not messages list)
 * - Only updates messages state when streaming completes
 * - Ref-based text accumulation avoids per-character re-renders
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
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

export function App({ model: initialModel }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
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

  // Ref for current input text — avoids React setState async race
  const inputRef = useRef('');

  // Streaming text state — separate from messages (mirrors OpenClaude's pattern)
  // This shows the streaming preview WITHOUT updating the messages list per-character
  const [streamingText, setStreamingText] = useState<string>('');
  const streamingTextRef = useRef('');

  // Model to display
  const [activeModel, setActiveModel] = useState(initialModel || 'glm-5');

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

  // Send message to LLM — mirrors OpenClaude's query() pattern
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim()) return;

    // Add user message to display
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    inputRef.current = '';

    if (!llm) {
      setMessages(prev => [...prev, {
        role: 'error',
        content: 'LLM not configured. Set OPENHORSE_API_KEY in ~/.openhorse/openhorse.json or environment.'
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

      // Add placeholder assistant message (will be updated when streaming completes)
      setMessages(prev => [...prev, { role: 'assistant', content: '...' }]);

      // Stream response — accumulate in ref, update preview state periodically
      let fullResponse = '';

      await llm.chatStream(
        newHistory.map(h => ({ role: h.role as 'user' | 'assistant' | 'system', content: h.content })),
        {
          onChunk: (chunk: string) => {
            fullResponse += chunk;
            streamingTextRef.current = fullResponse;
            // Update preview state — Ink throttles renders at ~60fps,
            // so this doesn't cause the per-character re-render storm.
            setStreamingText(fullResponse);
          },
        }
      );

      // Streaming complete — update messages with the full response
      // This mirrors OpenClaude's handleMessageFromStream completing a message
      setMessages(prev => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (lastIdx >= 0 && updated[lastIdx].role === 'assistant') {
          updated[lastIdx] = { role: 'assistant', content: fullResponse };
        }
        return updated;
      });

      // Clear streaming preview
      setStreamingText('');
      streamingTextRef.current = '';

      // Add to history
      setHistory(prev => [...prev, { role: 'assistant', content: fullResponse }]);

      // Update stats
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
            updated[lastIdx] = { role: 'assistant', content: streamingTextRef.current || 'Request cancelled.' };
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

  // Keyboard input handler — uses refs to avoid React state race conditions
  useInput((char: string, key: Key) => {
    // Ctrl+C to exit
    if (key.ctrl && char === 'c') {
      exit();
      return;
    }

    // If command panel is open
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
      if (key.escape) {
        setShowPanel(false);
        return;
      }
      if (key.upArrow) {
        setPanelIdx(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setPanelIdx(prev => Math.min(panelCommands.length - 1, prev + 1));
        return;
      }
      return;
    }

    // Enter to send — use ref for current text
    if (key.return) {
      const textToSend = inputRef.current;
      if (textToSend.trim()) {
        sendMessage(textToSend);
      }
      return;
    }

    // Slash at start of empty input opens command panel
    if (char === '/' && inputRef.current === '') {
      setShowPanel(true);
      setPanelIdx(0);
      return;
    }

    // Backspace
    if (key.backspace) {
      const newText = inputRef.current.slice(0, -1);
      inputRef.current = newText;
      setInput(newText);
      return;
    }

    // Ignore modifier keys, arrows, escape, etc.
    if (key.ctrl || key.meta || key.escape || key.tab) {
      return;
    }

    // Accumulate text — char may be multi-byte (Chinese, etc.)
    // Filter out control chars
    if (char && !key.return && char !== '\r' && char !== '\n') {
      const newText = inputRef.current + char;
      inputRef.current = newText;
      setInput(newText);
    }
  });

  // Handle /model command
  useEffect(() => {
    if (input.startsWith('/model ')) {
      const newModel = input.slice(7).trim();
      if (newModel && llm) {
        setActiveModel(newModel);
        const config = loadConfig();
        const service = new LLMService({
          apiKey: config.apiKey || '',
          baseUrl: config.apiBaseUrl,
          model: newModel,
        });
        setLlm(service);
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `Model switched to: ${newModel}`
        }]);
        setInput('');
        inputRef.current = '';
      }
    } else if (input === '/model') {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Current model: ${activeModel}`
      }]);
      setInput('');
      inputRef.current = '';
    }
  }, [input]);

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Messages area - takes all available space */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {messages.length === 0 && streamingText === '' && (
          <Text dimColor>Type a message and press Enter. Press / for commands.</Text>
        )}
        {messages.map((msg, i) => {
          if (msg.role === 'user') {
            return <Text key={i}><Text color="cyan" bold>❯ </Text>{msg.content}</Text>;
          }
          if (msg.role === 'error') {
            return <Text key={i} color="red">{msg.content}</Text>;
          }
          if (msg.role === 'assistant') {
            // If this is the last message and we're still streaming, show streaming preview
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
          onSelect={(cmd) => {
            setShowPanel(false);
            executeCommand(cmd.name);
          }}
          onCancel={() => setShowPanel(false)}
        />
      )}

      {/* Input line */}
      {!showPanel && (
        <Box flexDirection="column" paddingX={1}>
          <Text color="gray" dimColor>{'─'.repeat(Math.max(0, process.stdout.columns || 80))}</Text>
          <Box>
            <Text color="cyan" bold>❯ </Text>
            <Text>{input}</Text>
            <Text inverseColor> </Text>
          </Box>
        </Box>
      )}

      {/* Status bar - at the bottom */}
      <StatusBar
        model={activeModel}
        tokens={tokens}
        cost={cost}
        ctxPercent={ctxPercent}
      />
    </Box>
  );
}
