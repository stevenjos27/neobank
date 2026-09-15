import { createHash } from "node:crypto";

export type MarkdownChunk = {
  source: string;
  heading: string;
  /** Heading + body. This exact string is what gets embedded and cited. */
  content: string;
  chunkIndex: number;
  /** sha256 of `content` — lets the backfill skip chunks whose text is unchanged. */
  contentHash: string;
};

/**
 * A section longer than this is a content problem, not a chunking problem.
 * ~2000 characters is roughly 500 tokens: comfortably inside the embedding
 * model's window, and about as much text as can be *about one thing*.
 */
export const MAX_CHUNK_CHARS = 2000;

/**
 * Split a knowledge-base document into one chunk per `##` section.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. No sliding-window overlap. Overlap exists to stop a fixed-size splitter
 *    cutting an idea in half. Our boundaries are already semantic — each `##`
 *    section is written to stand alone — so overlap would only duplicate text
 *    across chunks, making the same passage win retrieval twice.
 *
 * 2. No automatic splitting of oversized sections. Cutting a hand-written,
 *    self-contained section in half produces exactly the orphaned fragment
 *    the document was written to avoid ("this limit also applies to..." with
 *    no antecedent). We throw instead, naming the section, so the fix happens
 *    in the prose where it belongs.
 */
export function chunkMarkdown(source: string, markdown: string): MarkdownChunk[] {
  const lines = markdown.split('\n');
  const chunks: MarkdownChunk[] = [];

  let heading: string | null = null;
  let body: string[] = [];

  const flush = () => {
    // Everything before the first `##` is skipped. In our FAQ that preamble
    // is instructions to whoever maintains the document — embedding it would
    // put "this document is the assistant's source of truth" into the
    // retrieval corpus, where it can be returned as an answer to a customer.
    if (heading === null) return;

    const text = body.join('\n').trim();
    if (!text) return;

    // The heading carries meaning the body often omits: "Payee lookup limits"
    // followed by "...is limited to ten per minute". Embedding them together
    // is what lets "how many payee lookups can I do?" match this section.
    const content = `${heading}\n\n${text}`;

    if (content.length > MAX_CHUNK_CHARS) {
      throw new Error(
        `Section "${heading}" in ${source} is ${content.length} characters ` +
        `(max ${MAX_CHUNK_CHARS}). Split it into two sections, each about ` +
        `one thing and each readable on its own.`,
      );
    }

    chunks.push({
      source,
      heading,
      content,
      chunkIndex: chunks.length,
      contentHash: createHash('sha256').update(content).digest('hex'),
    });
  };

  for (const line of lines) {
    // `## ` only — `#` is the document title and `###` would be a subsection
    // of the section we are already accumulating.
    if (line.startsWith('## ')) {
      flush();
      heading = line.slice(3).trim();
      body = [];
      continue;
    }

    //Horizontal roles are layout, not content.
    if (line.trim() === '---') continue;

    if (heading !== null) body.push(line);
  }

  flush();
  return chunks;
}
