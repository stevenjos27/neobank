export type Account = {
  id: string;
  accountNumber: string;
  type: 'SAVINGS' | 'CURRENT';
  balancePaise: string;
  currency: string;
  createdAt: string;
};
