import { readFrames } from '@neobank/contracts';
import type { AskEvent, ByteReader } from '@neobank/contracts';
import { utf8, visible } from './decoder-check';
import type { DecoderCheck } from './decoder-check';

/**
 * Phase 4, Step 0b: the SHARED stream parser, on Hermes.
 *
 * decoder-check.ts proved Hermes's TextDecoder (Expo's polyfill) survives a
 * split ₹. This proves the layer above it: the real `readFrames`, imported
 * through @neobank/contracts and resolved by Metro, parsing real SSE frames
 * delivered ONE BYTE PER READ — so every frame boundary and every byte of ₹
 * arrives in a separate chunk. It is the worst network the parser can meet.
 *
 * Async, unlike the other diagnostics, because readFrames is: it awaits each
 * read. The screen runs it in an effect and shows the row when it settles.
 */

/** What the API would send for one answer that quotes money. */
const EVENTS: AskEvent[] = [
  { type: 'tool', name: 'spend_by_category' },
  { type: 'delta', text: 'You spent ' },
  { type: 'delta', text: '₹57,011.90 in August 2026.' },
  { type: 'done', answer: 'You spent ₹57,011.90 in August 2026.', sources: [] },
];

/** The same events as bytes on the wire, built without TextEncoder. */
const WIRE = utf8(EVENTS.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));

/** A reader that hands out one byte per call, and counts the calls. */
function oneBytePerRead(bytes: Uint8Array): { reader: ByteReader; reads: () => number } {
  let next = 0;
  let calls = 0;
  const reader: ByteReader = {
    read: async () => {
      calls++;
      if (next >= bytes.length) return { done: true };
      const value = bytes.subarray(next, next + 1);
      next++;
      return { done: false, value };
    },
    releaseLock: () => undefined,
  };
  return { reader, reads: () => calls };
}

export async function runFrameCheck(): Promise<DecoderCheck> {
  const label = 'readFrames, one byte per read';
  try {
    const { reader, reads } = oneBytePerRead(WIRE);
    const got: AskEvent[] = [];
    for await (const event of readFrames(reader)) got.push(event);

    const pass = JSON.stringify(got) === JSON.stringify(EVENTS);
    const last = got[got.length - 1];
    const answer = last && last.type === 'done' ? last.answer : '(no done frame)';

    return {
      label,
      pass,
      // The read count is the evidence the split really happened: one read per
      // byte, plus the final one that reports `done`.
      detail: pass
        ? `${got.length}/${EVENTS.length} events in ${reads()} reads; answer: ${visible(answer)}`
        : `got ${got.length}/${EVENTS.length} events in ${reads()} reads: ${visible(JSON.stringify(got))}`,
    };
  } catch (e) {
    return { label, pass: false, detail: `THREW: ${e instanceof Error ? e.message : String(e)}` };
  }
}
