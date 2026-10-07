import { Stack } from 'expo-router';

/**
 * Root layout: every route renders inside this Stack.
 *
 * Step 2 commit 1 only moves the app onto the router. The auth switch —
 * signed out → Login, session present → Unlock, unlocked → the app — lands
 * here in commit 3, as protected route groups, so a screen the user may not
 * see is never mounted at all rather than mounted and hidden.
 */
export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
