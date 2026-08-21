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
});
