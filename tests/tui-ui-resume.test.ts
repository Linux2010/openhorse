/**
 * Regression tests for the `/resume` TUI rendering bug (v0.2.21-fix1).
 *
 * Symptom reported by the user:
 *   1. After /resume the whole page was blank — restored history was not in the
 *      visible live region (it had been fully finalized and committed to
 *      scrollback, leaving the live region empty).
 *   2. New output scrolled at the top while the bottom stayed blank and the
 *      prompt box was lost — the resume banner was written straight to stdout
 *      (console.log) bypassing the inline surface cursor tracking, desyncing
 *      `this.cursorRow`.
 *
 * Fixes under test:
 *   - state.ts: `replaceTranscript` keeps the most-recent RESUME_LIVE_TAIL (50)
 *     entries LIVE (rendered in the visible live region), while older entries
 *     are finalized and committed to scrollback (scroll up to review).
 *   - inline-surface.ts: `commit()` re-anchors `cursorRow` after committing a
 *     large batch so the subsequent live-frame render re-anchors correctly.
 */

import { InlineTerminalSurface, MemoryOutput } from '../src/tui-ui/inline-surface';
import { initialTuiUiState, tuiUiReducer, type TuiUiState } from '../src/tui-ui/state';
import { renderTuiLiveFrame } from '../src/tui-ui/layout';
import { renderFrameRows } from '../src/tui-core/frame';
import { TuiRunner } from '../src/tui-ui/runner';
import type { TranscriptEntry } from '../src/runtime/ui-events';

const RESUME_LIVE_TAIL = 50;

function makeEntries(count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `e${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    // Zero-padded so substrings are unambiguous (e.g. "restored-005" vs "restored-05").
    content: `restored-${String(i).padStart(3, '0')}`,
  }));
}

/** Walk the reducer state to a post-resume shape, exactly as the runtime does. */
function resumeState(count: number): TuiUiState {
  return tuiUiReducer(initialTuiUiState, { type: 'replaceTranscript', entries: makeEntries(count) });
}

describe('resume: replaceTranscript keeps a visible LIVE tail', () => {
  it('marks the oldest history finalized (scrollback) and the most recent 50 LIVE', () => {
    const state = resumeState(60);

    expect(state.transcript).toHaveLength(60);
    const splitIndex = 60 - RESUME_LIVE_TAIL; // 10
    expect(splitIndex).toBe(10);

    // Older prefix is finalized and therefore committable to scrollback.
    expect(state.transcript.slice(0, splitIndex).every(e => e.finalized)).toBe(true);
    // The recent tail stays LIVE so it renders in the visible live region.
    expect(state.transcript.slice(splitIndex).every(e => !e.finalized)).toBe(true);

    expect(state.committableTranscriptCount).toBe(splitIndex);
    expect(state.committedTranscriptCount).toBe(0);
    expect(state.queuedTranscriptCount).toBe(0);
  });

  it('treats a short history (<= 50) entirely as LIVE (nothing forced to scrollback)', () => {
    const state = resumeState(30);
    expect(state.transcript).toHaveLength(30);
    expect(state.transcript.every(e => !e.finalized)).toBe(true);
    expect(state.committableTranscriptCount).toBe(0);
  });

  it('does not blank the live region even for very long history', () => {
    const state = resumeState(500);
    // Only the tail is LIVE; the rest is finalized. Both counts are consistent.
    expect(state.transcript.slice(0, 500 - RESUME_LIVE_TAIL).every(e => e.finalized)).toBe(true);
    expect(state.transcript.slice(500 - RESUME_LIVE_TAIL).every(e => !e.finalized)).toBe(true);
    expect(state.committableTranscriptCount).toBe(500 - RESUME_LIVE_TAIL);
  });
});

describe('resume: live frame geometry after restore', () => {
  it('pins the prompt box at the bottom of the band and shows the LIVE tail (no blank page)', () => {
    const state = resumeState(60);
    // Live frame height = live band rows (75% of a 24-row terminal = 18).
    // The band is the bottom region that is repainted in place; committed
    // history scrolls into native scrollback above it.
    const bandRows = 18;
    const frame = renderTuiLiveFrame(state, { width: 100, height: bandRows });
    const rows = renderFrameRows(frame);

    // promptTop = bandRows - 3 = 15; input row 16; bottom border 17.
    expect(rows[15]).toContain('┌');
    expect(rows[16]).toContain('│');
    expect(rows[17]).toContain('└');

    // status row (14) is populated.
    expect(rows[14].trim().length).toBeGreaterThan(0);

    const joined = rows.join('\n');
    // The most-recent restored content is visible in the live band.
    expect(joined).toContain('restored-059');
    // The oldest finalized entries are NOT in the live band (they scrolled into scrollback).
    expect(joined).not.toContain('restored-000');
    expect(joined).not.toContain('restored-001');

    // The live band is genuinely populated, not blank.
    const nonEmpty = rows.filter(r => r.trim().length > 0).length;
    expect(nonEmpty).toBeGreaterThan(5);
  });

  it('tail always fits the live band even with huge history (slice cap)', () => {
    const state = resumeState(500);
    const bandRows = 18;
    const frame = renderTuiLiveFrame(state, { width: 100, height: bandRows });
    const rows = renderFrameRows(frame);
    // Frame must never exceed the live-band height.
    expect(rows).toHaveLength(bandRows);
    // The newest tail content is still visible.
    expect(rows.join('\n')).toContain('restored-499');
  });
});

describe('resume: end-to-end through TuiRunner + InlineTerminalSurface', () => {
  it('commit pushes older history to scrollback while the live region shows the tail + prompt', async () => {
    const output = new MemoryOutput();
    const surface = new InlineTerminalSurface({ output });
    await surface.mount(100, 24);
    const runner = new TuiRunner({ output, width: 100, height: 24, surface });

    // Simulate /resume replacing the transcript with a long history.
    runner.dispatch({ type: 'replaceTranscript', entries: makeEntries(60) });
    // Flush the render scheduler, then wait for the surface FIFO to drain.
    runner.getScheduler().flush();
    await surface.whenIdle();

    const text = output.text();
    // The tail is rendered in the live region (newest content visible).
    expect(text).toContain('restored-059');
    // The older finalized history was committed to scrollback (still in the stream).
    expect(text).toContain('restored-000');
    // The prompt box is present (not lost) — bug #2 regression.
    expect(text).toContain('┌');
    expect(text).toContain('└');
    // No forbidden sequences even after a resume + commit burst.
    output.assertNoForbidden();
  });
});
