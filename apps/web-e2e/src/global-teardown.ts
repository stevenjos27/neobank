import { execFileSync } from 'node:child_process';

export default function globalTeardown() {
  try {
    execFileSync('pnpm', ['db:clean'], { stdio: 'inherit' });
  } catch (err) {
    console.warn('⚠ db:clean failed during teardown:', err);
  }
}
