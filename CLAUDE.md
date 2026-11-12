# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A multi-channel reminder app branded **Rymind** (the directory/slug "Reminder-App"/"remindly" is legacy — UI and API title say "Rymind"). A user schedules reminders that fire at a time and repeat on an interval, delivered over any of four channels: Expo push notification, WhatsApp, SMS, email. Reminders can target the user ("self") or another person ("someone else").

Two clients share one backend:
- **`frontend/`** — the Expo / React Native mobile app (this repo).
- **A separate web companion app** (different repo, not here) that talks to the same backend. This is why backend changes affect both clients, while frontend changes do **not** carry over — when a change should also land on web, it's communicated as a hand-off "prompt" for the web repo's own agent.

## Repository layout

- `backend/server.py` — the **entire** backend in one ~1500-line file: FastAPI app, all Pydantic models, all routes, the scheduler, and the third-party delivery integrations. There is no package split; expect to edit this one file.
- `frontend/app/` — expo-router file-based routes (`(auth)/`, `(app)/`, `reminder/`). `frontend/src/` — shared non-route modules (API client, auth context, theme, UI primitives, feature helpers).
- `backend_test.py` (repo root) — a standalone integration test script that hits a **deployed** backend; see Testing below.
- `BUILD_GUIDE.md` — EAS build / push-notification setup. Accurate on concepts but contains stale placeholders (`/app/frontend` paths, `REPLACE_WITH_*`); the real values are already in `app.json`/`eas.json`.
- `README.md` — placeholder, ignore.

## Commands

This is a Windows dev environment (PowerShell). Use `py -3` for Python and `.\node_modules\.bin\tsc.cmd` if `npx tsc` misbehaves.

