import { describe, expect, it } from 'bun:test';
import { parseMrkdwn } from './mrkdwn';

function elements(text: string) {
  return parseMrkdwn(text)[0].elements[0].elements;
}

describe('parseMrkdwn', () => {
  it('returns plain text as-is', () => {
    expect(elements('hello world')).toEqual([
      { type: 'text', text: 'hello world' },
    ]);
  });

  it('parses *bold*', () => {
    expect(elements('hello *world*')).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world', style: { bold: true } },
    ]);
  });

  it('parses _italic_', () => {
    expect(elements('hello _world_')).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world', style: { italic: true } },
    ]);
  });

  it('parses ~strike~', () => {
    expect(elements('hello ~world~')).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world', style: { strike: true } },
    ]);
  });

  it('parses `code`', () => {
    expect(elements('hello `world`')).toEqual([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world', style: { code: true } },
    ]);
  });

  it('parses multiple formats in one line', () => {
    expect(elements('*bold* and _italic_')).toEqual([
      { type: 'text', text: 'bold', style: { bold: true } },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'italic', style: { italic: true } },
    ]);
  });

  it('parses nested *_bold italic_*', () => {
    expect(elements('*_bold italic_*')).toEqual([
      { type: 'text', text: 'bold italic', style: { italic: true, bold: true } },
    ]);
  });

  it('does not match markers with spaces inside', () => {
    expect(elements('not * bold *')).toEqual([
      { type: 'text', text: 'not * bold *' },
    ]);
  });

  it('does not match empty markers', () => {
    expect(elements('nothing ** here')).toEqual([
      { type: 'text', text: 'nothing ** here' },
    ]);
  });

  it('does not parse formatting inside `code`', () => {
    expect(elements('`*not bold*`')).toEqual([
      { type: 'text', text: '*not bold*', style: { code: true } },
    ]);
  });

  it('handles unmatched markers as plain text', () => {
    expect(elements('hello *world')).toEqual([
      { type: 'text', text: 'hello *world' },
    ]);
  });

  it('handles text after formatted text', () => {
    expect(elements('*bold* then plain')).toEqual([
      { type: 'text', text: 'bold', style: { bold: true } },
      { type: 'text', text: ' then plain' },
    ]);
  });

  it('returns valid rich_text block structure', () => {
    const result = parseMrkdwn('*hello*');
    expect(result).toEqual([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'hello', style: { bold: true } },
        ],
      }],
    }]);
  });

  it('preserves newlines in text elements', () => {
    // Newlines must be embedded in text, not split into separate sections.
    // Slack's draft composer renders multiple sections inline (no breaks),
    // but correctly preserves \n within text elements.
    const result = parseMrkdwn('line one\nline two');
    expect(result).toEqual([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [{ type: 'text', text: 'line one\nline two' }],
      }],
    }]);
  });

  it('preserves newlines with formatting', () => {
    const result = parseMrkdwn('*bold*\nplain');
    expect(result).toEqual([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'bold', style: { bold: true } },
          { type: 'text', text: '\nplain' },
        ],
      }],
    }]);
  });

  it('preserves multiple newlines', () => {
    const result = parseMrkdwn('above\n\nbelow');
    expect(result).toEqual([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [{ type: 'text', text: 'above\n\nbelow' }],
      }],
    }]);
  });
});

describe('parseMrkdwn lists', () => {
  function blockElements(text: string) {
    return parseMrkdwn(text)[0].elements;
  }

  it('turns `- ` lines into a bullet list', () => {
    expect(blockElements('- one\n- two')).toEqual([{
      type: 'rich_text_list',
      style: 'bullet',
      indent: 0,
      border: 0,
      elements: [
        { type: 'rich_text_section', elements: [{ type: 'text', text: 'one' }] },
        { type: 'rich_text_section', elements: [{ type: 'text', text: 'two' }] },
      ],
    }]);
  });

  it('treats `* ` the same as `- `', () => {
    const a = parseMrkdwn('* a')[0].elements[0];
    expect((a as any).type).toBe('rich_text_list');
    expect((a as any).style).toBe('bullet');
  });

  it('turns `1. ` lines into an ordered list', () => {
    expect(blockElements('1. first\n2. second')).toEqual([{
      type: 'rich_text_list',
      style: 'ordered',
      indent: 0,
      border: 0,
      elements: [
        { type: 'rich_text_section', elements: [{ type: 'text', text: 'first' }] },
        { type: 'rich_text_section', elements: [{ type: 'text', text: 'second' }] },
      ],
    }]);
  });

  it('accepts `1) ` ordered syntax', () => {
    const block = parseMrkdwn('1) a\n2) b')[0].elements[0];
    expect((block as any).type).toBe('rich_text_list');
    expect((block as any).style).toBe('ordered');
    expect((block as any).elements).toHaveLength(2);
  });

  it('starts a new list block when style switches bullet -> ordered', () => {
    const els = blockElements('- a\n1. b');
    expect(els).toHaveLength(2);
    expect((els[0] as any).style).toBe('bullet');
    expect((els[1] as any).style).toBe('ordered');
  });

  it('derives indent from leading spaces (2 spaces = 1 level)', () => {
    const els = blockElements('- top\n  - nested');
    expect(els).toHaveLength(2);
    expect((els[0] as any).indent).toBe(0);
    expect((els[1] as any).indent).toBe(1);
  });

  it('parses inline formatting and links inside list items', () => {
    const list = parseMrkdwn('- [2702] <https://trello.com/c/EOi1iwLA|Backdated *Consume*>')[0].elements[0] as any;
    expect(list.type).toBe('rich_text_list');
    expect(list.elements[0].elements).toEqual([
      { type: 'text', text: '[2702] ' },
      { type: 'link', url: 'https://trello.com/c/EOi1iwLA', text: 'Backdated *Consume*' },
    ]);
  });

  it('interleaves prose sections and lists (daily report shape)', () => {
    const els = blockElements('Yesterday:\n- a\n- b\n\nToday:\n- c');
    expect(els.map((e: any) => e.type)).toEqual([
      'rich_text_section',
      'rich_text_list',
      'rich_text_section',
      'rich_text_list',
    ]);
    expect((els[0] as any).elements).toEqual([{ type: 'text', text: 'Yesterday:' }]);
    expect((els[1] as any).elements).toHaveLength(2);
    expect((els[2] as any).elements).toEqual([{ type: 'text', text: '\nToday:' }]);
    expect((els[3] as any).elements).toHaveLength(1);
  });
});

