'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AskSource, askStream } from '@/lib/ask-stream';

/**
 * Honest progress, derived from the tool the model actually called rather
 * than from a spinner. The wait IS the tool call, so naming it is the most
 * truthful thing that can fill the gap.
 */
const TOOL_LABEL: Record<string, string> = {
  search_knowledge: 'Searching the published documents',
  spend_by_category: 'Looking up your spending',
};

/**
 * The third one is deliberate: NeoBank publishes nothing about branches, so
 * the assistant declines it. Offering a question it will refuse shows the
 * grounding as part of the product rather than hiding it — and it is the
 * behaviour a reviewer should see on their first click.
 */
const SUGGESTIONS = [
  'How much did I spend last month?',
  "Is there a charge for using another bank's ATM?",
  'What time does your Mumbai branch open on Saturdays?',
];

type Turn = {
  question: string;
  /** Text published so far, replaced wholesale by the `done` frame. */
  answer: string;
  sources: AskSource[];
  /** Tool names in the order they ran. */
  tools: string[];
  status: 'streaming' | 'done' | 'withheld' | 'error';
  error?: string;
};

export function AssistantChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // Leaving the page mid-answer should stop the reader. It does not stop the
  // model call — that needs an AbortSignal threaded through the API, which is
  // a logged gap — so the question still costs what it costs.
  useEffect(() => () => abort.current?.abort(), []);

  const patchLast = (change: (turn: Turn) => Turn) =>
    setTurns((all) =>
      all.map((turn, i) => (i === all.length - 1 ? change(turn) : turn)),
    );

  const ask = async (text: string) => {
    const trimmed = text.trim();
    if (trimmed === '' || busy) return;

    setQuestion('');
    setBusy(true);
    setTurns((all) => [
      ...all,
      {
        question: trimmed,
        answer: '',
        sources: [],
        tools: [],
        status: 'streaming',
      },
    ]);

    const controller = new AbortController();
    abort.current = controller;

    try {
      for await (const event of askStream(trimmed, controller.signal)) {
        switch (event.type) {
          case 'tool':
            patchLast((turn) => ({
              ...turn,
              tools: [...turn.tools, event.name],
            }));
            break;

          case 'delta':
            patchLast((turn) => ({
              ...turn,
              answer: turn.answer + event.text,
            }));
            break;

          case 'reset':
            // A round wrote text and then called a tool. What was published is
            // not part of the answer, so it goes.
            patchLast((turn) => ({ ...turn, answer: '' }));
            break;

          case 'withheld':
            // Whole-answer suppression. Clearing here matters: the customer
            // must not be left reading text the server has just retracted.
            patchLast((turn) => ({ ...turn, answer: '', status: 'withheld' }));
            break;

          case 'done':
            // The server's text REPLACES the accumulated deltas rather than
            // being compared with them. In the withheld case the two differ by
            // design, and the server's version is the one safe to display.
            patchLast((turn) => ({
              ...turn,
              answer: event.answer,
              sources: event.sources,
              status: turn.status === 'withheld' ? 'withheld' : 'done',
            }));
            break;

          case 'error':
            patchLast((turn) => ({
              ...turn,
              status: 'error',
              error: event.message,
            }));
            break;
        }
      }
    } catch {
      // An aborted read lands here on unmount. There is no one left to tell.
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <div className="space-y-6">
      {turns.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Ask about your own transactions, or about NeoBank&apos;s published
          policies. Answers about money quote figures from your account, and
          cite the document they came from.
        </p>
      )}

      <ul className="space-y-6">
        {turns.map((turn, index) => (
          <li key={index} className="space-y-2">
            <p className="font-medium">{turn.question}</p>

            {/*
              The tool trace stays up for the WHOLE turn, not just while the
              answer is empty. Gated on an empty answer it showed for under a
              second — the informative line covering the shortest part of the
              wait and "Thinking…" the longest. Left up, it stops being a
              spinner substitute and becomes provenance: a record of what the
              assistant actually did, sitting beside the sources it cited.
            */}
            {turn.tools.length > 0 && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {turn.tools.map((name, i) => (
                  <li key={i}>{TOOL_LABEL[name] ?? name}</li>
                ))}
              </ul>
            )}

            {turn.status === 'streaming' &&
              turn.tools.length === 0 &&
              turn.answer === '' && (
                <p className="text-sm text-muted-foreground">Thinking…</p>
              )}

            {/*
              aria-live so a screen reader announces the answer as it arrives
              rather than only once the turn ends. aria-busy tells it the text
              is still growing, which stops it re-reading the whole answer on
              every token.
            */}
            <div
              aria-live="polite"
              aria-busy={turn.status === 'streaming'}
              className={
                turn.status === 'withheld'
                  ? 'rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm'
                  : turn.status === 'error'
                    ? 'text-sm text-destructive'
                    : 'whitespace-pre-wrap'
              }
            >
              {turn.status === 'error' ? turn.error : turn.answer}
              {turn.status === 'streaming' && turn.answer !== '' && (
                <span className="ml-0.5 animate-pulse">▍</span>
              )}
            </div>

            {turn.sources.length > 0 && (
              <p className="text-xs text-muted-foreground">
                From{' '}
                {turn.sources.map((source, i) => (
                  <span key={`${source.source}-${source.chunkIndex}`}>
                    {i > 0 && ', '}
                    <span className="font-medium">{source.heading}</span>
                  </span>
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          ask(question);
        }}
      >
        <Input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about your spending or our policies"
          aria-label="Your question"
          disabled={busy}
        />
        <Button type="submit" disabled={busy || question.trim() === ''}>
          {busy ? 'Asking…' : 'Ask'}
        </Button>
      </form>
      {/*
        Available for the whole session, not only an empty one. Gated on the
        first turn, there was no way to reach the other two without retyping
        them — including the one the assistant refuses, which is the most
        informative thing here to show anybody.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Try:</span>
        {SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion}
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => ask(suggestion)}
          >
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}
