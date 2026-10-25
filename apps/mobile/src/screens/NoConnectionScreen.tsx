import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth/AuthProvider';

/**
 * Launch only: there is a stored session, but the server could not be
 * reached to confirm it, so we cannot yet tell Unlock from Login.
 * Nothing was cleared. Retry runs the same restore as launch; on success
 * the provider's status changes and the router moves on by itself.
 */
export default function NoConnectionScreen() {
  const { retry } = useAuth();
  const [retrying, setRetrying] = useState(false);

  async function onRetry() {
    setRetrying(true);
    try {
      await retry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.body}>
        <Text style={styles.title} accessibilityRole="header">
          Can't reach NeoBank
        </Text>
        <Text style={styles.message}>
          Check your internet connection and try again. You’re still signed in.
        </Text>
      </View>

      <Pressable
        onPress={onRetry}
        disabled={retrying}
        accessibilityRole="button"
        accessibilityState={{ disabled: retrying, busy: retrying }}
        style={({ pressed }) => [
          styles.button,
          (pressed || retrying) && styles.buttonDimmed,
        ]}
      >
        {retrying ? (
          <ActivityIndicator color="#FFFFFF" accessibilityLabel="Retrying" />
        ) : (
          <Text style={styles.buttonText}>Try again</Text>
        )}
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 24,
    paddingBottom: 24,
  },
  body: { flex: 1, justifyContent: 'center', gap: 12 },
  title: { fontSize: 24, fontWeight: '600', color: '#111827' },
  message: { fontSize: 16, lineHeight: 22, color: '#4B5563' },
  button: {
    height: 52,
    borderRadius: 12,
    backgroundColor: '#1D4ED8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDimmed: { opacity: 0.7 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
