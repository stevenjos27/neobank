export function formatPaise(paise: string | bigint): string {
  const val = BigInt(paise);
  const units = (val / 100n);
  const decimal = (val % 100n);
  const finalVal = Intl.NumberFormat(
    'en-IN',
    {
      style: "currency",
      currency: 'INR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(units) + '.' + decimal.toString().padStart(2, '0');
  return finalVal;
}
