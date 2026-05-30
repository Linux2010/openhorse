/**
 * openhorse - SDK Sessions
 *
 * v0.1.11: SDK 会话管理函数
 */

import type { SDKSessionInfo } from './types';

/**
 * 列出所有会话
 * @param limit - 最大返回数量
 * @returns 会话列表
 */
export async function listSessions(limit?: number): Promise<SDKSessionInfo[]> {
  const maxLimit = limit ?? 10;

  // Import session storage
  try {
    const { listSessions: storageListSessions } = require('../services/session-storage');
    const sessions = storageListSessions(maxLimit);

    return sessions.map((s: { id: string; createdAt: string; updatedAt: string; messageCount?: number; projectRoot?: string }) => ({
      id: s.id,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messageCount: s.messageCount || 0,
      projectRoot: s.projectRoot,
    }));
  } catch {
    // Return empty list if session storage not available
    return [];
  }
}

/**
 * 获取单个会话信息
 * @param sessionId - 会话 ID
 * @returns 会话信息
 */
export async function getSessionInfo(sessionId: string): Promise<SDKSessionInfo | null> {
  try {
    const { loadSessionMeta } = require('../services/session-storage');
    const meta = loadSessionMeta(sessionId);

    if (!meta) return null;

    return {
      id: meta.id,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      messageCount: meta.messageCount || 0,
      projectRoot: meta.projectRoot,
    };
  } catch {
    return null;
  }
}