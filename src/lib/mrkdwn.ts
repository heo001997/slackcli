// Parse Slack mrkdwn text into rich_text block elements.
// Supports: *bold*, _italic_, ~strike~, `code`, mentions (<@U…>, <!subteam^S…>),
// channels (<#C…>), broadcasts (<!here>/<!channel>/<!everyone>), and links
// (<https://…> and bare URLs), plus combinations.

interface RichTextStyle {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}

interface RichTextText {
  type: 'text';
  text: string;
  style?: RichTextStyle;
}

interface RichTextUser {
  type: 'user';
  user_id: string;
}

interface RichTextUsergroup {
  type: 'usergroup';
  usergroup_id: string;
}

interface RichTextChannel {
  type: 'channel';
  channel_id: string;
}

interface RichTextBroadcast {
  type: 'broadcast';
  range: 'here' | 'channel' | 'everyone';
}

interface RichTextLink {
  type: 'link';
  url: string;
  text?: string;
}

type RichTextElement =
  | RichTextText
  | RichTextUser
  | RichTextUsergroup
  | RichTextChannel
  | RichTextBroadcast
  | RichTextLink;

interface RichTextSection {
  type: 'rich_text_section';
  elements: RichTextElement[];
}

interface RichTextList {
  type: 'rich_text_list';
  style: 'bullet' | 'ordered';
  indent: number;
  border: number;
  elements: RichTextSection[];
}

type RichTextBlockElement = RichTextSection | RichTextList;

interface RichTextBlock {
  type: 'rich_text';
  elements: RichTextBlockElement[];
}

// Markers and their corresponding style keys
const MARKERS: [string, keyof RichTextStyle][] = [
  ['`', 'code'],
  ['*', 'bold'],
  ['_', 'italic'],
  ['~', 'strike'],
];

// Classify the content of a Slack escape token (the text between < and >).
// Returns null when the content matches no known token, so the caller can
// treat the leading '<' as a plain character.
function parseEscapeToken(inner: string): RichTextElement | null {
  // User mention: <@U…> or <@U…|label> (label is dropped)
  if (inner.startsWith('@')) {
    const id = inner.slice(1).split('|')[0];
    if (/^[UW][A-Z0-9]+$/.test(id)) {
      return { type: 'user', user_id: id };
    }
    return null;
  }

  // Usergroup mention: <!subteam^S…> or <!subteam^S…|label>
  if (inner.startsWith('!subteam^')) {
    const id = inner.slice('!subteam^'.length).split('|')[0];
    if (/^S[A-Z0-9]+$/.test(id)) {
      return { type: 'usergroup', usergroup_id: id };
    }
    return null;
  }

  // Broadcast: <!here>, <!channel>, <!everyone> (also <!here|label>)
  if (inner.startsWith('!')) {
    const range = inner.slice(1).split('|')[0];
    if (range === 'here' || range === 'channel' || range === 'everyone') {
      return { type: 'broadcast', range };
    }
    return null;
  }

  // Channel mention: <#C…> or <#C…|label>
  if (inner.startsWith('#')) {
    const id = inner.slice(1).split('|')[0];
    if (/^C[A-Z0-9]+$/.test(id)) {
      return { type: 'channel', channel_id: id };
    }
    return null;
  }

  // Link: <https://…>, <http://…>, or <https://…|label>
  if (inner.startsWith('http://') || inner.startsWith('https://')) {
    const pipeIndex = inner.indexOf('|');
    if (pipeIndex === -1) {
      return { type: 'link', url: inner };
    }
    return { type: 'link', url: inner.slice(0, pipeIndex), text: inner.slice(pipeIndex + 1) };
  }

  return null;
}

