import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatPaise } from '@neobank/utils';
import { runDecoderChecks, visible } from './decoder-check';
import type { DecoderCheck } from './decoder-check';
import { runFrameCheck } from './frames-check';

/**
 * Device diagnostics for Phase 4's foundation steps.
 *
 * 0a — does the SHARED money formatter produce, on Hermes, the exact strings
 * it produces on Node? Cases copied verbatim from libs/utils/src/lib/money.spec.ts.
 * Its first run found Hermes rejecting BigInt in Intl (0/9 on both platforms);
 * formatPaise no longer uses Intl.
 *
 * 0b — does the stream decoder keep a split ₹ intact (decoder-check.ts), and
 * does the SHARED parser from @neobank/contracts read real frames delivered
 * one byte at a time (frames-check.ts)?
 *
 * Temporary. Replaced by the real app in Step 2.
 */

type Case = { label: string; input: string | bigint; expected: string };

const CASES: Case[] = [
  // money.spec.ts — "formatPaise"
  { label: 'whole rupees', input: '500000', expected: '₹5,000.00' },
  { label: 'zero', input: '0', expected: '₹0.00' },
  { label: 'single-digit paise', input: '1', expected: '₹0.01' },
  { label: 'Indian grouping', input: '123456789', expected: '₹12,34,567.89' },
  {
    label: 'beyond MAX_SAFE_INTEGER',
    input: '900719925474099100',
    expected: '₹9,00,71,99,25,47,40,991.00',
  },
  { label: 'bigint input', input: 500000n, expected: '₹5,000.00' },
  { label: 'negative', input: -12345n, expected: '-₹123.45' },
  { label: 'negative under ₹1', input: -45n, expected: '-₹0.45' },
  { label: 'negative string', input: '-500000', expected: '-₹5,000.00' },
  // money.spec.ts — "Indian grouping boundaries"
  { label: 'paise trailing zero', input: '10', expected: '₹0.10' },
  { label: '3 digits', input: '99900', expected: '₹999.00' },
  { label: '4 digits', input: '100000', expected: '₹1,000.00' },
  { label: '5 digits', input: '1000000', expected: '₹10,000.00' },
  { label: '6 digits (lakh)', input: '10000000', expected: '₹1,00,000.00' },
  { label: '7 digits', input: '100000000', expected: '₹10,00,000.00' },
  {
    label: '8 digits (crore)',
    input: '1000000000',
    expected: '₹1,00,00,000.00',
  },
  { label: 'negative lakh', input: '-10000000', expected: '-₹1,00,000.00' },
];

type Result = Case & { actual: string; pass: boolean };

/**
 * A throw is a RESULT, not a crash, so one bad case cannot red-screen the
 * rest of the evidence away.
 */
function run(c: Case): Result {
  let actual: string;
  try {
    actual = formatPaise(c.input);
  } catch (e) {
    actual = `THREW: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { ...c, actual, pass: actual === c.expected };
}

const RESULTS = CASES.map(run);
const PASSED = RESULTS.filter((r) => r.pass).length;
const ENGINE =
  (globalThis as { HermesInternal?: unknown }).HermesInternal != null
    ? 'Hermes'
    : 'NOT Hermes';

const DECODER = runDecoderChecks();
const DECODER_PASSED = DECODER.checks.filter((c) => c.pass).length;

console.log(
  `[0a] formatPaise on ${Platform.OS}/${ENGINE}: ${PASSED}/${RESULTS.length} passed`,
);
for (const r of RESULTS.filter((x) => !x.pass)) {
  console.log(
    `[0a] FAIL ${r.label}: expected ${visible(r.expected)} got ${visible(r.actual)}`,
  );
}

console.log(
  `[0b] TextDecoder on ${Platform.OS}/${ENGINE} (${DECODER.implementation}): ` +
    `${DECODER_PASSED}/${DECODER.checks.length} passed`,
);
for (const c of DECODER.checks) {
  console.log(`[0b] ${c.pass ? 'ok  ' : 'FAIL'} ${c.label}: ${c.detail}`);
}

export default function App() {
  // The frame check is async (readFrames awaits each read), so it cannot run
  // at module scope like the others. null until it settles.
  const [frames, setFrames] = useState<DecoderCheck | null>(null);

  useEffect(() => {
    // Guards against setting state after unmount: the check is a promise that
    // can settle after the component is gone (a fast reload, or a test that
    // has already finished).
    let mounted = true;
    runFrameCheck().then((check) => {
      console.log(
        `[0b] readFrames on ${Platform.OS}/${ENGINE}: ` +
          `${check.pass ? 'ok' : 'FAIL'} — ${check.detail}`,
      );
      if (mounted) setFrames(check);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <Text style={styles.title}>
        formatPaise · {Platform.OS} · {ENGINE}
      </Text>
      <Text style={PASSED === RESULTS.length ? styles.ok : styles.bad}>
        {PASSED}/{RESULTS.length} match Node
      </Text>
      {RESULTS.map((r) => (
        <View key={r.label} style={styles.row}>
          <Text style={r.pass ? styles.ok : styles.bad}>
            {r.pass ? 'PASS' : 'FAIL'} · {r.label}
          </Text>
          <Text style={styles.mono}>expected {visible(r.expected)}</Text>
          <Text style={styles.mono}>actual {visible(r.actual)}</Text>
        </View>
      ))}

      <Text style={[styles.title, styles.section]}>
        TextDecoder · {DECODER.implementation}
      </Text>
      <Text
        style={
          DECODER_PASSED === DECODER.checks.length ? styles.ok : styles.bad
        }
      >
        {DECODER_PASSED}/{DECODER.checks.length} decoder checks
      </Text>
      {DECODER.checks.map((c) => (
        <View key={c.label} style={styles.row}>
          {/* ✓ / ✗, not PASS / FAIL: App.test.tsx counts exactly seventeen
              "PASS · " rows for the money checks, and these must not be
              mistaken for them. */}
          <Text style={c.pass ? styles.ok : styles.bad}>
            {c.pass ? '✓' : '✗'} {c.label}
          </Text>
          <Text style={styles.mono}>{c.detail}</Text>
        </View>
      ))}

      <Text style={[styles.title, styles.section]}>
        @neobank/contracts · readFrames
      </Text>
      <View style={styles.row}>
        {frames === null ? (
          <Text style={styles.mono}>running…</Text>
        ) : (
          <>
            <Text style={frames.pass ? styles.ok : styles.bad}>
              {frames.pass ? '✓' : '✗'} {frames.label}
            </Text>
            <Text style={styles.mono}>{frames.detail}</Text>
          </>
        )}
      </View>

      <StatusBar style="dark" />
    </ScrollView>
  );
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

// Every colour is explicit. Expo Go renders a dark background, and any Text
// without a colour defaults to black on black.
const INK = '#111827';
const PAPER = '#ffffff';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: PAPER },
  container: { paddingTop: 64, paddingHorizontal: 16, paddingBottom: 32 },
  title: { color: INK, fontSize: 18, fontWeight: '600', marginBottom: 4 },
  section: { marginTop: 32 },
  row: { marginTop: 12 },
  ok: { color: '#15803d', fontWeight: '600' },
  bad: { color: '#b91c1c', fontWeight: '600' },
  mono: { color: INK, fontFamily: mono, fontSize: 13 },
});
