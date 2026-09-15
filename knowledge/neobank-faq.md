# NeoBank — Customer Policy and FAQ

This document is the assistant's source of truth for questions about how NeoBank
works. Every section must describe the product as it actually behaves. A section
that describes behaviour the app does not have will be repeated to customers as
fact, with a citation, which is worse than having no document at all.

Sections are written to stand alone: each is retrieved in isolation, so none may
depend on "as described above" or on a neighbouring section for meaning.

---

## Account types

NeoBank offers two account types. A **Savings account** is intended for personal
day-to-day banking and is the default when you open your first account. A
**Current account** is intended for business or higher-volume use. Both hold
Indian Rupees (INR) only, and both support deposits, transfers and full
transaction history. There is no minimum balance requirement on either type, and
no limit on how many accounts a single customer may open.

## Opening an account

You can open a new account at any time from your dashboard using the "Create
Account" option, choosing either Savings or Current. The account opens
immediately with a zero balance and is assigned a twelve-digit account number.
No paperwork, approval step or waiting period is involved. Your existing
accounts are unaffected.

## Account numbers and IFSC

Every NeoBank account has a unique twelve-digit account number. NeoBank operates
as a single branch, so all NeoBank accounts share the same IFSC code:
**NEOB0000001**. You need both the account number and the IFSC to add someone as
a payee. Your own account numbers are shown on your dashboard, masked to the
last four digits; the full number is on the account detail page.

## Adding a payee

Before you can send money to someone else at NeoBank, you must add them as a
payee. You enter their account number and IFSC, and NeoBank responds with the
**name registered on that account** so you can confirm you have the right
person. Only after you confirm is the payee saved. The saved payee name is the
name NeoBank verified — you cannot set it yourself, so the name shown against a
payee is always the actual account holder.

## Why payee confirmation matters

The name check exists because account numbers are typed by hand and a single
transposed digit sends money to a stranger. Confirming the account holder's name
before saving is the only point in the process where that mistake is catchable.
If the name shown is not the person you expect, choose "Not this person" and
check the account number again. Money sent to a wrongly-added payee follows the
same rules as any other transfer and is not automatically reversible.

## Payee lookup limits

Payee verification is limited to ten lookups per minute per customer. The limit
exists because the lookup discloses an account holder's name, and an unlimited
lookup would allow account numbers to be guessed at scale. Reaching the limit
does not affect your accounts, transfers or anything else — waiting a minute
restores it. Adding payees is also subject to the same ten-per-minute limit.

## Transferring between your own accounts

Transfers between accounts you own are immediate and require no payee. Choose
the source account, choose the destination from your other accounts, enter the
amount, and confirm. The money leaves one account and arrives in the other as a
single atomic operation: it is never possible for the debit to succeed while the
credit fails. Both accounts show the transfer in their transaction history
straight away.

## Transferring to someone else

To send money to another person you select a saved payee rather than typing an
account number. The transfer is immediate and cannot be cancelled once
confirmed. Your statement will show the transfer described as "Transfer to
[payee name]" with the last four digits of their account number; the recipient's
statement shows "Transfer from [your name]" with the last four digits of yours.
These descriptions are written by NeoBank, not by either party.

## Insufficient funds

NeoBank does not offer an overdraft. If a transfer or withdrawal would take an
account below zero, it is declined in full and no money moves. Partial transfers
do not happen — a transfer either completes entirely or does not occur at all.
Your balance is never allowed to become negative under any circumstance,
including simultaneous transfers from the same account.

## Deposits

You can deposit into any account you own from the dashboard. Deposits are
immediate and appear in your transaction history at once. In this version of
NeoBank, deposits are self-service and are used to fund accounts directly;
NeoBank does not currently support incoming transfers from other banks, cheque
deposits or cash deposits at a branch.

## Transaction history

Every account keeps a complete transaction history with no time limit — nothing
is archived or removed. The history is shown newest first, fifty entries at a
time, with a "Load older transactions" control to continue further back. When
you reach the beginning, the page shows "End of history" so you can tell that
the ledger genuinely ends rather than having stopped loading. Every deposit,
withdrawal and both sides of every transfer appear as separate entries.

## Fees and charges

NeoBank currently charges no fees. There is no account opening fee, no
maintenance fee, no minimum balance penalty, no transfer charge and no charge
for adding a payee. Transfers between NeoBank accounts, including to other
customers, are free regardless of amount or frequency.

## Currency

All NeoBank accounts are denominated in Indian Rupees. Amounts are displayed in
the Indian numbering system, so one hundred thousand rupees is shown as
₹1,00,000.00. NeoBank does not support foreign currency accounts, currency
conversion, or international transfers.

## Keeping your account secure

Your password is stored using argon2 hashing and is never recoverable in plain
text by anyone, including NeoBank staff. Your login session uses a short-lived
access token that expires after fifteen minutes and refreshes silently while you
are active, so you are not logged out mid-task. On the web app these tokens are
held in cookies that JavaScript cannot read, which limits the damage a malicious
script on the page could do.

## What NeoBank staff will never ask you

NeoBank will never ask for your password, and never asks you to transfer money
to a "safe account". No NeoBank employee needs your password to help you with
anything. If someone contacts you claiming to be from NeoBank and asks for
either, they are not from NeoBank. Genuine NeoBank support will only ever ask
you to confirm details you can see on your own dashboard.

## Roles and administrator access

Every NeoBank customer holds a customer role, which grants access to their own
accounts and no one else's. A separate administrator role exists for internal
operations. Administrators cannot move money in or out of customer accounts;
their access is for support and oversight. A customer's own accounts and
transactions are never visible to another customer under any circumstances.

## Closing an account

Account closure is not currently available in the app. If you no longer want to
use an account you may leave it at a zero balance; there is no fee for holding
an unused account and no minimum balance requirement. Saved payees can be
deleted at any time from the transfer screen, which does not affect any
transfers already made.
