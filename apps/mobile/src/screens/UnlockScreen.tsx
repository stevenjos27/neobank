import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth/AuthProvider';
import type { UnlockOutcome } from '../auth/device-auth';

/** What to tell the user after a prompt that did not unlock. */
export function unlockMessage(outcome: UnlockOutcome | null): string | null {
  switch (outcome) {
    case 'failed':
      return "Couldn't confirm it's you. Try again.";
    case 'locked_out':
      return 'Too many attempts. Sign in with your password.';
    case 'unavailable':
      return 'Quick unlock needs a screen lock on this device. Sign in with your password.';
    default:
      return null; // unlocked, cancelled (the user chose to), or no attempt yet
  }
}

/**
 * Shown when a live session exists but the app is locked: on launch,
 * and after 5+ minutes in the background. Prompts once on arrival; after
 * that, only when the user taps. No navigation here: a successful unlock
 * flips the provider's lock and the router moves to Home.
 */
export default function UnlockScreen() {
  const { unlock, signOut } = useAuth();
  // Starts true: the screen prompts the moment it appears.
  const [prompting, setPrompting] = useState(true);
  const [outcome, setOutcome] = useState<UnlockOutcome | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const runPrompt = useCallback(async () => {
    const result = await unlock();
    setOutcome(result === 'unlocked' ? null : result);
    setPrompting(false);
  }, [unlock]);

  useEffect(() => {
    void runPrompt();
  }, [runPrompt]);

  function onUnlockPress() {
    setPrompting(true);
    setOutcome(null);
    void runPrompt();
  }

  async function onUsePassword() {
    setSigningOut(true);
    try {
      await signOut(); // ends this session; the router moves to Login
    } finally {
      setSigningOut(false);
    }
  }

  const needsPassword = outcome === 'locked_out' || outcome === 'unavailable';
  const message = unlockMessage(outcome);
  const busy = prompting || signingOut;

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.body}>
        <Text style={styles.title} accessibilityRole="header">
          NeoBank is locked
        </Text>
        <Text style={styles.subtitle}>
          Unlock with Face ID, fingerprint or your device passcode.
        </Text>
        {message !== null && (
          <Text
            style={styles.error}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
          >
            {message}
          </Text>
        )}
      </View>

      {needsPassword ? (
        <Pressable
          onPress={onUsePassword}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy: signingOut }}
          style={({ pressed }) => [
            styles.button,
            (pressed || busy) && styles.buttonDimmed,
          ]}
        >
          <Text style={styles.buttonText}>Sign in with password</Text>
        </Pressable>
      ) : (
        <>
          <Pressable
            onPress={onUnlockPress}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy, busy: prompting }}
            style={({ pressed }) => [
              styles.button,
              (pressed || busy) && styles.buttonDimmed,
            ]}
          >
            {prompting ? (
              <ActivityIndicator
                color="#FFFFFF"
                accessibilityLabel="Waiting for unlock"
              />
            ) : (
              <Text style={styles.buttonText}>Unlock</Text>
            )}
          </Pressable>
          <Pressable
            onPress={onUsePassword}
            disabled={busy}
            accessibilityRole="button"
            accessibilityState={{ disabled: busy, busy: signingOut }}
            style={styles.linkButton}
          >
            <Text style={styles.linkText}>Use password instead</Text>
          </Pressable>
        </>
      )}
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
  subtitle: { fontSize: 16, lineHeight: 22, color: '#4B5563' },
  error: { fontSize: 14, color: '#B91C1C' },
  button: {
    height: 52,
    borderRadius: 12,
    backgroundColor: '#1D4ED8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDimmed: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  linkButton: {
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  linkText: { color: '#1D4ED8', fontSize: 16, fontWeight: '500' },
});
