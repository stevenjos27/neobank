'use client';

import { Account, Payee } from '@/lib/types';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { formatPaise } from '@/lib/money';
import AddPayeeForm from './add-payee-form';

type Mode = 'own' | 'payee';

const selectClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm';

export default function TransferForm({
  accounts,
  onSuccess,
}: {
  accounts: Account[];
  onSuccess?: () => void;
}): any {
  const [mode, setMode] = useState<Mode>('own');
  const [fromAccountId, setFromAccountId] = useState('');
  const [toAccountId, setToAccountId] = useState('');
  const [payeeId, setPayeeId] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const [payees, setPayees] = useState<Payee[]>([]);
  const [addingPayee, setAddingPayee] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/payees');
        if (!res.ok) return;
        const data: Payee[] = await res.json();
        if (!cancelled) setPayees(data);
      } catch (error) {
        console.log(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const ownDestinations = accounts.filter((a) => a.id !== fromAccountId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const amountPaise = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      setError('Invalid Amount');
      return;
    }

    if (mode === 'own') {
      if (!toAccountId) {
        setError('Choose a destination account');
        return;
      }
      if (fromAccountId === toAccountId) {
        setError('Destination account cannot be same as source account');
        return;
      }
    } else if (!payeeId) {
      setError('Choose a payee');
      return;
    }
    setLoading(true);

    try {
      const res = await fetch(`/api/accounts/transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromAccountId,
          ...(mode === 'own' ? { toAccountId } : { payeeId }),
          amountPaise,
          ...(mode === 'own' && description ? { description } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        setError(body.message ?? 'Transfer failed');
        return;
      }

      router.refresh();
      onSuccess?.();
      setFromAccountId('');
      setToAccountId('');
      setPayeeId('');
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
      <Label htmlFor="fromAccountId">From Account</Label>
      <select
        required
        id="fromAccountId"
        value={fromAccountId}
        onChange={(e) => setFromAccountId(e.target.value)}
        className={selectClass}
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

      <div
        role="radiogroup"
        aria-label="Destination type"
        className="flex gap-2 pt-1"
      >
        <Button
          type="button"
          role="radio"
          aria-checked={mode === 'own'}
          variant={mode === 'own' ? 'default' : 'outline'}
          onClick={() => {
            setMode('own');
            setError('');
          }}
        >
          My accounts
        </Button>
        <Button
          type="button"
          role="radio"
          aria-checked={mode === 'payee'}
          variant={mode === 'payee' ? 'default' : 'outline'}
          onClick={() => {
            setMode('payee');
            setError('');
          }}
        >
          Someone else
        </Button>
      </div>

      {mode === 'own' ? (
        <>
          <Label htmlFor="toAccountId">To account</Label>
          <select
            id="toAccountId"
            value={toAccountId}
            onChange={(e) => setToAccountId(e.target.value)}
            className={selectClass}
          >
            <option value="" disabled>
              Select an account
            </option>
            {ownDestinations.map((account) => (
              <option key={account.id} value={account.id}>
                {account.type} - •••• {account.accountNumber.slice(-4)}
              </option>
            ))}
          </select>

          <Label htmlFor="description">Description</Label>
          <Input
            id="description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </>
      ) : (
        <>
          <Label htmlFor="payeeId">Payee</Label>
          {payees.length === 0 && !addingPayee ? (
            <p className="text-sm text-muted-foreground">
              You have no saved payees yet.
            </p>
          ) : (
            <select
              id="payeeId"
              value={payeeId}
              onChange={(e) => setPayeeId(e.target.value)}
              className={selectClass}
            >
              <option value="" disabled>
                Select a payee
              </option>
              {payees.map((payee) => (
                <option key={payee.id} value={payee.id}>
                  {payee.name} - •••• {payee.accountNumber.slice(-4)}
                </option>
              ))}
            </select>
          )}

          {addingPayee ? (
            <AddPayeeForm
              onCancel={() => setAddingPayee(false)}
              onAdded={(payee) => {
                setPayees((previous) => [payee, ...previous]);
                setPayeeId(payee.id);
                setAddingPayee(false);
              }}
            />
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => setAddingPayee(true)}
            >
              + Add a payee
            </Button>
          )}
        </>
      )}

      <Label htmlFor="amountPaise">Transfer Amount</Label>
      <Input
        id="amountPaise"
        type="number"
        value={amount}
        step="0.01"
        min="0.01"
        onChange={(e) => setAmount(e.target.value)}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button disabled={loading} type="submit" className="w-full">
        {loading ? 'Transfer in progress...' : 'Transfer'}
      </Button>
    </form>
  );
}