function parseInline(text: string): RichTextElement[] {
  const elements: RichTextElement[] = [];

  let i = 0;
  while (i < text.length) {
    // Explicit escape tokens: <@U…>, <!subteam^S…>, <#C…>, <!here>, <https://…>
    if (text[i] === '<') {
      const end = text.indexOf('>', i + 1);
      if (end !== -1) {
        const token = parseEscapeToken(text.substring(i + 1, end));
        if (token) {
          elements.push(token);
          i = end + 1;
          continue;
        }
      }
      // Unrecognized '<' falls through and is handled as a plain character.
    }

    // Bare URL (http/https) — stops at whitespace or '<'
    const urlMatch = /^https?:\/\/[^\s<]+/.exec(text.slice(i));
    if (urlMatch) {
      elements.push({ type: 'link', url: urlMatch[0] });
      i += urlMatch[0].length;
      continue;
    }

    let matched = false;

    for (const [marker, styleKey] of MARKERS) {
      if (text[i] !== marker) continue;

      // Look for the closing marker
      const end = text.indexOf(marker, i + 1);
      if (end === -1) continue;

      const inner = text.substring(i + 1, end);
      // Don't match empty content or content that starts/ends with space
      if (inner.length === 0 || inner.startsWith(' ') || inner.endsWith(' ')) continue;

      const style: RichTextStyle = { [styleKey]: true };

      if (styleKey === 'code') {
        // Code spans don't nest
        elements.push({ type: 'text', text: inner, style });
      } else {
        // Recursively parse inner content for nested formatting.
        // Non-text children (e.g. a link inside *...*) are pushed unchanged.
        const innerElements = parseInline(inner);
        for (const el of innerElements) {
          if (el.type === 'text') {
            const mergedStyle = { ...el.style, [styleKey]: true };
            elements.push({ type: 'text', text: el.text, style: mergedStyle });
          } else {
            elements.push(el);
          }
        }
      }

      i = end + 1;
      matched = true;
      break;
    }

    if (matched) continue;

    // Plain character: append to last plain text element or create a new one.
    // The `last.type === 'text'` guard is load-bearing: non-text elements have
    // no `style`, so without it the char would be appended onto a mention/link.
    const last = elements[elements.length - 1];
    if (last && last.type === 'text' && !last.style) {
      last.text += text[i];
    } else {
      elements.push({ type: 'text', text: text[i] });
    }
    i++;
  }

  // Clean up: remove empty style objects
  return elements.map(el => {
    if (el.type === 'text' && el.style && Object.keys(el.style).length === 0) {
      const { style, ...rest } = el;
      return rest as RichTextElement;
    }
    return el;
  });
}

// Bullet (`- `/`* `) and ordered (`1. `/`1) `) list lines. Capture group 1 is the
// leading whitespace (used to derive nesting indent), group 2 the item content.
const BULLET_LINE = /^(\s*)[-*]\s+(.*)$/;
const ORDERED_LINE = /^(\s*)\d+[.)]\s+(.*)$/;

// Two leading spaces (or a tab) = one indent level.
function indentLevel(leading: string): number {
  return Math.floor(leading.replace(/\t/g, '  ').length / 2);
}

function toSection(content: string): RichTextSection {
  const els = parseInline(content);
  return {
    type: 'rich_text_section',
    elements: els.length > 0 ? els : [{ type: 'text', text: '' }],
  };
}

export function parseMrkdwn(text: string): RichTextBlock[] {
  // A rich_text block's `elements` is a sequence of `rich_text_section` (prose) and
  // `rich_text_list` (native bullet/numbered lists). Consecutive `- `/`* ` lines become
  // one bullet list; `1.`/`1)` lines become one ordered list; a change of style or indent
  // starts a new list block. Runs of non-list lines collapse into a single section with
  // their newlines embedded — Slack renders that inline, matching the prior behaviour and
  // keeping plain multi-line messages unchanged.
  const lines = text.split('\n');
  const blockElements: RichTextBlockElement[] = [];

  let plainBuffer: string[] = [];
  let listStyle: 'bullet' | 'ordered' | null = null;
  let listIndent = 0;
  let listItems: RichTextSection[] = [];

  const flushPlain = (): void => {
    if (plainBuffer.length === 0) return;
    blockElements.push(toSection(plainBuffer.join('\n')));
    plainBuffer = [];
  };

  const flushList = (): void => {
    if (listStyle === null) return;
    blockElements.push({
      type: 'rich_text_list',
      style: listStyle,
      indent: listIndent,
      border: 0,
      elements: listItems,
    });
    listStyle = null;
    listIndent = 0;
    listItems = [];
  };

  for (const line of lines) {
    const bullet = BULLET_LINE.exec(line);
    const ordered = bullet ? null : ORDERED_LINE.exec(line);
    const match = bullet ?? ordered;

    if (match) {
      const style: 'bullet' | 'ordered' = bullet ? 'bullet' : 'ordered';
      const indent = indentLevel(match[1]);

      flushPlain();
      if (listStyle !== null && (listStyle !== style || listIndent !== indent)) {
        flushList();
      }
      listStyle = style;
      listIndent = indent;
      listItems.push(toSection(match[2]));
    } else {
      flushList();
      plainBuffer.push(line);
    }
  }

  flushPlain();
  flushList();

  if (blockElements.length === 0) {
    blockElements.push({ type: 'rich_text_section', elements: [{ type: 'text', text: '' }] });
  }

  return [{ type: 'rich_text', elements: blockElements }];
}
