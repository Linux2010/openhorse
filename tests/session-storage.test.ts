import {
  createSession,
  saveSessionMeta,
  loadSessionMeta,
  updateSessionStats,
  updateSessionSkills,
  endSession,
  appendHistory,
  readHistory,
  readProjectHistory,
  appendSessionMessage,
  readSessionMessages,
  listProjectSessions,
  findSession,
  lookupSessionRef,
  renameSession,
  getLastSession,
  resumeSession,
  resolveProjectPath,
  type SessionMeta,
  type HistoryEntry,
  type SessionMessage,
} from '../src/services/session-storage';
import { existsSync, rmSync, realpathSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getProjectSessionMessagesPath, getProjectSessionMetaPath } from '../src/services/config-dir';

describe('session-storage', () => {
  // Use a unique test directory based on timestamp to avoid conflicts
  const testDir = join(homedir(), `.openhorse-test-session-${Date.now()}`);
  const originalEnv = process.env.OPENHORSE_CONFIG_DIR;

  beforeAll(() => {
    process.env.OPENHORSE_CONFIG_DIR = testDir;
    // Clean up test directory if it exists
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
    // Restore original env var
    if (originalEnv !== undefined) {
      process.env.OPENHORSE_CONFIG_DIR = originalEnv;
    } else {
      delete process.env.OPENHORSE_CONFIG_DIR;
    }
  });

  describe('createSession', () => {
    test('creates session with correct fields', () => {
      const session = createSession('/tmp/project', 'gpt-4o');

      expect(session.id).toBeDefined();
      expect(session.projectPath).toBe('/tmp/project');
      expect(session.model).toBe('gpt-4o');
      expect(session.startTime).toBeDefined();
      expect(session.startTime).toBeLessThanOrEqual(Date.now());
      expect(session.tokenCount).toBe(0);
      expect(session.cost).toBe(0);
      expect(session.endTime).toBeUndefined();
    });

    test('stores session meta in the project scope only', () => {
      const session = createSession('/tmp/project2', 'claude-sonnet');

      expect(session.projectKey).toBeDefined();
      expect(existsSync(getProjectSessionMetaPath(session.projectPath, session.id))).toBe(true);
      expect(existsSync(join(testDir, 'sessions', `${session.id}.json`))).toBe(false);
    });
  });

  describe('loadSessionMeta', () => {
    test('returns null for non-existent session', () => {
      const session = loadSessionMeta('non-existent-id');
      expect(session).toBeNull();
    });

    test('loads existing session', () => {
      const created = createSession('/tmp/project', 'gpt-4o');
      const loaded = loadSessionMeta(created.id);

      expect(loaded?.id).toBe(created.id);
      expect(loaded?.projectPath).toBe(created.projectPath);
      expect(loaded?.model).toBe(created.model);
    });
  });

  describe('updateSessionStats', () => {
    test('updates token count and cost', () => {
      const session = createSession('/tmp/project', 'gpt-4o');

      updateSessionStats(session.id, 500, 0.01);
      updateSessionStats(session.id, 300, 0.005);

      const loaded = loadSessionMeta(session.id);
      expect(loaded?.tokenCount).toBe(800);
      expect(loaded?.cost).toBe(0.015);
    });
  });

  describe('updateSessionSkills', () => {
    test('merges applied skills into session metadata', () => {
      const session = createSession('/tmp/project-skills', 'gpt-4o');

      updateSessionSkills(session.id, ['code-review', 'security-check']);
      updateSessionSkills(session.id, ['code-review']);

      const loaded = loadSessionMeta(session.id);
      expect(loaded?.skillsUsed).toEqual(['code-review', 'security-check']);
    });
  });

  describe('endSession', () => {
    test('sets end time', () => {
      const session = createSession('/tmp/project', 'gpt-4o');

      endSession(session.id);

      const loaded = loadSessionMeta(session.id);
      expect(loaded?.endTime).toBeDefined();
      expect(loaded?.endTime).toBeGreaterThanOrEqual(loaded!.startTime);
    });
  });

  describe('history (JSONL)', () => {
    test('appendHistory creates file if not exists', () => {
      const entry: HistoryEntry = {
        display: 'hello',
        timestamp: Date.now(),
        project: '/tmp/project',
        sessionId: 'test-session',
        role: 'user',
      };

      appendHistory(entry);

      const path = join(testDir, 'history.jsonl');
      expect(existsSync(path)).toBe(true);
    });

    test('appendHistory appends multiple entries', () => {
      const entries: HistoryEntry[] = [
        {
          display: 'question 1',
          timestamp: Date.now(),
          project: '/tmp/project',
          sessionId: 'session-1',
          role: 'user',
        },
        {
          display: 'answer 1',
          timestamp: Date.now() + 1000,
          project: '/tmp/project',
          sessionId: 'session-1',
          role: 'assistant',
        },
      ];

      appendHistory(entries[0]);
      appendHistory(entries[1]);

      const history = readHistory();
      expect(history.length).toBeGreaterThanOrEqual(2);
    });

    test('readHistory returns entries in reverse order', () => {
      // Clean history
      const path = join(testDir, 'history.jsonl');
      if (existsSync(path)) {
        rmSync(path);
      }

      const entry1: HistoryEntry = {
        display: 'first',
        timestamp: 1000,
        project: '/tmp/project',
        sessionId: 'session-1',
        role: 'user',
      };
      const entry2: HistoryEntry = {
        display: 'second',
        timestamp: 2000,
        project: '/tmp/project',
        sessionId: 'session-1',
        role: 'user',
      };

      appendHistory(entry1);
      appendHistory(entry2);

      const history = readHistory();
      expect(history[0].display).toBe('second'); // Most recent first
      expect(history[1].display).toBe('first');
    });

    test('readHistory respects limit', () => {
      // Clean history
      const path = join(testDir, 'history.jsonl');
      if (existsSync(path)) {
        rmSync(path);
      }

      for (let i = 0; i < 10; i++) {
        appendHistory({
          display: `entry ${i}`,
          timestamp: i * 1000,
          project: '/tmp/project',
          sessionId: 'session-1',
          role: 'user',
        });
      }

      const history = readHistory(3);
      expect(history.length).toBe(3);
    });

    test('readProjectHistory filters by project', () => {
      // Clean history
      const path = join(testDir, 'history.jsonl');
      if (existsSync(path)) {
        rmSync(path);
      }

      appendHistory({
        display: 'project A',
        timestamp: 1000,
        project: '/tmp/projectA',
        sessionId: 'session-1',
        role: 'user',
      });
      appendHistory({
        display: 'project B',
        timestamp: 2000,
        project: '/tmp/projectB',
        sessionId: 'session-2',
        role: 'user',
      });

      const historyA = readProjectHistory('/tmp/projectA');
      expect(historyA.length).toBe(1);
      expect(historyA[0].project).toBe('/tmp/projectA');
    });
  });

  describe('session messages (JSONL)', () => {
    test('appendSessionMessage creates file', () => {
      const sessionId = 'test-msg-session';
      const message: SessionMessage = {
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      };

      appendSessionMessage(sessionId, message);

      const path = join(testDir, 'sessions', `${sessionId}.jsonl`);
      expect(existsSync(path)).toBe(true);
    });

    test('appendSessionMessage mirrors project transcript and updates message count', () => {
      const session = createSession('/tmp/project-msg-count', 'gpt-4o');

      appendSessionMessage(session.id, {
        role: 'user',
        content: 'Hello project session',
        timestamp: Date.now(),
        appliedSkills: ['code-review'],
      });

      const loaded = loadSessionMeta(session.id);
      expect(loaded?.messageCount).toBe(1);
      expect(loaded?.updatedAt).toBeGreaterThanOrEqual(session.startTime);
      expect(existsSync(getProjectSessionMessagesPath(session.projectPath, session.id))).toBe(true);
      expect(existsSync(join(testDir, 'sessions', `${session.id}.jsonl`))).toBe(false);
      expect(readSessionMessages(session.id)[0].appliedSkills).toEqual(['code-review']);
    });

    test('readSessionMessages returns all messages', () => {
      const sessionId = 'test-msg-session-2';

      appendSessionMessage(sessionId, {
        role: 'user',
        content: 'Question',
        timestamp: 1000,
      });
      appendSessionMessage(sessionId, {
        role: 'assistant',
        content: 'Answer',
        timestamp: 2000,
      });

      const messages = readSessionMessages(sessionId);
      expect(messages.length).toBe(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });

    test('readSessionMessages returns empty array for non-existent session', () => {
      const messages = readSessionMessages('non-existent');
      expect(messages).toEqual([]);
    });
  });

  describe('project session lookup', () => {
    test('listProjectSessions filters by canonical project path', () => {
      const sessionA = createSession('/tmp/project-filter-A', 'gpt-4o');
      const sessionB = createSession('/tmp/project-filter-B', 'gpt-4o');

      appendSessionMessage(sessionA.id, {
        role: 'user',
        content: 'A',
        timestamp: Date.now(),
      });
      appendSessionMessage(sessionB.id, {
        role: 'user',
        content: 'B',
        timestamp: Date.now(),
      });

      const sessionsA = listProjectSessions('/tmp/project-filter-A');
      expect(sessionsA.some(s => s.id === sessionA.id)).toBe(true);
      expect(sessionsA.some(s => s.id === sessionB.id)).toBe(false);
    });

    test('listProjectSessions does not include legacy global session files', () => {
      const project = '/tmp/project-ignore-global';
      const legacySession: SessionMeta = {
        id: 'legacy-global-session',
        projectPath: project,
        model: 'gpt-4o',
        startTime: Date.now(),
        messageCount: 1,
        tokenCount: 0,
        cost: 0,
      };

      writeFileSync(
        join(testDir, 'sessions', `${legacySession.id}.json`),
        JSON.stringify(legacySession, null, 2)
      );

      const projectSessions = listProjectSessions(project);
      const allProjectsMatch = findSession(legacySession.id, project, { allProjects: true });

      expect(projectSessions.some(s => s.id === legacySession.id)).toBe(false);
      expect(allProjectsMatch?.id).toBe(legacySession.id);
    });

    test('findSession defaults to the provided project scope', () => {
      const projectSession = createSession('/tmp/project-find-current', 'gpt-4o');
      const otherSession = createSession('/tmp/project-find-other', 'gpt-4o');

      const projectMatch = findSession(projectSession.id.slice(0, 8), '/tmp/project-find-current');
      const wrongProjectMatch = findSession(otherSession.id.slice(0, 8), '/tmp/project-find-current');
      const allProjectsMatch = findSession(otherSession.id.slice(0, 8), '/tmp/project-find-current', { allProjects: true });

      expect(projectMatch?.id).toBe(projectSession.id);
      expect(wrongProjectMatch).toBeNull();
      expect(allProjectsMatch?.id).toBe(otherSession.id);
    });

    test('lookupSessionRef reports ambiguous id prefixes', () => {
      const project = '/tmp/project-ambiguous-prefix';
      const base = createSession(project, 'gpt-4o');
      const sessionA: SessionMeta = {
        ...base,
        id: 'abc111-session',
        startTime: base.startTime + 1,
      };
      const sessionB: SessionMeta = {
        ...base,
        id: 'abc222-session',
        startTime: base.startTime + 2,
      };
      saveSessionMeta(sessionA);
      saveSessionMeta(sessionB);

      const result = lookupSessionRef('abc', project);
      expect(result.status).toBe('ambiguous');
      if (result.status === 'ambiguous') {
        expect(result.matches.map(s => s.id)).toEqual(expect.arrayContaining(['abc111-session', 'abc222-session']));
      }
      expect(findSession('abc', project)).toBeNull();
    });

    test('renameSession updates the display name and lookup by exact name', () => {
      const session = createSession('/tmp/project-rename-session', 'gpt-4o');

      const renamed = renameSession(session.id, 'api cleanup');
      const loaded = loadSessionMeta(session.id);
      const byName = findSession('api cleanup', '/tmp/project-rename-session');

      expect(renamed?.name).toBe('api cleanup');
      expect(loaded?.name).toBe('api cleanup');
      expect(byName?.id).toBe(session.id);
    });

    test('getLastSession ignores empty sessions and returns most recently updated project session', () => {
      const project = '/tmp/project-last-session';
      const empty = createSession(project, 'gpt-4o');
      const withMessages = createSession(project, 'gpt-4o');

      appendSessionMessage(withMessages.id, {
        role: 'user',
        content: 'restorable',
        timestamp: Date.now(),
      });

      const last = getLastSession(project);
      expect(last?.id).toBe(withMessages.id);
      expect(last?.id).not.toBe(empty.id);
    });

    test('resumeSession clears endTime and refreshes updatedAt', () => {
      const session = createSession('/tmp/project-resume-session', 'gpt-4o');
      endSession(session.id);

      const ended = loadSessionMeta(session.id);
      expect(ended?.endTime).toBeDefined();

      const resumed = resumeSession(session.id);
      expect(resumed?.endTime).toBeUndefined();
      expect(resumed?.updatedAt).toBeGreaterThanOrEqual(session.startTime);
    });

    test('resolveProjectPath returns a stable absolute path for non-git folders', () => {
      expect(resolveProjectPath('/tmp')).toBe(realpathSync('/tmp'));
    });
  });
});
