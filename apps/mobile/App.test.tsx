import { render, screen } from '@testing-library/react-native';
import App from './App';

/**
 * WHAT THIS TEST PROVES, AND WHAT IT CANNOT.
 *
 * It runs on Node, under jest-expo. It therefore says NOTHING about Hermes:
 * the on-device screen is the only evidence for that, and it found a defect
 * Node could never have shown (Intl rejecting BigInt).
 *
 * What it does prove is that mobile's test harness works in this monorepo:
 *  - jest-expo transforms React Native's untranspiled source, even though
 *    pnpm stores it under node_modules/.pnpm/…
 *  - jest.config.js maps @neobank/utils and @neobank/contracts to the same
 *    source tsconfig does
 *  - React Native Testing Library renders against React 19.2.3 through a
 *    reconciler built for it (test-renderer pinned to 1.2.x)
 *
 * Every screen from Step 2 on is tested through this harness, so it has to
 * be proven before there is anything worth testing with it.
 */
describe('App (Phase 4 Step 0 check screen)', () => {
  it('renders every formatPaise case, and every case matches', async () => {
    // RNTL 14 renders asynchronously: render() returns a promise that
    // settles once React has committed. Not awaiting it would query a tree
    // that may not exist yet.
    await render(<App />);

    // The summary line…
    expect(screen.getByText('17/17 match Node')).toBeOnTheScreen();

    // …and the rows behind it. The summary alone could be right while the
    // list failed to render; seventeen PASS rows and zero FAIL rows cannot.
    expect(screen.getAllByText(/^PASS · /)).toHaveLength(17);
    expect(screen.queryByText(/^FAIL · /)).toBeNull();

    // The screen must finish its async work before the test ends; otherwise
    // the frame check's setState lands after teardown, outside act().
    await screen.findByText(/^✓ readFrames, one byte per read/);
  });

  it('parses the shared wire format one byte per read', async () => {
    await render(<App />);

    // findBy* polls inside act() until the effect has run and React has
    // committed its result. Two jobs in one: it waits (no act warning, no
    // race) and it asserts (a broken parser now fails CI, not just a log).
    //
    // Anchored on ✓ deliberately: an unanchored /readFrames/ would also
    // match the ✗ row a failing check renders, and pass.
    expect(
      await screen.findByText(/^✓ readFrames, one byte per read/),
    ).toBeOnTheScreen();

    // The tick only says pass === true. The detail pins HOW it passed:
    // all four events, and 242 single-byte reads plus the final done read.
    expect(screen.getByText(/^4\/4 events in 243 reads; /)).toBeOnTheScreen();
  });
});
