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
  type: 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER_IN' | 'TRANSFER_OUT';
  amountPaise: string;
  description: string | null;
  createdAt: string;
};

export type TransactionPage = {
  items: Transaction[];
  nextCursor: string | null;
};

export type Payee = {
  id: string;
  name: string;
  accountNumber: string;
  ifsc: string;
  createdAt: string;
};

export type PayeeVerification = {
  accountNumber: string;
  beneficiaryName: string;
};