describe('parseMrkdwn — mentions, links and broadcasts', () => {
  it('parses a user mention', () => {
    expect(elements('<@U123>')).toEqual([
      { type: 'user', user_id: 'U123' },
    ]);
  });

  it('parses a user mention and drops the |label', () => {
    expect(elements('<@U123|alice>')).toEqual([
      { type: 'user', user_id: 'U123' },
    ]);
  });

  it('parses a usergroup mention', () => {
    expect(elements('<!subteam^S456>')).toEqual([
      { type: 'usergroup', usergroup_id: 'S456' },
    ]);
  });

  it('parses a usergroup mention with a |label', () => {
    expect(elements('<!subteam^S456|ror-team>')).toEqual([
      { type: 'usergroup', usergroup_id: 'S456' },
    ]);
  });

  it('parses a channel mention', () => {
    expect(elements('<#C789>')).toEqual([
      { type: 'channel', channel_id: 'C789' },
    ]);
  });

  it('parses a channel mention with a |label', () => {
    expect(elements('<#C789|general>')).toEqual([
      { type: 'channel', channel_id: 'C789' },
    ]);
  });

  it('parses a <!here> broadcast', () => {
    expect(elements('<!here>')).toEqual([
      { type: 'broadcast', range: 'here' },
    ]);
  });

  it('parses a <!channel> broadcast', () => {
    expect(elements('<!channel>')).toEqual([
      { type: 'broadcast', range: 'channel' },
    ]);
  });

  it('parses a <!everyone> broadcast', () => {
    expect(elements('<!everyone>')).toEqual([
      { type: 'broadcast', range: 'everyone' },
    ]);
  });

  it('parses an explicit link without a label', () => {
    expect(elements('<https://example.com>')).toEqual([
      { type: 'link', url: 'https://example.com' },
    ]);
  });

  it('parses an explicit link with a label', () => {
    expect(elements('<https://example.com|Example>')).toEqual([
      { type: 'link', url: 'https://example.com', text: 'Example' },
    ]);
  });

  it('splits a bare URL out of surrounding text', () => {
    expect(elements('see https://example.com now')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', url: 'https://example.com' },
      { type: 'text', text: ' now' },
    ]);
  });

  it('keeps text immediately after a link separate', () => {
    expect(elements('<https://example.com> done')).toEqual([
      { type: 'link', url: 'https://example.com' },
      { type: 'text', text: ' done' },
    ]);
  });

  it('does not append following text onto a mention element', () => {
    // Regression guard for the line-78 fix: without the `type === 'text'`
    // guard, the trailing "\nhi" would be concatenated onto the mention.
    expect(elements('<@U123>\nhi')).toEqual([
      { type: 'user', user_id: 'U123' },
      { type: 'text', text: '\nhi' },
    ]);
  });

  it('combines a mention with bold text', () => {
    expect(elements('*Heads up* <@U123>')).toEqual([
      { type: 'text', text: 'Heads up', style: { bold: true } },
      { type: 'text', text: ' ' },
      { type: 'user', user_id: 'U123' },
    ]);
  });

  it('keeps a link inside *bold* unstyled (pushed unchanged)', () => {
    expect(elements('*<https://example.com>*')).toEqual([
      { type: 'link', url: 'https://example.com' },
    ]);
  });

  it('leaves a stray < as plain text', () => {
    expect(elements('a < b')).toEqual([
      { type: 'text', text: 'a < b' },
    ]);
  });

  it('returns a valid rich_text block for a mention', () => {
    expect(parseMrkdwn('hi <@U123>')).toEqual([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'hi ' },
          { type: 'user', user_id: 'U123' },
        ],
      }],
    }]);
  });
});
