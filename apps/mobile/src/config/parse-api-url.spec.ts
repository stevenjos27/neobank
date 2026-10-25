import { parseApiUrl } from './parse-api-url';

describe('parseApiUrl', () => {
  describe('missing value', () => {
    it.each<[string, string | undefined]>([
      ['undefined', undefined],
      ['empty', ''],
      ['whitespace only', '   '],
    ])('%s → setup error naming the fix', (_label, raw) => {
      expect(() => parseApiUrl(raw, true)).toThrow(/not set.*\.env\.example/);
    });
  });

  describe('accepted (development build)', () => {
    it.each<[string, string]>([
      ['https://api.example.com/api', 'https://api.example.com/api'],
      ['http://192.168.1.16:3000/api', 'http://192.168.1.16:3000/api'],
      ['https://api.example.com/api/', 'https://api.example.com/api'],
      ['https://api.example.com/api///', 'https://api.example.com/api'],
      ['  https://api.example.com/api  ', 'https://api.example.com/api'],
      ['HTTPS://api.example.com', 'HTTPS://api.example.com'],
    ])('"%s" → "%s"', (raw, expected) => {
      expect(parseApiUrl(raw, true)).toBe(expected);
    });
  });

  describe('rejected shapes', () => {
    it.each<[string, string]>([
      ['no scheme', 'api.example.com/api'],
      ['wrong scheme', 'ftp://api.example.com/api'],
      ['no host', 'https://'],
      ['query string', 'https://api.example.com/api?debug=1'],
      ['fragment', 'https://api.example.com/api#x'],
      ['space in host', 'https://api example.com/api'],
    ])('%s → invalid', (_label, raw) => {
      expect(() => parseApiUrl(raw, true)).toThrow(/not a valid http\(s\) URL/);
    });
  });

  describe('release build (isDev = false)', () => {
    it('accepts https', () => {
      expect(parseApiUrl('https://api.example.com/api', false)).toBe(
        'https://api.example.com/api',
      );
    });

    it('refuses plain http', () => {
      expect(() => parseApiUrl('http://192.168.1.16:3000/api', false)).toThrow(
        /must use https/,
      );
    });

    it('refuses plain http whatever its case', () => {
      expect(() => parseApiUrl('HTTP://api.example.com/api', false)).toThrow(/must use https/);
    });
  });
});
