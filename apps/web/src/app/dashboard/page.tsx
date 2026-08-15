import DepositForm from '@/components/deposit-form';
import LogoutButton from '@/components/logout-button';
import TransferForm from '@/components/transfer-form';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatPaise } from '@/lib/money';
import { apiFetch } from '@/lib/server/api';
import { Account } from '@/lib/types';
import Link from 'next/link';

export default async function DashboardPage() {
  const res = await apiFetch('/accounts');
  if (!res.ok) {
    return (
      <p className="p-8 text-destructive">Could not load your accounts.</p>
    );
  }
  const accounts: Account[] = await res.json();

  return (
    <div className="max-w-4xl mx-auto p-8 space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Your Accounts</h1>
        <LogoutButton />
      </header>
      {accounts.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No accounts yet.
          </CardContent>
        </Card>
      ) : (
        <div>
          <div className="grid gap-4 md:grid-cols-2">
            {accounts.map((account) => (
              <Card key={account.id}>
                <CardHeader>
                  <CardTitle className="text-base font-medium">
                    {account.type}
                  </CardTitle>
                  <Link href={`/accounts/${account.id}`}>
                    <p className="text-sm text-muted-foreground">
                      •••• {account.accountNumber.slice(-4)}
                    </p>
                  </Link>
                </CardHeader>
                <CardContent>
                  <p className="text-2xl font-bold">
                    {formatPaise(account.balancePaise)}
                  </p>
                  <DepositForm accountId={account.id} />
                </CardContent>
              </Card>
            ))}
          </div>
          <div>
            <TransferForm accounts={accounts} />
          </div>
        </div>
      )}
    </div>
  );
}
