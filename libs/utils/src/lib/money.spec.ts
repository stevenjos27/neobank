import { formatPaise } from './money';

describe('formatPaise', () => {
  it('formats whole rupees', () => {
    expect(formatPaise('500000')).toBe('₹5,000.00');
  });

  it('formats zero', () => {
    expect(formatPaise('0')).toBe('₹0.00');
  });

  it('pads single-digit paise', () => {
    expect(formatPaise('1')).toBe('₹0.01');
  });

  it('uses Indian digit grouping', () => {
    expect(formatPaise('123456789')).toBe('₹12,34,567.89');
  });

  it('handles amounts beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
    expect(formatPaise('900719925474099100')).toBe('₹9,00,71,99,25,47,40,991.00');
  });

  it('accepts bigint input', () => {
    expect(formatPaise(500000n)).toBe('₹5,000.00');
  });

  it('formats a negative amount with the sign before the symbol', () => {
    expect(formatPaise(-12345n)).toBe('-₹123.45');
  });

  it('keeps the sign for a negative amount smaller than one rupee', () => {
    // The case this file exists for, and the one a plausible fix still gets
    // wrong. All of the sign information lives in a value Intl never sees:
    // -45 paise has 0 whole rupees, so formatting the signed rupee count
    // gives "₹0" and a debit renders as a credit.
    expect(formatPaise(-45n)).toBe('-₹0.45');
  });

  it('parses a negative amount given as a string', () => {
    expect(formatPaise('-500000')).toBe('-₹5,000.00');
  });
});
