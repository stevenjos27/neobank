import { Redirect } from 'expo-router';

/**
 * `/` — where the app opens.
 *
 * TEMPORARY (Step 2, commit 1): redirects to the diagnostics screen, so the
 * first run on the router opens on the same 0a/0b checks as before and any
 * difference is attributable to the move alone. Commit 3 replaces this with
 * the authenticated home, behind the unlock gate.
 */
export default function Index() {
  return <Redirect href="/diagnostics" />;
}
