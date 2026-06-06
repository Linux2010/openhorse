/**
 * openhorse - Web Tools
 *
 * WebFetch: Fetch URL content and process with prompt
 * WebSearch: Search the web for information
 *
 * v0.1.11: 工具失败透明反馈 - 搜索失败时告知用户失败源、切换后的源、重试次数
 * Issue #32 #3.7: SSRF 拦截 - 拒绝访问内网地址 + Content-Length 上限
 */

import { buildTool, type OpenHorseTool } from '../framework/tool';

// ============================================================================
// SSRF Protection - Issue #32 #3.7
// ============================================================================

/** 内网 IP 地址范围（禁止访问） */
const BLOCKED_IP_PATTERNS = [
  /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,       // 127.x.x.x (localhost range)
  /^10\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,        // 10.x.x.x (private class A)
  /^192\.168\.(\d{1,3})\.(\d{1,3})$/,             // 192.168.x.x (private class C)
  /^169\.254\.(\d{1,3})\.(\d{1,3})$/,             // 169.254.x.x (link-local)
  /^172\.(1[6-9]|2\d|3[01])\.(\d{1,3})\.(\d{1,3})$/, // 172.16-31.x.x (private class B)
  /^0\.0\.0\.0$/,                                  // 0.0.0.0
  /^::1$/,                                         // IPv6 localhost
  /^fc[0-9a-f]{2}:/i,                              // IPv6 unique local
  /^fe[8-9a-f][0-9a-f]:/i,                         // IPv6 link-local
];

/** 禁止访问的主机名 */
const BLOCKED_HOSTNAMES = [
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',    // GCP metadata server
  'metadata',                     // Azure metadata
  'kubernetes.default',           // K8s internal
  'kubernetes.default.svc',
];

/** 最大响应内容长度 (10MB) */
const MAX_CONTENT_LENGTH = 10 * 1024 * 1024;

/**
 * 检查 URL 是否为内网地址
 * @param url - 要检查的 URL
 * @returns 是否为安全的（非内网）地址
 */
function isUrlSafeForSSRF(url: string): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // 检查禁止的主机名
    if (BLOCKED_HOSTNAMES.includes(hostname)) {
      return { safe: false, reason: `Blocked hostname: ${hostname}` };
    }

    // 检查内网 IP 模式
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        return { safe: false, reason: `Blocked IP range: ${hostname}` };
      }
    }

    // 检查以 .internal, .local, .localhost 结尾的主机名
    if (hostname.endsWith('.internal') || hostname.endsWith('.local') || hostname.endsWith('.localhost')) {
      return { safe: false, reason: `Blocked internal hostname: ${hostname}` };
    }

    return { safe: true };
  } catch {
    // URL 解析失败
    return { safe: false, reason: 'Invalid URL format' };
  }
}

// ============================================================================
// WebFetch Tool
// ============================================================================

/** Preapproved hosts that don't need permission */
const PREAPPROVED_HOSTS = [
  'github.com',
  'docs.google.com',
  'stackoverflow.com',
  'npmjs.com',
  'nodejs.org',
  'typescriptlang.org',
  'reactjs.org',
  'vuejs.org',
  'python.org',
  'golang.org',
  'rust-lang.org',
  'mdn.mozilla.org',
  'developer.mozilla.org',
  'wikipedia.org',
  'arxiv.org',
];

const MAX_MARKDOWN_LENGTH = 100_000;
const FETCH_CACHE_TTL_MS = 15 * 60 * 1000;
const FETCH_CACHE_MAX_ENTRIES = 50;

interface CacheEntry {
  ts: number;
  data: { content: string; code: number; contentType: string };
}

const fetchCache = new Map<string, CacheEntry>();

function cacheGet(url: string): CacheEntry['data'] | null {
  const entry = fetchCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.ts > FETCH_CACHE_TTL_MS) {
    fetchCache.delete(url);
    return null;
  }
  return entry.data;
}

function cacheSet(url: string, data: CacheEntry['data']): void {
  // Cap size — drop oldest entry when full
  if (fetchCache.size >= FETCH_CACHE_MAX_ENTRIES) {
    const oldest = fetchCache.keys().next().value;
    if (oldest) fetchCache.delete(oldest);
  }
  fetchCache.set(url, { ts: Date.now(), data });
}

function isPreapprovedHost(hostname: string, pathname: string): boolean {
  return PREAPPROVED_HOSTS.some(host => hostname === host || hostname.endsWith('.' + host));
}

