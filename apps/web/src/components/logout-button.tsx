'use client';

import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function LogoutButton() {
  const [error, setError] = useState('');
  const router = useRouter();

  const logout = async () => {
    try {
      const res = await fetch('/api/auth/logout', {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json();
        setError(body.message);
        return;
      }
      router.push('/login');
    } catch {
      setError('Something went wrong. Please try again.');
    }
  };

  return (
    <div>
      <Button onClick={logout}>Logout</Button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
