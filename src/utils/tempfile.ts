/**
 * openhorse - Temp file utility stub
 */

import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

export function generateTempFilePath(extension = '.tmp'): string {
  return join(tmpdir(), `openhorse-${randomUUID()}${extension}`);
}
