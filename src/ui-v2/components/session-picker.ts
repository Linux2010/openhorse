/**
 * UI v2 session picker renderer.
 */

import type { SessionMeta } from '../../services/session-storage';
import type { PaletteTheme } from '../types';
import { renderCommandPalette } from './command-palette';
import { buildSessionSuggestions } from '../state/sessions';

export interface RenderSessionPickerOptions {
  title?: string;
  sessions: SessionMeta[];
  selectedIndex?: number;
  width: number;
  showProject?: boolean;
  moreCount?: number;
  footer?: string;
  theme: PaletteTheme;
}

export function renderSessionPicker(options: RenderSessionPickerOptions): string[] {
  return renderCommandPalette({
    title: options.title ?? 'Pick a Session',
    items: buildSessionSuggestions(options.sessions, {
      showProject: options.showProject,
    }),
    selectedIndex: options.selectedIndex ?? 0,
    width: options.width,
    moreCount: options.moreCount,
    emptyLabel: 'No sessions found',
    footer: options.footer ?? '  ↑↓ Select  Enter Resume  Esc Cancel',
    theme: options.theme,
  });
}
