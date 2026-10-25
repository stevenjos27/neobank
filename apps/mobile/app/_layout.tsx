import { Stack } from 'expo-router';
import { createAuthClient } from '../src/auth/auth-client';
import { API_URL } from '../src/config/env';
import { secureTokenStore } from '../src/auth/secure-token-store';
import { AuthProvider, useAuth } from '../src/auth/AuthProvider';
import { deviceAuth } from '../src/auth/device-auth';
import { ActivityIndicator, View, StyleSheet } from 'react-native';

/**
 * Composition root: the only module that wires real implementations
 * together. Everything below receives them as props or through useAuth,
 * so tests use fakes and never touch env, SecureStore or biometrics.
 *
 * Module scope: ONE client for the app's lifetime. It holds the access
 * token in its closure, so a second instance would mean a second session
 * view. (Fast Refresh of this file recreates it; the next request simply
 * refreshes.)
 */
const authClient = createAuthClient({
  baseUrl: API_URL,
  store: secureTokenStore,
});

export default function RootLayout() {
  return (
    <AuthProvider client={authClient} deviceAuth={deviceAuth}>
      <RootNavigator />
    </AuthProvider>
  );
}

/**
 * The routing table as protected groups. A screen whose guard is false is
 * not in the navigator at all: it cannot be deep-linked to, navigated back
 * to, or left mounted underneath. When a guard flips, Expo Router moves to
 * the first screen that is allowed.
 */
function RootNavigator() {
  const { status, locked } = useAuth();

  // Nothing is decided yet, so no route may render (not even Login).
  if (status === 'restoring') {
    return (
      <View style={styles.splash}>
        <ActivityIndicator size="large" accessibilityLabel="Loading" />
      </View>
    );
  }

  const signedIn = status === 'signedIn';

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={status === 'unreachable'}>
        <Stack.Screen name="no-connection" />
      </Stack.Protected>

      <Stack.Protected guard={status === 'signedOut'}>
        <Stack.Screen name="login" />
      </Stack.Protected>

      <Stack.Protected guard={signedIn && locked}>
        <Stack.Screen name="unlock" />
      </Stack.Protected>

      <Stack.Protected guard={signedIn && !locked}>
        <Stack.Screen name="index" />
        <Stack.Protected guard={__DEV__}>
          <Stack.Screen name="diagnostics" />
        </Stack.Protected>
      </Stack.Protected>
    </Stack>
  );
}

const styles = StyleSheet.create({
  splash: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
});
