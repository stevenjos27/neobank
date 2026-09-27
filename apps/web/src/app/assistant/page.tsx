import Link from 'next/link';
import LogoutButton from '@/components/logout-button';
import ThemeToggle from '@/components/theme-toggle';
import { AssistantChat } from '@/components/assistant-chat';

/**
 * The assistant, as a page.
 *
 * A server component that fetches nothing, which is unusual here — every other
 * authed page loads something first. There is simply nothing to load: the
 * conversation starts empty and its only input is the customer's question.
 * Rendering the frame on the server anyway keeps the header identical to the
 * dashboard's and keeps the client bundle to the interactive part.
 *
 * NO SESSION CHECK IN THIS FILE. proxy.ts redirects an unauthenticated visitor
 * to /login before this renders. Repeating the check here would be a second
 * place for the rule to live, and the second place is the one that drifts.
 */
export default function AssistantPage() {
  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      <header className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold">Assistant</h1>
          <Link
            href="/dashboard"
            className="text-sm text-muted-foreground hover:underline"
          >
            Back to your accounts
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <LogoutButton />
        </div>
      </header>

      <AssistantChat />
    </div>
  );
}
