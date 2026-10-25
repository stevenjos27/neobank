import type { ComponentType, ReactNode } from 'react';

/**
 * Dev-only route. Expo Router imports every file in app/ at startup, so a
 * plain re-export ran DiagnosticsScreen's module-level checks (and their
 * console.log) on every launch, and shipped them in the release bundle.
 *
 * The requires sit inside a __DEV__ ternary, inside the component:
 *  - development: the modules load the first time this screen renders,
 *    so the checks run when you open Diagnostics, not at app launch;
 *  - production: Metro replaces __DEV__ with false and folds the ternary
 *    to null BEFORE collecting dependencies, so neither module (nor the
 *    diagnostics tree behind them) enters the bundle.
 *
 * The layout's guard={__DEV__} already made the route unreachable in
 * release; this makes it absent. The screen and the auth panel stay
 * independent; they are composed here, through the screen's footer slot.
 */
export default function DiagnosticsRoute() {
  const dev = __DEV__
    ? {
        Screen: (
          require('../src/diagnostics/DiagnosticsScreen') as {
            default: ComponentType<{ footer?: ReactNode }>;
          }
        ).default,
        Panel: (
          require('../src/diagnostics/AuthDebugPanel') as {
            default: ComponentType;
          }
        ).default,
      }
    : null;

  return dev ? <dev.Screen footer={<dev.Panel />} /> : null;
}
