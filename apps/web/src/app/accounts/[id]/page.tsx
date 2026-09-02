import { formatPaise } from '@/lib/money';
import { apiFetch } from '@/lib/server/api';
import { Account, TransactionPage } from '@/lib/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TransactionLedger } from './transaction-ledger';

export default async function AccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [accountRes, txRes] = await Promise.all([
    apiFetch(`/accounts/${id}`),
    apiFetch(`/accounts/${id}/transactions?limit=50`),
  ]);

  if (!accountRes.ok) notFound();

  const account: Account = await accountRes.json();
  const firstPage: TransactionPage = txRes.ok
    ? await txRes.json()
    : { items: [], nextCursor: null };

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      <Link
        href="/dashboard"
        className="text-sm text-muted-foreground hover:underline"
      >
        ← Back to dashboard
      </Link>

      <header>
        <h1 className="text-2xl font-bold">
          {account.type} •••• {account.accountNumber.slice(-4)}
        </h1>
        <p className="text-3xl font-bold mt-2">
          {formatPaise(account.balancePaise)}
        </p>
      </header>

      <TransactionLedger
        accountId={id}
        initialItems={firstPage.items}
        initialCursor={firstPage.nextCursor}
      />
    </div>
  );
}
