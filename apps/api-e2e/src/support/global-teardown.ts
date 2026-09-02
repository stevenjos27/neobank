import { killPort } from '@nx/node/utils';
import { execFileSync } from 'node:child_process';

module.exports = async function () {
  try {
    execFileSync('pnpm', ['db:clean'], { stdio: 'inherit' });
  } catch (err) {
    console.warn('⚠ db:clean failed during teardown:', err);
  }
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await killPort(port);
  console.log(globalThis.__TEARDOWN_MESSAGE__);
};
