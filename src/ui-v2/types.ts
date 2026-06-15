/**
 * OpenHorse UI v2 shared types.
 *
 * The first v2 slice keeps rendering lightweight and state-driven so the
 * legacy REPL can adopt it incrementally before a full Ink renderer lands.
 */

export type SuggestionKind =
  | 'command'
  | 'file'
  | 'session'
  | 'model'
  | 'mcp-resource'
  | 'skill';

export interface SuggestionItem {
  id: string;
  kind: SuggestionKind;
  label: string;
  detail?: string;
  shortcut?: string;
  disabledReason?: string;
  value?: string;
  metadata?: Record<string, unknown>;
}

export interface PaletteTheme {
  accent: (text: string) => string;
  dim: (text: string) => string;
  selected: (text: string) => string;
}

export interface PaletteRenderOptions {
  title: string;
  items: SuggestionItem[];
  selectedIndex: number;
  width: number;
  moreCount?: number;
  footer?: string;
  emptyLabel?: string;
  theme: PaletteTheme;
}
