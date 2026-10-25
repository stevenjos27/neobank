import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../auth/AuthProvider';
import { LoginFailedError, NetworkError } from '../auth/auth-client';

/**
 * One user-facing sentence per failure. 400 and 401 read the same on
 * purpose: the API already answers 401 for both "no such email" and
 * "wrong password" (no account enumeration), and showing 400's
 * validation text would echo the password policy back at whoever types.
 */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof LoginFailedError) {
    if (error.status === 400 || error.status === 401)
      return 'Email or password is incorrect.';
    if (error.status === 429)
      return 'Too many attempts. Wait a minute and try again.';
    return `NeoBank couldn't sign you in right now. Try again shortly.`;
  }
  if (error instanceof NetworkError) {
    return `Can't reach NeoBank. Check your connection and try again.`;
  }
  return 'Something went wrong. Try again.';
}

/**
 * Credentials sign-in. No navigation here: on success the provider sets
 * signedIn + unlocked and the router's guards move to Home.
 */
export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordInput = useRef<TextInput>(null);

  const canSubmit = email.trim() !== '' && password !== '' && !submitting;

  async function onSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
    } catch (e) {
      setError(loginErrorMessage(e));
      setPassword(''); // never leave a rejected password sitting in the field
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.body}>
          <Text style={styles.title} accessibilityRole="header">
            Sign in to NeoBank
          </Text>

          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            editable={!submitting}
            accessibilityLabel="Email"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            keyboardType="email-address"
            returnKeyType="next"
            onSubmitEditing={() => passwordInput.current?.focus()}
          />

          <Text style={styles.label}>Password</Text>
          <TextInput
            ref={passwordInput}
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            editable={!submitting}
            accessibilityLabel="Password"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={onSubmit}
          />

          {error !== null && (
            <Text
              style={styles.error}
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
            >
              {error}
            </Text>
          )}
        </View>

        <Pressable
          onPress={onSubmit}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit, busy: submitting }}
          style={({ pressed }) => [
            styles.button,
            (pressed || !canSubmit) && styles.buttonDimmed,
          ]}
        >
          {submitting ? (
            <ActivityIndicator
              color="#FFFFFF"
              accessibilityLabel="Signing in"
            />
          ) : (
            <Text style={styles.buttonText}>Sign in</Text>
          )}
        </Pressable>
      </KeyboardAvoidingView>
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
  flex: { flex: 1 },
  body: { flex: 1, justifyContent: 'center', gap: 8 },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 16,
  },
  label: { fontSize: 14, fontWeight: '500', color: '#374151', marginTop: 8 },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 16,
    color: '#111827',
  },
  error: { fontSize: 14, color: '#B91C1C', marginTop: 8 },
  button: {
    height: 52,
    borderRadius: 12,
    backgroundColor: '#1D4ED8',
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDimmed: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
