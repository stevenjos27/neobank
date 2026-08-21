'use client';

import { useState } from 'react';
import { Label } from './ui/label';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';

export default function CreateAccountForm({
  onSuccess,
}: {
  onSuccess?: () => void;
}) {
  const [accountType, setAccountType] = useState('SAVINGS');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: accountType,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        setError(body.message);
        return;
      }
      router.refresh();
      onSuccess?.();
      setAccountType('SAVINGS');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="space-y-3" onSubmit={handleSubmit}>
      <Label htmlFor="accountType">Select Account Type</Label>
      <select
        required
        id="accountType"
        value={accountType}
        onChange={(e) => setAccountType(e.target.value)}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      >
        <option value="SAVINGS">SAVINGS</option>
        <option value="CURRENT">CURRENT</option>
      </select>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button disabled={loading} type="submit" className="w-full">
        {loading ? 'Account creation in progress...' : 'Create Account'}
      </Button>
    </form>
  );
}
