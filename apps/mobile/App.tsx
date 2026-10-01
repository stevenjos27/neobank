import { StatusBar } from 'expo-status-bar';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatPaise } from '@neobank/utils';

/**
 * Phase 4, Step 0a: does the SHARED money formatter produce, on a phone, the
 * exact strings it produces on Node?
 *
 * The cases and expected strings are copied verbatim from
 * libs/utils/src/lib/money.spec.ts, both blocks. That spec runs on Node. On a
 * phone the code runs on Hermes, and a green Jest run cannot speak for it.
 *
 * This screen's first run found exactly that: Hermes throws "Cannot convert
 * BigInt to number" from Intl.NumberFormat, on iOS and Android, so all nine
 * cases failed. formatPaise no longer uses Intl. This run is the proof.
 *
 * Temporary. It is replaced by the real app in Step 2.
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

/**
 * Makes invisible differences visible: anything outside printable ASCII,
 * except ₹ itself, is printed as its code point.
 */
function visible(s: string): string {
  return Array.from(s)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      if ((cp >= 0x20 && cp <= 0x7e) || ch === '₹') return ch;
      return `\\u{${cp.toString(16)}}`;
    })
    .join('');
}

const RESULTS = CASES.map(run);
const PASSED = RESULTS.filter((r) => r.pass).length;
const ENGINE =
  (globalThis as { HermesInternal?: unknown }).HermesInternal != null
    ? 'Hermes'
    : 'NOT Hermes';

console.log(
  `[0a] formatPaise on ${Platform.OS}/${ENGINE}: ${PASSED}/${RESULTS.length} passed`,
);
for (const r of RESULTS.filter((x) => !x.pass)) {
  console.log(
    `[0a] FAIL ${r.label}: expected ${visible(r.expected)} got ${visible(r.actual)}`,
  );
}

export default function App() {
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
      <StatusBar style="dark" />
    </ScrollView>
  );
}

const mono = Platform.select({ ios: 'Menlo', default: 'monospace' });

// Every colour is explicit. The first run showed why: Expo Go rendered a dark
// background, and any Text without a colour defaulted to black on black.
const INK = '#111827';
const PAPER = '#ffffff';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: PAPER },
  container: { paddingTop: 64, paddingHorizontal: 16, paddingBottom: 32 },
  title: { color: INK, fontSize: 18, fontWeight: '600', marginBottom: 4 },
  row: { marginTop: 12 },
  ok: { color: '#15803d', fontWeight: '600' },
  bad: { color: '#b91c1c', fontWeight: '600' },
  mono: { color: INK, fontFamily: mono, fontSize: 13 },
});
