'use client';

import { useTheme } from 'next-themes';
import { Sun, Moon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from './ui/button';

export default function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  return !mounted ? (
    <Button variant="outline" size="icon" disabled />
  ) : (
    <Button
      variant="outline"
      size="icon"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {resolvedTheme === 'dark' ? (
        <Sun className="h-5 w-5 text-yellow-500 animate-in fade-in" />
      ) : (
        <Moon className="h-5 w-5 text-slate-700 animate-in fade-in" />
      )}
    </Button>
  );
}
