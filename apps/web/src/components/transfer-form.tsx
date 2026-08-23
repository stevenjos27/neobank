'use client';

import { Account } from '@/lib/types';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { formatPaise } from '@/lib/money';

export default function TransferForm({
  accounts,
  onSuccess,
}: {
  accounts: Account[];
  onSuccess?: () => void;
}) {
  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const amountPaise = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      setError('Invalid Amount');
      return;
    }
    if (fromAccountId === toAccountId) {
      setError('Destination account cannot be same as source account');
      return;
    }
    setLoading(true);

    try {
      const res = await fetch(`/api/accounts/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromAccountId,
          toAccountId,
          amountPaise,
          description,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        setError(body.message);
        return;
      }
      router.refresh();
      onSuccess?.();
      setFromAccountId('');
      setToAccountId('');
      setAmount('');
      setDescription('');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={handleSubmit}>
      <Label htmlFor="fromAccountId">Select Account</Label>
      <select
        required
        id="fromAccountId"
        value={fromAccountId}
        onChange={(e) => setFromAccountId(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      >
        <option value="" disabled>
          Select an account
        </option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.type} - •••• {account.accountNumber.slice(-4)} Bal:{' '}
            {formatPaise(account.balancePaise)}
          </option>
        ))}
      </select>
      <Label htmlFor="toAccount">Recipient Account</Label>
      <Input
        placeholder="Account ID"
        required
        id="toAccount"
        type="text"
        value={toAccountId}
        onChange={(e) => setToAccountId(e.target.value)}
      />

      <Label htmlFor="amountPaise">Transfer Amount</Label>
      <Input
        id="amountPaise"
        type="number"
        value={amount}
        step="0.01"
        min="0.01"
        onChange={(e) => setAmount(e.target.value)}
      />

      <Label htmlFor="description">Description</Label>
      <Input
        id="description"
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button disabled={loading} type="submit" className="w-full">
        {loading ? 'Transfer in progress...' : 'Transfer'}
      </Button>
    </form>
  );
}
