import { formatPaise } from '@/lib/money';
import { apiFetch } from '@/lib/server/api';
import { Account, Transaction } from '@/lib/types';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export default async function AccountPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [accountRes, txRes] = await Promise.all([
    apiFetch(`/accounts/${id}`),
    apiFetch(`/accounts/${id}/transactions`),
  ]);

  if (!accountRes.ok) notFound();

  const account: Account = await accountRes.json();
  const transactions: Transaction[] = txRes.ok ? await txRes.json() : [];
  const isCredit = (type: Transaction['type']) => type !== 'TRANSFER_OUT';

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
      {transactions.length === 0 ? (
        <p className="text-muted-foreground">No transactions yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b text-left text-muted-foreground">
            <tr>
              <th className="py-2 font-medium">Date</th>
              <th className="py-2 font-medium">Type</th>
              <th className="py-2 font-medium">Description</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((transaction) => (
              <tr key={transaction.id} className="border-b">
                <td className="py-2">
                  {new Date(transaction.createdAt).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </td>
                <td className="py-2">{transaction.type}</td>
                <td className="py-2">{transaction.description ?? '-'}</td>
                <td
                  className={`py-2 text-right ${isCredit(transaction.type) ? 'text-green-600' : 'text-destructive'}`}
                >
                  {isCredit(transaction.type) ? '+' : '−'}
                  {formatPaise(transaction.amountPaise)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
