import { sanitizePdfTemplateAttributes } from './sanitizePdfTemplateAttributes';

describe('sanitizePdfTemplateAttributes', () => {
  it('keeps allowed formatting tags and safe links', () => {
    const result = sanitizePdfTemplateAttributes({
      footer: '<b>Thanks</b> <a href="https://example.com">site</a>',
    });
    expect(result.footer).toBe(
      '<b>Thanks</b> <a href="https://example.com">site</a>',
    );
  });

  it('strips scripts, event handlers and unsafe link schemes', () => {
    const result = sanitizePdfTemplateAttributes({
      a: '<script>alert(1)</script>ok',
      b: '<img src="x" onerror="alert(1)">',
      c: '<a href="javascript:alert(1)" onclick="x()">x</a>',
    });
    expect(result.a).toBe('ok');
    expect(result.b).toBe('');
    expect(result.c).toBe('<a>x</a>');
  });

  it('passes non-string values through unchanged', () => {
    const nested = { x: 1 };
    const result = sanitizePdfTemplateAttributes({ n: 5, b: true, o: nested });
    expect(result).toEqual({ n: 5, b: true, o: nested });
  });
});
