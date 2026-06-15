/**
 * File completion UI tests.
 */

describe('File Completion UI', () => {
  let writeSpy: jest.SpyInstance;
  let output: string[];

  beforeEach(() => {
    jest.resetModules();
    output = [];
    writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      output.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  test('uses v2 prompt renderer when configured', () => {
    const { setFileCompletionPromptRenderer, redrawInputWithFile } = require('../src/ui/file-completion');

    setFileCompletionPromptRenderer('v2');
    redrawInputWithFile('@src');

    const rendered = output.join('').replace(/\x1b\[[0-9;]*m/g, '');
    expect(rendered).toContain('› @src');
    expect(rendered).not.toContain('oh');
  });
});
