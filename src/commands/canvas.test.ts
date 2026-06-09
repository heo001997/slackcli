import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCanvasCommand,
  buildCreateParams,
  resolveCanvasMarkdown,
  buildEditChange,
  buildSectionCriteria,
  resolveMarkdown,
  resolveCreatePosition,
  extractSection,
  VALID_EDIT_OPERATIONS,
} from './canvas.ts';

describe('buildCreateParams', () => {
  it('returns empty params when nothing is provided', () => {
    expect(buildCreateParams({})).toEqual({});
  });

  it('includes only the title when no markdown or channel', () => {
    expect(buildCreateParams({ title: 'Sprint Notes' })).toEqual({ title: 'Sprint Notes' });
  });

  it('wraps markdown into a JSON-stringified document_content', () => {
    const params = buildCreateParams({ markdown: '# Hello' });
    expect(params.document_content).toBe(JSON.stringify({ type: 'markdown', markdown: '# Hello' }));
    expect(params.title).toBeUndefined();
  });

  it('maps channel to channel_id', () => {
    expect(buildCreateParams({ channel: 'C123' })).toEqual({ channel_id: 'C123' });
  });

  it('combines title, markdown, and channel', () => {
    const params = buildCreateParams({ title: 'T', markdown: 'body', channel: 'C9' });
    expect(params.title).toBe('T');
    expect(params.channel_id).toBe('C9');
    expect(params.document_content).toBe(JSON.stringify({ type: 'markdown', markdown: 'body' }));
  });

  it('omits empty-string markdown', () => {
    expect(buildCreateParams({ markdown: '' })).toEqual({});
  });
});

describe('resolveCanvasMarkdown', () => {
  it('returns undefined when no source is provided', async () => {
    expect(await resolveCanvasMarkdown({})).toBeUndefined();
  });

  it('returns inline content', async () => {
    expect(await resolveCanvasMarkdown({ content: '# Inline' })).toBe('# Inline');
  });

  it('rejects when more than one source is provided', async () => {
    await expect(resolveCanvasMarkdown({ content: 'a', file: 'b.md' })).rejects.toThrow(
      'Use only one of --content, --file, or --stdin',
    );
  });

  it('rejects content + stdin together', async () => {
    await expect(resolveCanvasMarkdown({ content: 'a', stdin: true })).rejects.toThrow(
      'Use only one of',
    );
  });

  it('reads markdown from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canvas-test-'));
    const path = join(dir, 'doc.md');
    await writeFile(path, '# From file\n- item');
    try {
      expect(await resolveCanvasMarkdown({ file: path })).toBe('# From file\n- item');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws a clear error for a missing file', async () => {
    const path = join(tmpdir(), 'canvas-test-does-not-exist-xyz.md');
    await expect(resolveCanvasMarkdown({ file: path })).rejects.toThrow(`File not found: ${path}`);
  });
});

describe('canvas command', () => {
  it('exposes edit and sections subcommands', () => {
    const canvas = createCanvasCommand();
    const names = canvas.commands.map((c) => c.name());
    expect(names).toContain('edit');
    expect(names).toContain('sections');
  });

  it('exposes the operation and section options on edit', () => {
    const canvas = createCanvasCommand();
    const edit = canvas.commands.find((c) => c.name() === 'edit');
    expect(edit?.options.some((o) => o.long === '--operation')).toBe(true);
    expect(edit?.options.some((o) => o.long === '--section')).toBe(true);
    expect(edit?.options.some((o) => o.long === '--stdin')).toBe(true);
  });
});

