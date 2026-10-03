# @neobank/contracts

The wire contract between the NeoBank API and its clients: the types the API
returns, and the parser for the assistant's event stream.

Consumed by **apps/web** today and **apps/mobile** from Step 0b onward. One
definition for both clients, so a field added for one exists for the other,
and the hard part of reading a stream — frames and multi-byte characters split
across network chunks — is implemented and tested once.

## What lives here

| Export                                                                    | Kind     | Notes                                                                                                                               |
| ------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `readFrames`                                                              | function | Turns a byte stream of `data: {json}\n\n` frames into `AskEvent`s. Survives frames and `₹` (three UTF-8 bytes) split across chunks. |
| `AskEvent`, `AskSource`, `ByteReader`                                     | types    | The assistant stream's events, and the two-method reader `readFrames` accepts.                                                      |
| `Account`, `Transaction`, `TransactionPage`, `Payee`, `PayeeVerification` | types    | API response shapes. Money is a string of paise — format it with `formatPaise` from `@neobank/utils`.                               |

## What does not

**Transport.** How a client calls the API differs per client: the web app goes
through its own BFF route with cookies; the mobile app will call the API with a
bearer token. Each client owns its fetch and hands `readFrames` a reader.

## Rules

- **Runs on Node, browsers and Hermes.** `tsconfig.lib.json` loads no Node
  types, so `Buffer`, `process` or `node:*` imports here are compile errors
  rather than crashes on a phone. Tests may use Node; library code may not.
- **Every export is named in `src/index.ts`.** No `export *`: the public
  surface is a decision a reviewer can see.
- **Types are re-exported with `export type`.** Consumers compile one file at a
  time (SWC in web, Babel in Metro) under `isolatedModules`.
- **Not built or published.** Every consumer compiles it from source through
  the `@neobank/contracts` path alias. There is deliberately no `build` target
  and no `package.json` (see `nx.json`'s exclude on `@nx/js/typescript`).

## Known limits

- **The API types are hand-written mirrors of what the API sends.** Sharing
  them removes drift _between the clients_; nothing yet makes the API itself
  satisfy them, so a server-side change can still drift from this file with
  every build green.
- **These tests run on Node, whose `TextDecoder` is not the one a phone uses.**
  Hermes ships none; Expo installs a JavaScript polyfill. Its handling of a
  split `₹` is verified on the device by `apps/mobile/decoder-check.ts`.

## Commands

    pnpm nx test contracts        # the parser's chunk-boundary spec
    pnpm nx typecheck contracts   # library and spec, as two separate programs
    pnpm nx lint contracts
