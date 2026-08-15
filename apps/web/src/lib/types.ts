export type Account = {
  id: string;
  accountNumber: string;
  type: 'SAVINGS' | 'CURRENT';
  balancePaise: string;
  currency: string;
  createdAt: string;
};

export type Transaction = {
  id: string;
  accountId: string;
  type: 'DEPOSIT' | 'TRANSFER_IN' | 'TRANSFER_OUT';
  amountPaise: string;
  description: string | null;
  createdAt: string;
};