describe('buildEditChange', () => {
  it('builds insert_at_end with document_content and no section', () => {
    const change = buildEditChange('insert_at_end', '## Update', undefined);
    expect(change).toEqual({
      operation: 'insert_at_end',
      document_content: { type: 'markdown', markdown: '## Update' },
    });
  });

  it('builds insert_at_start with document_content', () => {
    const change = buildEditChange('insert_at_start', '# Top', undefined);
    expect(change.operation).toBe('insert_at_start');
    expect(change.document_content).toEqual({ type: 'markdown', markdown: '# Top' });
    expect(change.section_id).toBeUndefined();
  });

  it('builds insert_after with content and section', () => {
    const change = buildEditChange('insert_after', '- item', 'temp:C:abc');
    expect(change).toEqual({
      operation: 'insert_after',
      document_content: { type: 'markdown', markdown: '- item' },
      section_id: 'temp:C:abc',
    });
  });

  it('builds insert_before with content and section', () => {
    const change = buildEditChange('insert_before', 'before', 'temp:C:xyz');
    expect(change.operation).toBe('insert_before');
    expect(change.section_id).toBe('temp:C:xyz');
  });

  it('builds replace without a section (whole canvas)', () => {
    const change = buildEditChange('replace', 'new body', undefined);
    expect(change).toEqual({
      operation: 'replace',
      document_content: { type: 'markdown', markdown: 'new body' },
    });
  });

  it('builds replace with a section', () => {
    const change = buildEditChange('replace', 'new section', 'temp:C:sec');
    expect(change.section_id).toBe('temp:C:sec');
    expect(change.document_content).toEqual({ type: 'markdown', markdown: 'new section' });
  });

  it('builds delete with only a section_id', () => {
    const change = buildEditChange('delete', undefined, 'temp:C:gone');
    expect(change).toEqual({ operation: 'delete', section_id: 'temp:C:gone' });
    expect(change.document_content).toBeUndefined();
  });

  it('throws when a content operation has no content', () => {
    expect(() => buildEditChange('insert_at_end', undefined, undefined)).toThrow(/requires content/);
  });

  it('throws when insert_after has no section', () => {
    expect(() => buildEditChange('insert_after', 'x', undefined)).toThrow(/requires --section/);
  });

  it('throws when insert_at_start is given a section', () => {
    expect(() => buildEditChange('insert_at_start', 'x', 'temp:C:abc')).toThrow(/does not accept --section/);
  });

  it('throws when delete is given content', () => {
    expect(() => buildEditChange('delete', 'oops', 'temp:C:abc')).toThrow(/does not accept content/);
  });

  it('throws when delete has no section', () => {
    expect(() => buildEditChange('delete', undefined, undefined)).toThrow(/requires --section/);
  });

  it('lists exactly seven valid operations including rename', () => {
    expect(VALID_EDIT_OPERATIONS).toEqual([
      'insert_at_start',
      'insert_at_end',
      'insert_after',
      'insert_before',
      'replace',
      'delete',
      'rename',
    ]);
  });

  it('builds rename with title_content and no section', () => {
    const change = buildEditChange('rename', 'New Title', undefined);
    expect(change).toEqual({
      operation: 'rename',
      title_content: { type: 'markdown', markdown: 'New Title' },
    });
    expect(change.document_content).toBeUndefined();
    expect(change.section_id).toBeUndefined();
  });

  it('throws when rename has no content', () => {
    expect(() => buildEditChange('rename', undefined, undefined)).toThrow(/requires content/);
  });

  it('throws when rename is given a section', () => {
    expect(() => buildEditChange('rename', 'New Title', 'temp:C:abc')).toThrow(/does not accept --section/);
  });
});

describe('buildSectionCriteria', () => {
  it('maps --type to section_types array', () => {
    expect(buildSectionCriteria({ type: 'h2' })).toEqual({ section_types: ['h2'] });
  });

  it('maps --contains to contains_text', () => {
    expect(buildSectionCriteria({ contains: 'Action Items' })).toEqual({ contains_text: 'Action Items' });
  });

  it('maps both type and contains', () => {
    expect(buildSectionCriteria({ type: 'any_header', contains: 'Notes' })).toEqual({
      section_types: ['any_header'],
      contains_text: 'Notes',
    });
  });

  it('defaults to any_header when no filters are given (Slack rejects empty criteria)', () => {
    expect(buildSectionCriteria({})).toEqual({ section_types: ['any_header'] });
  });
});

