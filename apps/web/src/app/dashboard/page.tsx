import LogoutButton from '@/components/logout-button';
import ThemeToggle from '@/components/theme-toggle';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { formatPaise } from '@/lib/money';
import { apiFetch } from '@/lib/server/api';
import { Account } from '@/lib/types';
import Link from 'next/link';
import DepositDialog from '@/components/deposit-dialog';
import TransferDialog from '@/components/transfer-dialog';
import CreateAccountDialog from '@/components/create-account-dialog';

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
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <LogoutButton />
        </div>
      </header>
      {accounts.length > 0 && (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            {accounts.map((account) => (
              <Card key={account.id}>
                <CardHeader>
                  <CardTitle className="text-base font-medium">
                    {account.type}
                  </CardTitle>

                  <p className="text-sm text-muted-foreground">
                    •••• {account.accountNumber.slice(-4)}
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-2xl font-bold">
                    {formatPaise(account.balancePaise)}
                  </p>
                  <Link href={`/accounts/${account.id}`}>
                    <p className="text-primary hover:underline">
                      View transactions →
                    </p>
                  </Link>
                </CardContent>
                <CardFooter>
                  <DepositDialog accountId={account.id} />
                </CardFooter>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {accounts.length > 0 && (
          <>
            <TransferDialog accounts={accounts} />
            <CreateAccountDialog />
          </>
        )}
        {accounts.length === 0 && (
          <Card>
            <CardContent className="py-10 text-center space-y-4">
              <div>
                <p className="font-medium">No accounts yet</p>
                <p className="text-sm text-muted-foreground">
                  Open your first account to start banking.
                </p>
              </div>
              <div className="flex justify-center">
                <CreateAccountDialog />
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
