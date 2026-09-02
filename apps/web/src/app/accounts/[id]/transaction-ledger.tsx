'use client';

import { useState } from 'react';
import { formatPaise } from '@/lib/money';
import { Transaction, TransactionPage } from '@/lib/types';

const PAGE_SIZE = 50;

const isCredit = (type: Transaction['type']) =>
  type === 'DEPOSIT' || type === 'TRANSFER_IN';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

export function TransactionLedger({
  accountId,
  initialItems,
  initialCursor,
}: {
  accountId: string;
  initialItems: Transaction[];
  initialCursor: string | null;
}) {
  const [items, setItems] = useState<Transaction[]>(initialItems);
  const [cursor, setCursor] = useState<string | null>(initialCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadOlder() {
    if (!cursor || loading) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/accounts/${accountId}/transactions?limit=${PAGE_SIZE}` +
          `&cursor=${encodeURIComponent(cursor)}`,
      );

      if (!res.ok)
        throw new Error(`Could not load older transactions (${res.status})`);

      const page: TransactionPage = await res.json();
      setItems((previous) => [...previous, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  if (items.length === 0) {
    return <p className="text-muted-foreground">No transactions yet.</p>;
  }

  return (
    <div className="space-y-4">
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
          {items.map((transaction) => (
            <tr key={transaction.id} className="border-b">
              <td className="py-2">{formatDate(transaction.createdAt)}</td>
              <td className="py-2">{transaction.type}</td>
              <td className="py-2">{transaction.description ?? '-'}</td>
              <td
                className={`py-2 text-right ${
                  isCredit(transaction.type)
                    ? 'text-green-600'
                    : 'text-destructive'
                }`}
              >
                {isCredit(transaction.type) ? '+' : '−'}
                {formatPaise(transaction.amountPaise)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Showing {items.length} transaction{items.length === 1 ? '' : 's'}
        </p>

        {cursor ? (
          <button
            type="button"
            onClick={loadOlder}
            disabled={loading}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            {loading ? 'Loading…' : 'Load older transactions'}
          </button>
        ) : (
          <p className="text-sm text-muted-foreground">End of history</p>
        )}
      </div>
    </div>
  );
}