describe('resolveMarkdown', () => {
  it('returns inline content from --content', async () => {
    expect(await resolveMarkdown({ content: '# Hi' })).toBe('# Hi');
  });

  it('returns undefined when no source is given', async () => {
    expect(await resolveMarkdown({})).toBeUndefined();
  });

  it('throws when more than one source is supplied', async () => {
    await expect(resolveMarkdown({ content: 'a', file: 'b.md' })).rejects.toThrow(/only one of/);
  });

  it('throws a clear error for a missing file', async () => {
    await expect(resolveMarkdown({ file: '/no/such/file-xyz.md' })).rejects.toThrow(/File not found/);
  });

  it('reads markdown from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canvas-test-'));
    const path = join(dir, 'body.md');
    await writeFile(path, '# From file\n- bullet', 'utf-8');
    try {
      expect(await resolveMarkdown({ file: path })).toBe('# From file\n- bullet');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('canvas delete command', () => {
  it('registers a delete subcommand', () => {
    const canvas = createCanvasCommand();
    const del = canvas.commands.find((command) => command.name() === 'delete');

    expect(del).toBeDefined();
  });

  it('exposes a --yes flag on canvas delete', () => {
    const canvas = createCanvasCommand();
    const del = canvas.commands.find((command) => command.name() === 'delete');

    expect(del?.options.some((option) => option.long === '--yes')).toBe(true);
  });

  it('exposes a --json flag on canvas delete', () => {
    const canvas = createCanvasCommand();
    const del = canvas.commands.find((command) => command.name() === 'delete');

    expect(del?.options.some((option) => option.long === '--json')).toBe(true);
  });
});

describe('resolveCreatePosition', () => {
  it('maps --at-start to insert_at_start', () => {
    expect(resolveCreatePosition({ atStart: true })).toEqual({ operation: 'insert_at_start' });
  });

  it('maps --at-end to insert_at_end', () => {
    expect(resolveCreatePosition({ atEnd: true })).toEqual({ operation: 'insert_at_end' });
  });

  it('maps --after to insert_after with the section id', () => {
    expect(resolveCreatePosition({ after: 'temp:C:abc' })).toEqual({
      operation: 'insert_after',
      sectionId: 'temp:C:abc',
    });
  });

  it('maps --before to insert_before with the section id', () => {
    expect(resolveCreatePosition({ before: 'temp:C:xyz' })).toEqual({
      operation: 'insert_before',
      sectionId: 'temp:C:xyz',
    });
  });

  it('throws when no position flag is given', () => {
    expect(() => resolveCreatePosition({})).toThrow(/Specify one position/);
  });

  it('throws when more than one position flag is given', () => {
    expect(() => resolveCreatePosition({ atStart: true, atEnd: true })).toThrow(/only one of/);
  });
});

describe('extractSection', () => {
  it('matches a heading exactly (case-insensitive) and returns its body', () => {
    const md = '# Notes\nfirst line\n# Notes Extra\nignored';
    const section = extractSection(md, 'notes');
    expect(section.heading).toBe('Notes');
    expect(section.level).toBe(1);
    expect(section.body).toBe('first line');
  });

  it('matches by substring when there is no exact heading', () => {
    const md = '# Action Items\ndo the thing\n# Other\nelse';
    const section = extractSection(md, 'Action');
    expect(section.heading).toBe('Action Items');
    expect(section.body).toBe('do the thing');
  });

  it('includes nested subsections and stops at the next same-or-higher heading', () => {
    const md = '# Alpha\nintro\n## Sub\nsubbody\n# Beta\nlast';
    const section = extractSection(md, 'Alpha');
    expect(section.level).toBe(1);
    expect(section.body).toBe('intro\n## Sub\nsubbody');
  });

  it('stops a deeper heading at the next higher-level heading', () => {
    const md = '# Alpha\nintro\n## Sub\nsubbody\n# Beta\nlast';
    const section = extractSection(md, 'Sub');
    expect(section.level).toBe(2);
    expect(section.body).toBe('subbody');
  });

  it('throws and lists available headings when nothing matches', () => {
    expect(() => extractSection('# Alpha\nx\n# Beta\ny', 'Zeta')).toThrow(/No section heading matches/);
    expect(() => extractSection('# Alpha\nx\n# Beta\ny', 'Zeta')).toThrow(/"Alpha".*"Beta"/);
  });

  it('throws when a substring matches more than one heading', () => {
    expect(() => extractSection('# Foo One\na\n# Foo Two\nb', 'Foo')).toThrow(/matches 2 headings/);
  });
});

describe('canvas section command group', () => {
  it('registers the section group with create/read/update/delete/list', () => {
    const canvas = createCanvasCommand();
    const section = canvas.commands.find((c) => c.name() === 'section');
    expect(section).toBeDefined();
    const names = section!.commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(['create', 'read', 'update', 'delete', 'list']));
  });

  it('keeps the back-compat "sections" lookup command registered', () => {
    const canvas = createCanvasCommand();
    expect(canvas.commands.some((c) => c.name() === 'sections')).toBe(true);
  });

  it('exposes --after on section create', () => {
    const canvas = createCanvasCommand();
    const section = canvas.commands.find((c) => c.name() === 'section');
    const create = section!.commands.find((c) => c.name() === 'create');
    expect(create?.options.some((o) => o.long === '--after')).toBe(true);
    expect(create?.options.some((o) => o.long === '--at-end')).toBe(true);
  });

  it('exposes --contains on section read', () => {
    const canvas = createCanvasCommand();
    const section = canvas.commands.find((c) => c.name() === 'section');
    const read = section!.commands.find((c) => c.name() === 'read');
    expect(read?.options.some((o) => o.long === '--contains')).toBe(true);
  });

  it('exposes --yes on section delete', () => {
    const canvas = createCanvasCommand();
    const section = canvas.commands.find((c) => c.name() === 'section');
    const del = section!.commands.find((c) => c.name() === 'delete');
    expect(del?.options.some((o) => o.long === '--yes')).toBe(true);
  });
});