/** Simple HTML to Markdown converter */
function htmlToMarkdown(html: string): string {
  let md = html;

  // Remove script, style, nav, header, footer tags
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  md = md.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  md = md.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');

  // Convert headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '###### $1\n\n');

  // Bold and italic
  md = md.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  md = md.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');

  // Links
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');

  // Code blocks
  md = md.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');

  // Lists
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, '$1');
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, '$1');

  // Paragraphs and divs
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  md = md.replace(/<div[^>]*>([\s\S]*?)<\/div>/gi, '$1\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Remove remaining tags
  md = md.replace(/<[^>]+>/g, '');

  // Clean up whitespace
  md = md.replace(/\n{3,}/g, '\n\n');
  md = md.trim();

  return md;
}

interface FetchResult {
  content: string;
  code: number;
  contentType: string;
  url?: string;           // 最终 URL（跟随重定向后）
  redirects?: string[];   // 重定向链
  errorType?: string;     // 错误类型
}

async function fetchUrl(url: string, maxRedirects: number = 5): Promise<FetchResult> {
  const cached = cacheGet(url);
  if (cached) return { ...cached, url };

  // Issue #32 #3.7: SSRF 检查
  const ssrfCheck = isUrlSafeForSSRF(url);
  if (!ssrfCheck.safe) {
    return {
      content: `SSRF blocked: ${ssrfCheck.reason}`,
      code: 403,
      contentType: 'text/plain',
      errorType: 'SSRF_BLOCKED',
    };
  }

  try {
    // Issue #20 修复：启用 redirect: 'follow' 自动跟随重定向
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'OpenHorse/0.1.14',
        'Accept': 'text/html,application/xhtml+xml,text/markdown,text/plain,*/*',
      },
      redirect: 'follow',  // 自动跟随重定向（最多 20 次，由 fetch 内置限制）
    });

    // Issue #32 #3.7: Content-Length 检查
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_CONTENT_LENGTH) {
      return {
        content: `Response too large: Content-Length ${contentLength} exceeds ${MAX_CONTENT_LENGTH} bytes`,
        code: 413,
        contentType: 'text/plain',
        errorType: 'CONTENT_TOO_LARGE',
      };
    }

    const contentType = response.headers.get('content-type') || 'text/plain';
    const finalUrl = response.url;
    const redirects: string[] = [];

    // 记录重定向信息（如果发生了重定向）
    if (response.redirected && finalUrl !== url) {
      redirects.push(finalUrl);
    }

    if (!response.ok) {
      return {
        content: `HTTP Error ${response.status}: ${response.statusText}`,
        code: response.status,
        contentType,
        url: finalUrl,
        redirects,
        errorType: 'HTTP_ERROR',
      };
    }

    const text = await response.text();

    // Convert to markdown if HTML
    let content = text;
    if (contentType.includes('text/html')) {
      content = htmlToMarkdown(text);
    }

    // Truncate if too large
    if (content.length > MAX_MARKDOWN_LENGTH) {
      content = content.slice(0, MAX_MARKDOWN_LENGTH) + '\n\n[... content truncated]';
    }

    const result: FetchResult = {
      content,
      code: response.status,
      contentType,
      url: finalUrl,
      redirects,
    };
    if (response.ok) cacheSet(url, { content, code: response.status, contentType });
    return result;
  } catch (err: any) {
    return {
      content: `Fetch error: ${err.message}`,
      code: 0,
      contentType: 'text/plain',
      errorType: 'NETWORK_ERROR',
    };
  }
}

/** Clear the fetch cache (test helper / debugging) */
export function clearWebFetchCache(): void {
  fetchCache.clear();
}

