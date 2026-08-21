'use client';

import { useState } from 'react';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Button } from './ui/button';
import { useRouter } from 'next/navigation';

export default function DepositForm({
  accountId,
  onSuccess,
}: {
  accountId: string;
  onSuccess?: () => void;
}) {
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
    setLoading(true);

    try {
      const res = await fetch(`/api/accounts/${accountId}/deposit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountPaise, description }),
      });

      if (!res.ok) {
        const body = await res.json();
        setError(body.message);
        return;
      }
      router.refresh();
      onSuccess?.();
      setAmount('');
      setDescription('');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <form className="space-y-3" onSubmit={handleSubmit}>
        <Label htmlFor={`amount-${accountId}`}>Deposit Amount</Label>
        <Input
          required
          id={`amount-${accountId}`}
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          step="0.01"
          min="0.01"
        />
        <Label htmlFor={`description-${accountId}`}>Description</Label>
        <Input
          id={`description-${accountId}`}
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button disabled={loading} type="submit" className="w-full">
          {loading ? 'Deposit in progress...' : 'Deposit'}
        </Button>
      </form>
    </div>
  );
}
