import { chunkMarkdown, MAX_CHUNK_CHARS } from './chunk-markdown';

const doc = (body: string) => chunkMarkdown('test.md', body);

describe('chunkMarkdown', () => {
  it('produces one chunk per ## section, in document order', () => {
    const chunks = doc(`# Title

## First
Body of first.

## Second
Body of second.
`);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.heading)).toEqual(['First', 'Second']);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1]);
  });

  it('drops everything before the first ## heading', () => {
    const chunks = doc(`# Title

This preamble is maintainer instructions and must never be embedded.

## Real section
Real content.
`);
    // If this ever fails, the retrieval corpus has grown a passage that can be
    // returned to a customer as if it were policy.
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).not.toContain('maintainer instructions');
  });

  it('embeds the heading together with the body', () => {
    const [chunk] = doc(`## Payee lookup limits
Limited to ten per minute.
`);

    // The body never names its own subject. Without the heading, "how many
    // payee lookups can I do?" has nothing to match on.
    expect(chunk.content).toBe('Payee lookup limits\n\nLimited to ten per minute.');
  });

  it('treats ### as part of the section, not a new chunk', () => {
    const chunks = doc(`## Parent
Intro.

### Child
Detail.
`);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toContain('### Child');
  });

  it('ignores horizontal rules', () => {
    const [chunk] = doc(`## Section
Before.

---

After.
`);

    expect(chunk.content).not.toContain('---');
    expect(chunk.content).toContain('Before.');
    expect(chunk.content).toContain('After.');
  });

  it('skips a heading with no body', () => {
    const chunks = doc(`## Empty

## Has content
Something.
`);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('Has content');
    // chunkIndex is positional over EMITTED chunks, so it stays gapless.
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it('throws on an oversized section, naming it', () => {
    const long = 'x'.repeat(MAX_CHUNK_CHARS + 1);

    // Auto-splitting would produce the orphaned fragment the document format
    // exists to prevent. Failing loudly puts the fix in the prose.
    expect(() => doc(`## Enormous\n${long}\n`)).toThrow(/Enormous/);
    expect(() => doc(`## Enormous\n${long}\n`)).toThrow(/test\.md/);
  });

  it('hashes content, so identical text hashes identically', () => {
    const [a] = doc('## Same\nIdentical body.\n');
    const [b] = chunkMarkdown('other.md', '## Same\nIdentical body.\n');

    // The hash covers content only, not the source file. That is what lets the
    // backfill skip re-embedding when a document is renamed or moved.
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('changes the hash when the body changes', () => {
    const [before] = doc('## Fees\nNo fees.\n');
    const [after] = doc('## Fees\nA small fee.\n');

    expect(before.contentHash).not.toBe(after.contentHash);
  });

  it('returns nothing for a document with no ## headings', () => {
    expect(doc('# Title\n\nJust prose, no sections.\n')).toEqual([]);
  });
});