/** Apply prompt to content using simple extraction */
function applyPromptToContent(content: string, prompt: string): string {
  // For simple prompts, return the content directly
  const lowerPrompt = prompt.toLowerCase();

  if (lowerPrompt.includes('title') || lowerPrompt.includes('name')) {
    // Try to extract title
    const titleMatch = content.match(/^#\s+(.+)$/m);
    if (titleMatch) {
      return `Title: ${titleMatch[1]}\n\n${content}`;
    }
  }

  if (lowerPrompt.includes('summary') || lowerPrompt.includes('summarize')) {
    // Return first few paragraphs as summary
    const paragraphs = content.split('\n\n').filter(p => p.length > 50);
    const summary = paragraphs.slice(0, 3).join('\n\n');
    return `Summary:\n${summary}\n\n---\n\nFull content:\n${content}`;
  }

  // Default: return content with prompt context
  return `Prompt: "${prompt}"\n\nContent:\n${content}`;
}

export const webFetchTool: OpenHorseTool = buildTool({
  name: 'web_fetch',
  description: `Fetch content from a URL and process with a prompt.
IMPORTANT: WebFetch WILL FAIL for authenticated or private URLs.
Before using this tool, check if the URL points to an authenticated service (e.g. Google Docs, Confluence, Jira, GitHub).`,
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch content from (must be a valid URL)',
      },
      prompt: {
        type: 'string',
        description: 'The prompt to run on the fetched content (e.g. "extract the title", "summarize the content")',
      },
    },
    required: ['url', 'prompt'],
  },
  execute: async (args) => {
    const url = args.url as string;
    const prompt = args.prompt as string;

    if (!url || typeof url !== 'string') {
      return { success: false, output: '', error: 'web_fetch requires a url parameter' };
    }

    if (!prompt || typeof prompt !== 'string') {
      return { success: false, output: '', error: 'web_fetch requires a prompt parameter' };
    }

    // Validate URL
    try {
      const parsed = new URL(url);
      if (!parsed.protocol.startsWith('http')) {
        return { success: false, output: '', error: 'URL must use http or https protocol' };
      }
    } catch {
      return { success: false, output: '', error: `Invalid URL: ${url}` };
    }

    const { content, code, contentType, url: finalUrl, redirects, errorType } = await fetchUrl(url);

    // Issue #20 修复：返回结构化结果
    // Issue #32 #3.7: SSRF 和 Content-Length 错误处理
    if (code !== 200) {
      const errorInfo = {
        type: errorType || 'HTTP_ERROR',
        code,
        message: content,
        url: finalUrl,
        redirects: redirects || [],
      };

      // SSRF 或 Content-Length 错误时返回更详细的错误
      if (errorType === 'SSRF_BLOCKED') {
        return {
          success: false,
          output: '',
          error: `Security policy blocked access to internal network address. ${content}`,
        };
      }
      if (errorType === 'CONTENT_TOO_LARGE') {
        return {
          success: false,
          output: '',
          error: `Response exceeds maximum allowed size (${MAX_CONTENT_LENGTH} bytes). ${content}`,
        };
      }

      return {
        success: false,
        output: '',
        error: JSON.stringify(errorInfo),
      };
    }

    const resultContent = applyPromptToContent(content, prompt);
    const finalUrlInfo = finalUrl !== url ? `\n\nFinal URL (after redirects): ${finalUrl}` : '';

    return {
      success: true,
      output: resultContent + finalUrlInfo,
    };
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: (args) => {
    const url = args.url as string;
    try {
      const parsed = new URL(url);
      if (isPreapprovedHost(parsed.hostname, parsed.pathname)) {
        return { behavior: 'allow', reason: 'Preapproved host' };
      }
    } catch {
      // Invalid URL - will fail in execute
    }
    return { behavior: 'ask', reason: 'Fetching external URL' };
  },
  userFacingName: (args) => {
    try {
      const url = new URL(args.url as string);
      return `Fetch ${url.hostname}`;
    } catch {
      return `Fetch ${args.url as string}`;
    }
  },
});

// ============================================================================
// WebSearch Tool - v0.1.11 增强失败反馈
// ============================================================================

interface SearchError {
  type: string;
  message: string;
  retryable: boolean;
  retryCount?: number;        // v0.1.11: 重试次数
  switchedTo?: string;       // v0.1.11: 切换后的源
}

interface SearchResult {
  success: boolean;
  results: Array<{ title: string; url: string; description: string }>;
  source: 'duckduckgo';
  error?: SearchError;
  retryAttempts?: number;    // v0.1.11: 总重试次数
}

interface SearchFallbackResult {
  // v0.1.11: 当主搜索失败后尝试备用方法的结果
  primaryFailed: boolean;
  primaryError?: SearchError;
  fallbackUsed?: string;
  fallbackResults?: Array<{ title: string; url: string; description: string }>;
}

