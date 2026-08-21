'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { Button } from './ui/button';
import CreateAccountForm from './create-account-form';

export default function CreateAccountDialog() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="w-full">Create Account</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open a new account</DialogTitle>
        </DialogHeader>
        <CreateAccountForm onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
