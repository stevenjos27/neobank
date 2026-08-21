'use client';

import { useState } from 'react';
import DepositForm from './deposit-form';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { Button } from './ui/button';

export default function DepositDialog({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="w-full">Deposit</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deposit</DialogTitle>
        </DialogHeader>
        <DepositForm accountId={accountId} onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