/** DuckDuckGo search (free, no API key required) - v0.1.11 增强重试 */
async function duckDuckGoSearch(query: string, limit: number, maxRetries: number = 3): Promise<SearchResult> {
  let lastError: SearchError | undefined;
  let retryCount = 0;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const response = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; OpenHorse/0.1.5)',
        },
      });

      if (!response.ok) {
        lastError = {
          type: 'SEARCH_ENGINE_UNAVAILABLE',
          message: `HTTP ${response.status}: ${response.statusText}`,
          retryable: response.status >= 500 || response.status === 429,
          retryCount: attempt + 1,
        };

        // Retry on server errors or rate limits
        if (lastError.retryable && attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          retryCount++;
          continue;
        }

        return {
          success: false,
          results: [],
          source: 'duckduckgo',
          error: lastError,
          retryAttempts: retryCount,
        };
      }

      const html = await response.text();
      const results: Array<{ title: string; url: string; description: string }> = [];

      // Parse search results from HTML
      const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g;
      let match;
      let count = 0;

      while ((match = resultRegex.exec(html)) !== null && count < limit) {
        const url = match[1];
        const title = match[2].trim();

        // DuckDuckGo redirects through their URL - extract actual URL
        let actualUrl = url;
        const uddgMatch = url.match(/uddg=([^&]+)/);
        if (uddgMatch) {
          actualUrl = decodeURIComponent(uddgMatch[1]);
        }

        results.push({
          title,
          url: actualUrl,
          description: '',
        });
        count++;
      }

      return { success: true, results, source: 'duckduckgo', retryAttempts: retryCount };
    } catch (err: any) {
      lastError = {
        type: 'SEARCH_ENGINE_UNAVAILABLE',
        message: err.message,
        retryable: true,
        retryCount: attempt + 1,
      };

      // Retry on network errors
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        retryCount++;
        continue;
      }
    }
  }

  // All retries exhausted
  return {
    success: false,
    results: [],
    source: 'duckduckgo',
    error: lastError,
    retryAttempts: retryCount,
  };
}

/** Format search results */
function formatSearchResults(results: Array<{ title: string; url: string; description: string }>, query: string): string {
  if (results.length === 0) {
    return `No results found for query: "${query}"`;
  }

  const lines: string[] = [];
  lines.push(`Search results for "${query}":`);
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   URL: ${r.url}`);
    if (r.description) {
      lines.push(`   ${r.description}`);
    }
    lines.push('');
  }

  lines.push('Sources:');
  for (const r of results) {
    lines.push(`- [${r.title}](${r.url})`);
  }

  return lines.join('\n');
}

export const webSearchTool: OpenHorseTool = buildTool({
  name: 'web_search',
  description: `Search the web for information using DuckDuckGo.
Returns search results with titles, URLs, and descriptions.
You MUST include the Sources section with markdown hyperlinks in your response.`,
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query (minimum 2 characters)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results (optional, default 5)',
      },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const query = args.query as string;
    const limit = (args.limit as number) || 5;

    if (!query || typeof query !== 'string') {
      return { success: false, output: '', error: 'web_search requires a query parameter' };
    }

    if (query.length < 2) {
      return { success: false, output: '', error: 'Query must be at least 2 characters' };
    }

    // v0.1.11: 使用增强的重试版本
    const result = await duckDuckGoSearch(query, limit, 3);

    if (!result.success) {
      // v0.1.11: 返回详细的失败信息
      const errorInfo = result.error!;
      const detailedError = {
        type: errorInfo.type,
        source: 'duckduckgo',
        message: errorInfo.message,
        retryCount: result.retryAttempts || 0,
        suggestion: 'Try again later or use a different search query',
      };

      // 生成用户友好的错误消息
      const userMessage = [
        `⚠ Search failed: ${errorInfo.message}`,
        `  Source: DuckDuckGo`,
        `  Retry attempts: ${result.retryAttempts || 0}`,
        '',
        'Results may be incomplete. Consider:',
        '  - Using a simpler query',
        '  - Waiting a few seconds and retrying',
      ].join('\n');

      return {
        success: false,
        output: userMessage,
        error: JSON.stringify(detailedError),
        metadata: { source: 'duckduckgo', count: 0, retries: result.retryAttempts },
      };
    }

    // v0.1.11: 如果有重试，添加提示
    let output = formatSearchResults(result.results, query);
    if (result.retryAttempts && result.retryAttempts > 0) {
      output = `ℹ Search completed after ${result.retryAttempts} retries\n\n${output}`;
    }

    return {
      success: true,
      output,
      metadata: { source: result.source, count: result.results.length, retries: result.retryAttempts },
    };
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  checkPermissions: () => {
    return { behavior: 'ask', reason: 'Web search may query external services' };
  },
  userFacingName: (args) => `Search "${(args.query as string)?.slice(0, 30)}"`,
});

// ============================================================================
// Export
// ============================================================================

export const WEB_TOOLS: OpenHorseTool[] = [webFetchTool, webSearchTool];