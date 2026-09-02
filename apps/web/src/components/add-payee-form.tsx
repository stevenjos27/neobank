'use client';

import { Payee, PayeeVerification } from '@/lib/types';
import { useState } from 'react';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Button } from './ui/button';

/** NeoBank is single-branch, so one IFSC identifies it. Prefilled, still editable. */
const DEFAULT_IFSC = 'NEOB0000001';

export default function AddPayeeForm({
  onAdded,
  onCancel,
}: {
  onAdded: (payee: Payee) => void;
  onCancel?: () => void;
}) {
  const [accountNumber, setAccountNumber] = useState('');
  const [ifsc, setIfsc] = useState(DEFAULT_IFSC);
  const [confirmed, setConfirmed] = useState<PayeeVerification | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function verify() {
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/payees/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountNumber, ifsc }),
      });

      const body = await res.json();
      if (!res.ok) {
        setError(
          res.status === 429
            ? 'Too many lookups. Please try again after some time.'
            : (body.message ?? 'Could not find that account'),
        );
        return;
      }
      setConfirmed(body as PayeeVerification);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/payees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountNumber, ifsc }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(
          res.status === 409
            ? 'This payee is already saved.'
            : (body.message ?? 'Could not save payee'),
        );
        return;
      }
      onAdded(body as Payee);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (confirmed) {
    return (
      <div className="space-y-3 rounded-md border p-4">
        <p className="text-sm text-muted-foreground">Account holder</p>
        <p className="text-lg font-semibold">{confirmed.beneficiaryName}</p>
        <p className="text-sm text-muted-foreground">
          •••• {confirmed.accountNumber.slice(-4)} · {ifsc.toUpperCase()}
        </p>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex gap-2">
          <Button type="button" disabled={loading} onClick={save}>
            {loading ? 'Saving…' : 'Confirm and save'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={loading}
            onClick={() => {
              setConfirmed(null);
              setError('');
            }}
          >
            Not this person
          </Button>
        </div>
      </div>
    );
  }

  const lookupOnEnter = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (accountNumber && ifsc && !loading) void verify();
  };

  return (
    <div className="space-y-3 rounded-md border p-4">
      <Label htmlFor="payeeAccountNumber">Account Number</Label>
      <Input
        id="payeeAccountNumber"
        inputMode="numeric"
        placeholder="900000000004"
        value={accountNumber}
        onChange={(e) => setAccountNumber(e.target.value.trim())}
        onKeyDown={lookupOnEnter}
      />

      <Label htmlFor="payeeIfsc">IFSC</Label>
      <Input
        id="payeeIfsc"
        required
        value={ifsc}
        onChange={(e) => setIfsc(e.target.value.trim())}
        onKeyDown={lookupOnEnter}
      />

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button
          type="button"
          disabled={loading || !accountNumber || !ifsc}
          onClick={() => void verify()}
        >
          {loading ? 'Looking up…' : 'Look up account'}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
