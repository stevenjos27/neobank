import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../auth/AuthProvider';

/**
 * Dev-only: exercises the auth client's silent refresh on a real device.
 * Home makes no API calls, so without this the refresh rules (single
 * flight, one retry) are only proven in unit tests.
 *
 * Renders nothing when debug is null, which is always the case in release.
 */
interface Probe {
  label: string;
  corrupt: boolean;
  parallel: number;
}

export const PROBES: readonly Probe[] = [
  { label: 'GET /accounts', corrupt: false, parallel: 1 },
  { label: 'Corrupt token, then GET /accounts', corrupt: true, parallel: 1 },
  { label: 'Corrupt token, then 3 parallel GETs', corrupt: true, parallel: 3 },
];

export default function AuthDebugPanel() {
  const { apiFetch, debug } = useAuth();
  const [results, setResults] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  if (!debug) return null;

  async function run(probe: Probe) {
    if (!debug) return;
    setRunning(true);
    const before = debug.refreshCount();
    if (probe.corrupt) debug.corruptAccessToken();

    let line: string;
    try {
      const statuses = await Promise.all(
        Array.from(
          { length: probe.parallel },
          async () => (await apiFetch('/accounts')).status,
        ),
      );
      const refreshes = debug.refreshCount() - before;
      line = `${probe.label}: HTTP ${statuses.join(', ')} · refreshes +${refreshes}`;
    } catch (error) {
      line = `${probe.label}: ${error instanceof Error ? error.name : 'error'}`;
    }
    setResults((previous) => [line, ...previous].slice(0, 6));
    setRunning(false);
  }

  return (
    <View style={styles.panel}>
      <Text style={styles.title} accessibilityRole="header">
        Auth (dev only)
      </Text>
      {PROBES.map((probe) => (
        <Pressable
          key={probe.label}
          onPress={() => void run(probe)}
          disabled={running}
          accessibilityRole="button"
          accessibilityState={{ disabled: running }}
          style={({ pressed }) => [
            styles.button,
            (pressed || running) && styles.buttonDimmed,
          ]}
        >
          <Text style={styles.buttonText}>{probe.label}</Text>
        </Pressable>
      ))}
      {results.map((result, index) => (
        <Text key={`${index}-${result}`} style={styles.result}>
          {result}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { marginTop: 24, gap: 8 },
  title: { fontSize: 18, fontWeight: '600', color: '#111827' },
  button: {
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  buttonDimmed: { opacity: 0.6 },
  buttonText: { fontSize: 15, color: '#1D4ED8', fontWeight: '500' },
  result: { fontFamily: 'monospace', fontSize: 12, color: '#374151' },
});