**Frontend** (run from `frontend/`):
- `npx expo start` — dev server (add `--web` for browser, `--tunnel` if phone and PC aren't on the same network, `--dev-client` for a dev build).
- `npm run typecheck` — `tsc --noEmit`. **Run this after any frontend edit**; it's the primary correctness gate (there is no frontend unit-test suite).
- `npm run lint` / `npm run check` (typecheck + lint).
- Requires `frontend/.env` with `EXPO_PUBLIC_BACKEND_URL=<backend url>` for local `expo start` — without it, API calls go to `undefined/api`. For EAS builds this var comes from `eas.json` per profile instead.

**Backend** (run from `backend/`):
- `py -3 -m py_compile server.py` — fast syntax check after editing (the backend deps are not installed in the local global Python, so this is the quick local gate).
- `uvicorn server:app --reload` — run the API. Requires MongoDB and env vars (`MONGO_URL`, `DB_NAME`, `JWT_SECRET_KEY`; optional `TWILIO_*`, `RESEND_*`, `CORS_ORIGINS`, `JWT_ALGORITHM`, `ACCESS_TOKEN_EXPIRE_MINUTES`). Missing Twilio/Resend creds is fine — those channels degrade gracefully.

## Release workflow (recurring)

1. Bump `version` in `frontend/app.json` (internal `versionCode`/build number auto-increment via EAS — don't touch those).
2. `eas build --platform all --profile production --auto-submit` (from `frontend/`) → builds both platforms and submits to Play internal testing + TestFlight. Then promote/submit in the store consoles.
3. **Backend changes require a Railway redeploy** to go live; they are not part of the app build.
4. **Native-module additions are not OTA-updatable** — adding a package with native code (e.g. `expo-store-review`, `expo-application`, `sp-react-native-in-app-updates`) requires a fresh EAS build, not just a JS push. Pure-JS changes ride the next build (no EAS Update / OTA is configured in this project).

Commits in this repo are split logically (backend vs frontend vs version bump) and pushed to `main`.

## Backend architecture (`server.py`)

- **Routing**: one `APIRouter(prefix="/api")` holds every REST route; mounted via `app.include_router(api)`. So all endpoints are under `/api/...`. Two raw `@app.websocket` endpoints sit outside the router.
- **DB**: MongoDB via `motor` (async). Collections: `users`, `reminders`, `contacts`, `reminder_logs`, `verification_codes`, `web_sessions`, plus billing: `credit_ledger`, `payments`, `channel_rates`, `email_campaigns`. Documents use a UUID `id` field (not Mongo `_id`, which is always projected out).
- **Scheduling** is the core engine:
  - `_compute_next_fire(r)` derives the next UTC fire time from `scheduled_at`, `lead_minutes`, `repeat_interval_hours`, and `triggered_count`. It guards against `timedelta` overflow (huge intervals) by returning `None` instead of crashing.
  - `_schedule_reminder_job` registers an APScheduler `DateTrigger` job (job id `reminder:<id>`); `_fire_reminder` delivers and reschedules the next occurrence.
  - On startup, the FastAPI `lifespan` re-schedules every `pending`/`active` reminder, so the scheduler survives restarts.
- **Reminder field semantics** (enforced by `ReminderCreate` and must be mirrored in any client-side validation):
  - `repeat_count`: `1` = fire once, `-1` = unlimited until stopped, `N` = N times (≤ 9999).
  - `repeat_interval_hours`: float, clamped `0.0167` (1 min) .. `43800` (5 years). Client unit dropdown maps minutes/hours/days/weeks/months/years to hours.
  - `target.is_self` decides self vs other; `contact_id` links a reminder to a saved contact (used to count/cascade on contact delete).
- **Delivery logic** in `_fire_reminder` (the trickiest part):
  - **Self**: all selected channels auto-send immediately (push via Expo, WhatsApp/SMS via Twilio, email via Resend).
  - **Other**: push is delivered to the recipient by **matching their phone** — `_phone_suffix()` normalizes to the last 10 digits and looks up a user with the same `phone_suffix`. WhatsApp/SMS/email for "other" are queued into the reminder's `pending_channels` for manual send by the creator, **and** the creator also receives their own copy on those channels (prefixed `(For <name>)`).
  - Third-party send failures are always caught and logged — a failing channel never crashes the scheduler.
- **Plans & credits** (one-time packs, spec in the client's "Rymind Plan" sheet): `PLANS` holds Free / Starter / Popular / Business. Free = push only and `FREE_ACTIVE_LIMIT` (10) active reminders, enforced by `_enforce_plan_limits` on create/update. Balance is `users.credits_tenths` (integer tenths, so 0.4-credit emails add up exactly); the effective plan is Free whenever the balance is 0.
  - Every server-sent WhatsApp/SMS/email (self sends and the creator's copy of "someone else" reminders) goes through `_send_paid`: atomic reserve, then send, then refund on failure, idempotent per reminder occurrence via `credit_ledger.idempotency_key`. Manual sends to the recipient (from the creator's own phone) are free. Running out triggers `_notify_credits_exhausted` once per depletion.
  - Rates depend on the account holder's own phone country: India (domestic) uses the sheet's fixed 80 SMS / 6 WhatsApp; other countries use Twilio's live Pricing API for SMS (cached a week in `channel_rates`) and the `WA_MARKET_RATE_USD` table for WhatsApp (update it when Meta revises rates). Email is 0.4 everywhere.
  - Payments: mobile via RevenueCat (`/billing/revenuecat/webhook` + `/billing/revenuecat/sync`), web via Razorpay (`/billing/razorpay/order|verify|webhook`, INR for +91 accounts, USD otherwise). All crediting goes through `_grant_credits` keyed on the provider transaction, so retries never double-credit. Env: `REVENUECAT_SECRET_KEY`, `REVENUECAT_WEBHOOK_AUTH`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
  - Accounts that predate billing get the Starter pack once as a welcome gift (`_migrate_existing_users_to_credits`, runs at startup).
  - Admin endpoints that expose PII or take action (`/admin/marketing-emails`, `/admin/billing/*`, `/admin/email/*`) are gated by `_require_admin` (`X-Admin-Key` = `ADMIN_KEY`).
- **Real-time**: `broadcast_to_user()` pushes JSON events (`reminder.fired`, `contact.updated`, etc.) over `/api/ws/user` to keep the **web companion** in live sync. `/api/ws/web-session/{id}` drives the QR pairing handshake (the mobile app scans a QR in `linked-devices.tsx` to sign the web app in). Rymind Web can also sign in with email+password via `POST /web-sessions/password-login`, which creates an already-approved web session so it still appears (and can be revoked) under Linked Devices.
- **Login brute-force guard**: `/auth/login` and the web password login share `_authenticate_password`, which locks an email after 5 failed attempts (30 per IP) for 15 minutes using the TTL'd `login_failures` collection. A password reset clears the lock.

## Frontend architecture

- **Routing**: expo-router. `app/_layout.tsx` wraps everything in `SafeAreaProvider` + `AuthProvider`. Route groups: `(auth)` (login/signup), `(app)` (dashboard, contacts, history, profile — tabbed), `reminder/` (create + detail).
- **Auth**: `src/auth.tsx` exposes `useAuth()` (`user`, `login`, `signup`, `logout`, `refresh`). Token persisted via `src/api.ts` (`AsyncStorage`). `apiFetch()` in `src/api.ts` is the single HTTP wrapper — it attaches the bearer token and flattens FastAPI/Pydantic 422 validation errors into readable messages, so prefer surfacing `e.message` directly.
- **Design system**: `src/theme.ts` (color/spacing/radius tokens) and `src/ui.tsx` (`Button`, `Input`, `Card`, `Chip`, `SectionTitle`, `Badge`). New screens should compose these rather than re-styling from scratch. Note Android renders elevation shadows through translucent card backgrounds — use opaque tints + `elevation:0` for tinted cards (see the danger card in `profile.tsx`).
- **The reminder wizard** `app/reminder/create.tsx` is the most complex screen: a 4-step flow (Event → Timing → Delivery → Target) that also handles the reschedule/prefill path. It owns the repeat-interval validation that mirrors the backend caps, the optional "Repeat Reminders" toggle, and the recipient phone rules (phone field shows/required only when a phone-based channel — push/WhatsApp/SMS — is selected; email-only hides it).
- **Phone handling**: `src/countries.ts` centralizes dial codes plus `isValidPhoneNumber` (7–15 digits), `phoneDigits`, and `splitPhone` (parse a stored `+CC…` back into code + number). Contacts store phone in full international form.
- **Billing**: `src/billing.tsx` (`BillingProvider` / `useBilling()`) loads `/billing/me` and wraps RevenueCat (`react-native-purchases`, keys from `EXPO_PUBLIC_REVENUECAT_IOS_KEY` / `_ANDROID_KEY` in `eas.json`). Screens: `app/plans.tsx` (popular pack has the `src/Shine.tsx` sweep) and `app/credits.tsx` (history). The wizard locks paid channels on Free and shows per-message costs.
- **Native client features**: `src/rating.ts` (store-review prompt after 5 reminders or 3 days), `src/appUpdate.ts` (soft in-app update prompt). Both no-op silently outside a real store build and are mounted on the dashboard.

## Cross-cutting conventions

- **Validate on both ends.** A client-only cap is not enough — out-of-range values reaching the backend previously caused scheduler overflow / 500s. Backend Pydantic bounds are the real guard; client validation exists to give friendly messages before the request.
- **Keep mobile and the shared backend in sync, and flag web parity.** When a change touches behavior the web companion also needs, prepare a hand-off description for the web repo (the web app cannot inherit frontend code from here).
- **Phone identity is last-10-digits.** Cross-user matching (push to "someone else", deduping) keys off `_phone_suffix`, not the full string.
