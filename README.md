# simphony-sts-harness

A local GUI for exercising the Oracle Simphony Transaction Services Gen 2 API. It walks the ordering flow step by step, from login to a paid check, and builds checks with condiment prefixes and combo meals. Every request and response is shown in full, with copy-as-curl and a history you can diff and re-send. A built-in mock server means it runs with no credentials.

Node 22.9 or later, no npm packages, no build step.

> **Status:** the mock flow is complete and tested. Live login and live responses have not yet been tested against a real tenant; see [Live mode](#live-mode) and [Schema assumptions](#schema-assumptions).
>
> Independent project, not affiliated with or endorsed by Oracle. Oracle and Simphony are trademarks of Oracle and/or its affiliates. API details come from Oracle's public [STS Gen2 documentation](https://docs.oracle.com/en/industries/food-beverage/simphony/omsstsg2api/index.html).

## Run

```
npm start            # http://127.0.0.1:4870
npm test             # mock engine tests
```

The page opens in **mock mode** every time. Mock needs no credentials: press Log in, then follow the steps.

## Live mode

1. Copy `.env.example` to `.env` and fill in the auth host, API host, client ID, username, password and org short name. Optional: default loc/RVC/employee/order type refs.
2. Restart `npm start`, switch to **Live** in the top bar (the frame turns red), and log in.

Live login runs the Authorization Code + PKCE flow on the harness server (`lib/auth.mjs`): `authorize` (keep cookies) → `signin` (username, password, orgname) → `token`. The `id_token` is the bearer. Tokens stay in server memory; the browser never sees them, and they are lost on restart. After two failed sign-ins the harness refuses a third until you tick the override, because Oracle locks the account for 30 minutes after repeated failures.

**The live flow is untested.** It was written from the docs without a tenant. The cookie hand-off between `authorize` and `signin` is the likeliest point of failure; server logs (`auth.login.fail`, secrets redacted) show which stage failed.

Safety in live: posts and rounds need a confirm naming the location; checks go as training checks unless you untick it; the target is assumed to be test/UAT only.

## Layout

| Path | What |
|---|---|
| `server.mjs` | Static files, `/auth/*`, `/proxy` (adds bearer, forwards, times), `/mock/api/*` (direct mock for curl, token `mock-token`) |
| `lib/auth.mjs` | Live PKCE flow and mock auth |
| `lib/mock.mjs` | Mock routes and pricing engine |
| `lib/log.mjs` | Logger that redacts tokens, passwords and codes |
| `fixtures/demo.json` | Mock org `demo`: 2 locations, menu, combo, condiment groups, prefixes, tenders, discounts, service charge |
| `public/` | UI (`index.html`, `app.css`, `app.js`) |

## Endpoints covered

Organisations: locations, revenue centres. Menus: summary, menu by ID. Configuration: tenders, discounts, service charges collections. Checks: connection status (HEAD), calculator, post, get, round. Collections take org/loc/RVC as query parameters; menus and checks take `Simphony-*` headers. The harness places them per endpoint, and you can edit headers and the raw body before sending.

Not covered: notifications (need a public inbound URL), employees, voiding checks.

## Schema assumptions

The docs pages are long and their examples are partly placeholder, so some field names are inferred. The UI reads menus tolerantly (it tries alternatives), but check these against the first live response:

- Menu item definitions keyed by `number` (also accepts `definitionSequence`, `sequence`).
- Condiment rules on a definition as `condimentGroupRules[]` with `condimentGroupRef`, `minimumCount`, `maximumCount`.
- Prefixes as a top-level `condimentPrefixes[]` with `prefixId`, `name`, `prefixType`.
- Collections, locations and menu summary returned as `{ items: [...] }` (plain arrays also accepted).
- Combo: `comboItem.menuItemId` is the combo's `menuItemRef`; main from the `isMainGroup` group, sides fill the other groups by `count`.

## Mock behaviour

A plausible imitation, not Oracle's logic: 10% additive tax on net; "No" prefix zeroes a condiment and does not count towards the group maximum; only Cash allows over-tender; Onion Rings (202) is unavailable on purpose to show `menu_item_not_available`; duplicate idempotency IDs return the cached check when `detect-duplicate-request` is sent; prefixes are dropped on post without `enable-condiment-prefix`. Use **Simulate expiry** on the Auth step to test the 401 and replay path.
