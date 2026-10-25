import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useAuth } from '../auth/AuthProvider';

/**
 * Signed in and unlocked. Step 2 placeholder: the accounts dashboard
 * replaces the body in Step 3. Sign out needs no navigation: the provider
 * goes to signedOut and the router's guards move to Login.
 */
export default function HomeScreen() {
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  async function onSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.body}>
        <Text style={styles.title} accessibilityRole="header">
          NeoBank
        </Text>
        <Text style={styles.subtitle}>
          You’re signed in. Your accounts will appear here.
        </Text>
        {__DEV__ && (
          <Pressable
            onPress={() => router.push('/diagnostics')}
            accessibilityRole="button"
            style={styles.linkButton}
          >
            <Text style={styles.linkText}>Diagnostics (dev only)</Text>
          </Pressable>
        )}
      </View>

      <Pressable
        onPress={onSignOut}
        disabled={signingOut}
        accessibilityRole="button"
        accessibilityState={{ disabled: signingOut, busy: signingOut }}
        style={({ pressed }) => [
          styles.button,
          (pressed || signingOut) && styles.buttonDimmed,
        ]}
      >
        <Text style={styles.buttonText}>Sign out</Text>
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
  title: { fontSize: 28, fontWeight: '700', color: '#111827' },
  subtitle: { fontSize: 16, lineHeight: 22, color: '#4B5563' },
  linkButton: { height: 48, justifyContent: 'center', alignSelf: 'flex-start' },
  linkText: { color: '#1D4ED8', fontSize: 16, fontWeight: '500' },
  button: {
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDimmed: { opacity: 0.6 },
  buttonText: { color: '#111827', fontSize: 16, fontWeight: '600' },
});
