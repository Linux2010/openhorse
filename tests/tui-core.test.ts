import { createTuiFrame, diffTuiFrames, renderFrameRows, setFrameCursor, writeFrameText } from '../src/tui-core/frame';
import { TuiInputParser } from '../src/tui-core/input-parser';
import { cursorHide, cursorShow, disableAutoWrap, enableAutoWrap, moveTo, renderTerminalFrame, TuiTerminalWriter } from '../src/tui-core/terminal-writer';

describe('tui-core input parser', () => {
  it('keeps split UTF-8 CJK bytes intact before emitting text', () => {
    const parser = new TuiInputParser();
    const bytes = Buffer.from('开源小？事收到', 'utf8');
    const first = bytes.subarray(0, 5);
    const second = bytes.subarray(5);

    expect(parser.feed(first)).toEqual([{ type: 'text', value: '开' }]);
    expect(parser.feed(second)).toEqual([{ type: 'text', value: '源小？事收到' }]);
  });

  it('parses deletion and control keys without confusing DEL backspace for forward delete', () => {
    const parser = new TuiInputParser();

    expect(parser.feed(Buffer.from('\x7f'))).toEqual([{ type: 'key', key: 'backspace', raw: '\x7f' }]);
    expect(parser.feed(Buffer.from('\b'))).toEqual([{ type: 'key', key: 'backspace', raw: '\b' }]);
    expect(parser.feed(Buffer.from('\x1b[3~'))).toEqual([{ type: 'key', key: 'delete', raw: '\x1b[3~' }]);
    expect(parser.feed(Buffer.from('\x03\x03'))).toEqual([
      { type: 'key', key: 'ctrl+c', raw: '\x03' },
      { type: 'key', key: 'ctrl+c', raw: '\x03' },
    ]);
  });

  it('coalesces text while preserving key order', () => {
    const parser = new TuiInputParser();

    expect(parser.feed(Buffer.from('ab\x1b[D中'))).toEqual([
      { type: 'text', value: 'ab' },
      { type: 'key', key: 'left', raw: '\x1b[D' },
      { type: 'text', value: '中' },
    ]);
  });

  it('emits bracketed paste as one normalized paste event', () => {
    const parser = new TuiInputParser();

    expect(parser.feed(Buffer.from('\x1b[200~one\r\ntwo\x1b[201~'))).toEqual([
      { type: 'paste', value: 'one\ntwo' },
    ]);
  });

  it('keeps split bracketed paste delimiters intact across chunks', () => {
    const parser = new TuiInputParser();

    expect(parser.feed(Buffer.from('\x1b[2'))).toEqual([]);
    expect(parser.feed(Buffer.from('00~one\n'))).toEqual([]);
    expect(parser.feed(Buffer.from('two\x1b[20'))).toEqual([]);
    expect(parser.feed(Buffer.from('1~'))).toEqual([
      { type: 'paste', value: 'one\ntwo' },
    ]);
  });

  it('keeps split CSI keys intact across chunks', () => {
    const parser = new TuiInputParser();

    expect(parser.feed(Buffer.from('\x1b['))).toEqual([]);
    expect(parser.feed(Buffer.from('D'))).toEqual([
      { type: 'key', key: 'left', raw: '\x1b[D' },
    ]);
  });
});

describe('tui-core frame model', () => {
  it('renders CJK text using terminal cell width', () => {
    const frame = createTuiFrame(10, 3);

    writeFrameText(frame, 0, 0, 'A你B');

    expect(renderFrameRows(frame)[0]).toBe('A你B      ');
    expect(frame.rows[0][1]).toMatchObject({ char: '你', width: 2 });
    expect(frame.rows[0][2]).toMatchObject({ char: '', width: 0 });
  });

  it('wraps before a full-width grapheme would overrun the row', () => {
    const frame = createTuiFrame(4, 3);

    writeFrameText(frame, 0, 0, 'abc你');

    expect(renderFrameRows(frame)).toEqual([
      'abc ',
      '你  ',
      '    ',
    ]);
  });

  it('keeps cursor as frame-owned state separate from row diffs', () => {
    const previous = createTuiFrame(8, 2);
    const next = createTuiFrame(8, 2);

    writeFrameText(previous, 0, 0, 'hello');
    writeFrameText(next, 0, 0, 'hello');
    setFrameCursor(next, 1, 3, true);

    expect(diffTuiFrames(previous, next)).toEqual({
      changedRows: [],
      cursorChanged: true,
    });
  });
});

describe('tui-core terminal writer', () => {
  it('renders the first frame as full changed rows plus frame-owned cursor', () => {
    const frame = createTuiFrame(8, 2);
    writeFrameText(frame, 0, 0, 'hello');
    writeFrameText(frame, 1, 0, '你');
    setFrameCursor(frame, 1, 2, true);

    const result = renderTerminalFrame(null, frame);

    expect(result.diff).toEqual({
      changedRows: [0, 1],
      cursorChanged: true,
    });
    expect(result.output).toBe([
      disableAutoWrap(),
      cursorHide(),
      moveTo(0, 0),
      '\x1b[2K',
      'hello   ',
      moveTo(1, 0),
      '\x1b[2K',
      '你      ',
      moveTo(1, 2),
      cursorShow(),
      enableAutoWrap(),
    ].join(''));
  });

  it('updates only changed rows and then parks the cursor at the declared frame position', () => {
    const previous = createTuiFrame(12, 3);
    const next = createTuiFrame(12, 3);
    writeFrameText(previous, 0, 0, 'same');
    writeFrameText(previous, 1, 0, 'old');
    writeFrameText(next, 0, 0, 'same');
    writeFrameText(next, 1, 0, 'new');
    setFrameCursor(previous, 0, 4, true);
    setFrameCursor(next, 1, 3, true);

    const result = renderTerminalFrame(previous, next);

    expect(result.diff.changedRows).toEqual([1]);
    expect(result.output).toBe([
      disableAutoWrap(),
      cursorHide(),
      moveTo(1, 0),
      '\x1b[2K',
      'new         ',
      moveTo(1, 3),
      cursorShow(),
      enableAutoWrap(),
    ].join(''));
  });

  it('can move only the cursor without rewriting transcript rows', () => {
    const previous = createTuiFrame(8, 2);
    const next = createTuiFrame(8, 2);
    writeFrameText(previous, 0, 0, 'stable');
    writeFrameText(next, 0, 0, 'stable');
    setFrameCursor(previous, 0, 1, true);
    setFrameCursor(next, 0, 5, true);

    const result = renderTerminalFrame(previous, next);

    expect(result.diff.changedRows).toEqual([]);
    expect(result.output).toBe([
      disableAutoWrap(),
      cursorHide(),
      moveTo(0, 5),
      cursorShow(),
      enableAutoWrap(),
    ].join(''));
  });

  it('stores previous frames inside the writer before writing later diffs', () => {
    const writes: string[] = [];
    const writer = new TuiTerminalWriter({
      write: (chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      },
    } as Pick<NodeJS.WriteStream, 'write'>);

    const first = createTuiFrame(6, 1);
    const second = createTuiFrame(6, 1);
    writeFrameText(first, 0, 0, 'one');
    writeFrameText(second, 0, 0, 'two');

    writer.render(first);
    writer.render(second);

    expect(writes[0]).toContain('one   ');
    expect(writes[1]).toContain('two   ');
    expect(writes[1]).not.toContain(moveTo(1, 0));
  });
});
