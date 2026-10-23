# EduFlow API — Authentication & Multi-Tenant Identity

Express 5 + MongoDB (Mongoose) + JWT. A **tenant** is a school, tuition center or
coaching institute. A **user** can belong to several tenants, with a different
**role** in each (`owner`, `admin`, `teacher`, `accountant`) through a **membership**.

## Run locally

Requires Node.js 20.6+ (tested on 24) and a MongoDB Atlas cluster (or a local
replica set, because registration uses a transaction).

```bash
npm install
cp .env.example .env        # then fill in MONGODB_URI and the two JWT secrets
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # run twice, one per secret
npm run db:indexes          # creates MongoDB indexes (required in production)
npm run dev                 # http://localhost:5000
```

The server refuses to start if a required variable is missing or invalid.

Packages: `express`, `cors`, `helmet`, `cookie-parser`, `express-rate-limit`,
`mongoose`, `jsonwebtoken`, `bcryptjs`, `zod`.

## Structure

```text
src/
├── config/        env.js (validated env vars), database.js
├── models/        User, Tenant, Membership, Session, AuditLog, Student, Attendance,
│                  FeePlan, Invoice, Payment, Counter, WhatsAppConfig, WhatsAppMessage
├── middleware/    authenticate, authorize, requireSuperAdmin, ipAllowlist, validate, rateLimit, errorHandler
├── modules/
│   ├── auth/      routes, controller, service, validation
│   ├── admin/     super admin routes, controller, service, validation
│   ├── students/  student CRUD + CSV import
│   ├── attendance/ daily registers and reports
│   ├── fees/      fee plans, dues, payments, receipts
│   ├── whatsapp/  messages to parents (click-to-send + Cloud API)
│   └── tenant/    example protected routes
├── utils/         jwt, password, cookies, crypto, AppError
├── app.js
└── index.js
scripts/sync-indexes.js, scripts/superadmin.js
```

## How it works

| Token | Where it lives | Lifetime | Contents |
|---|---|---|---|
| Access token | Response body → keep in memory, send as `Authorization: Bearer` | 15 min | `{ sub, tenantId, role, type: "access" }` |
| Refresh token | `eduflow_rt` cookie (HttpOnly, Secure in prod, SameSite, `Path=/api/auth`) | 30 days | `{ sub, sid, jti, type: "refresh" }` |
| Tenant-selection token | Response body of a multi-tenant login | 5 min | `{ sub, type: "tenant_selection" }`, only accepted by `/select-tenant` |

- **Sessions.** Each login creates a `Session` document. The refresh token is
  never stored; only a SHA-256 hash of its `jti` is. Logout revokes the session.
- **Rotation and reuse detection.** Every `/refresh` issues a new refresh token.
  If an already-rotated token is presented again (after a 30 s grace period
  for concurrent tabs), the token is treated as stolen and **all of the user's
  sessions are revoked**.
- **Tenant is never trusted from the client.** Protected routes read
  `req.user.tenantId` from the verified token. `/select-tenant` and `/refresh`
  always re-check the membership and that the tenant and user are active, so a
  removed member or a changed role takes effect at the next refresh (≤ 15 min).
- **Rate limits (per IP).** Login and select-tenant: 10 per 15 min. Register: 5 per hour.
  Refresh: 60 per 15 min.
- **Passwords.** bcrypt (cost 12). At least 8 characters, with upper case,
  lower case, a digit and a symbol, and at most 72 bytes. Login errors are
  generic, and timing is equalised for unknown emails.

## Endpoints

All errors have the shape `{ "error": { "code": "...", "message": "...", "details"?: [...] } }`.

### `POST /api/auth/register`

```http
POST /api/auth/register
Content-Type: application/json

{ "name": "Alice Khan", "email": "alice@example.com", "password": "Str0ng!Pass", "tenantName": "Sunrise Public School" }
```

`tenantName` is optional (defaults to "`<name>`'s Organization").

`201 Created` and `Set-Cookie: eduflow_rt=...; Path=/api/auth; HttpOnly; SameSite=Strict`

```json
{
  "user": { "id": "665f…a1", "name": "Alice Khan", "email": "alice@example.com", "isActive": true, "createdAt": "…", "updatedAt": "…" },
  "tenant": { "id": "665f…b2", "name": "Sunrise Public School", "slug": "sunrise-public-school" },
  "role": "owner",
  "accessToken": "eyJhbGciOi…",
  "accessTokenExpiresAt": "2026-10-22T07:15:00.000Z"
}
```

Errors: `400 VALIDATION_ERROR` (with `details`), `409 EMAIL_TAKEN`, `429`.

### `POST /api/auth/login`

```json
{ "email": "alice@example.com", "password": "Str0ng!Pass" }
```

**One tenant.** `200` + cookie, same body as register plus `"requiresTenantSelection": false`.

**Several tenants.** `200`, with no cookie and no access token yet:

```json
{
  "requiresTenantSelection": true,
  "user": { "id": "665f…a1", "name": "Alice Khan", "email": "alice@example.com", "…": "…" },
  "tenants": [
    { "id": "665f…b2", "name": "Sunrise Public School", "slug": "sunrise-public-school", "role": "owner" },
    { "id": "665f…c3", "name": "Bright Tuition Centre", "slug": "bright-tuition-centre", "role": "teacher" }
  ],
  "selectionToken": "eyJhbGciOi…"
}
```

Errors: `401 INVALID_CREDENTIALS` (same for a wrong password, an unknown email
or a disabled account), `403 NO_ACTIVE_TENANT`, `429`.

### `POST /api/auth/select-tenant`

Send the `selectionToken` from login, **or** a current access token to switch tenants.

```http
POST /api/auth/select-tenant
Authorization: Bearer <selectionToken or accessToken>
Content-Type: application/json

{ "tenantId": "665f…c3" }
```

`200` + new cookie. The body has the same shape as login, with that tenant's `role`.
When switching, the previous session is revoked.

Errors: `401` (missing/invalid token), `403 TENANT_ACCESS_DENIED` (not a
member, or the tenant is inactive or doesn't exist).

### `POST /api/auth/refresh`

No body. The browser sends the cookie automatically (use `credentials: "include"`).

`200` with `{ user, tenant, role, accessToken, accessTokenExpiresAt }`, plus a rotated cookie.

Errors: `401 REFRESH_TOKEN_MISSING | REFRESH_TOKEN_INVALID | REFRESH_TOKEN_REUSED`. The cookie is cleared, so send the user to login.

### `POST /api/auth/logout`

No body. Revokes the session, clears the cookie and returns `204 No Content`.

### `GET /api/auth/me`

`Authorization: Bearer <accessToken>` returns `200 { user, tenant, role }`.

### Example protected routes ([src/modules/tenant/tenant.routes.js](src/modules/tenant/tenant.routes.js))

```js
router.get("/", authenticate, handler);                                       // any member
router.get("/members", authenticate, authorize("owner", "admin"), handler);   // owners/admins
```

- `GET /api/tenant` returns the current tenant.
- `GET /api/tenant/members` lists the members of the current tenant. Any other role gets `403 FORBIDDEN`.

Status codes: `401` for a missing, invalid or expired token (`TOKEN_MISSING`,
`TOKEN_INVALID`, `TOKEN_EXPIRED`), and `403` for a role that isn't allowed.

## Frontend flow

1. Register or log in. If `requiresTenantSelection` is true, show the tenant
   picker and call `/select-tenant` with the `selectionToken`.
2. Keep `accessToken` **in memory** (not `localStorage`). Send it as `Authorization: Bearer`.
3. On a `401 TOKEN_EXPIRED`, or on page load, call `POST /api/auth/refresh`
   with `credentials: "include"`, then retry the request. Share one in-flight
   refresh promise across requests.
4. Logout: `POST /api/auth/logout` with `credentials: "include"`.

## Students ([src/modules/students](src/modules/students))

Students belong to the tenant in the access token; a student of another tenant
is simply "not found". Every member can read, only `owner` and `admin` can write
(others get `403 FORBIDDEN`). Admission numbers are unique per tenant.

| Method | Route | Body / query | Notes |
|---|---|---|---|
| GET | `/api/students` | `?search=&grade=&section=&status=active\|inactive\|graduated\|left\|all&sort=newest\|oldest\|name\|admissionNo\|grade&page=&limit=` | search matches name, admission no, phones, emails, guardian; every word must match |
| GET | `/api/students/filters` | | distinct `grades`, `sections` and `counts` per status |
| GET | `/api/students/export` | same filters and `sort` as the list, no paging | **owner/admin only**; `{ students, total, truncated }`, at most 10 000 rows |
| GET | `/api/students/:studentId` | | |
| POST | `/api/students` | `{ admissionNo, firstName, lastName?, gender?, dateOfBirth?, grade?, section?, rollNo?, email?, phone?, guardianName?, guardianPhone?, guardianEmail?, address?, admissionDate?, status?, notes? }` | `201`; `409 ADMISSION_NO_TAKEN` |
| PATCH | `/api/students/:studentId` | any of the fields above | `null` clears an optional field |
| DELETE | `/api/students/:studentId` | | `204` |
| POST | `/api/students/import` | `{ students: [ {...fields} ], onDuplicate: "skip"\|"update" }` | max 1000 rows / 2 MB per request |

Dates are `YYYY-MM-DD`. Import validates each row separately and returns
`{ total, created, updated, skipped, failed: [{ row, admissionNo, errors }] }`,
where `row` is the 1-based data row. The frontend reads CSV or Excel (.xlsx/.xls)
files in the browser and sends the rows as JSON, in batches of 1000. Export
files use the same column headers, so an exported file can be edited and
imported again.

## Attendance ([src/modules/attendance](src/modules/attendance))

One record per student per day (`date` is `YYYY-MM-DD`, the school's calendar
day). A "class" is a student's `grade` + `section`; the record keeps a snapshot
of both, so history survives a class change. Status is `present`, `absent`,
`late` or `leave`. Attendance rate = (present + late) / (present + late + absent);
approved leave is not counted.

| Method | Route | Body / query | Notes |
|---|---|---|---|
| GET | `/api/attendance/classes` | `?date=` | every class with its student count, marks and rate for that day; `unassigned` = active students with no class |
| GET | `/api/attendance/register` | `?date=&grade=&section=` | the class list (by roll no) with each student's mark, `summary`, `lastMarked`, `canEdit` + `reason` |
| PUT | `/api/attendance/register` | `{ date, grade, section, entries: [{ studentId, status, note? }] }` | upserts marks; returns the updated register. Omitting `note` keeps the saved note |
| GET | `/api/attendance/report` | `?grade=&section=&from=&to=` | per-student counts, rate and day-by-day statuses; max 92 days |
| GET | `/api/attendance/students/:studentId` | `?from=&to=` | one student's marks and totals; max 92 days |

Who can mark: owners and admins (any past day), teachers (today and the last 7
days). Accountants can only view. Future dates are refused with
`403 ATTENDANCE_LOCKED`; a student who isn't in the class gives
`400 STUDENT_NOT_IN_CLASS`.

## Fees ([src/modules/fees](src/modules/fees))

Owners, admins and accountants only (teachers get `403`). **All amounts are
integers in paise** (₹1 = 100), so totals never have rounding errors.

- **Fee plan:** installments, each with a label, due date (`YYYY-MM-DD`) and
  items (`{ name, amount }`).
- **Assigning** a plan creates a **due** (invoice) per student per installment.
  It copies the amounts, so later plan edits don't change existing dues. It's
  idempotent: students who already have the plan are skipped.
- **Balance** of a due = `amount - discount - paid`. A due is `overdue` when
  `dueDate < today` and the balance is above zero. List endpoints accept
  `?today=YYYY-MM-DD` so "overdue" matches the school's calendar.
- **Payments** are split across dues (given `allocations`, or oldest due first).
  The payment, the dues and the receipt number (`R00001`, per school) are saved
  in **one transaction**. Each due is updated with a guarded `$inc`, so two
  simultaneous payments can never overpay it (the loser gets `409 DUES_CHANGED`).
- **Voiding** (owner/admin only, with a reason) keeps the payment on record and
  puts its amounts back onto the dues, in a transaction.

| Method | Route | Body / query | Notes |
|---|---|---|---|
| GET | `/api/fees/summary` | `?from=&to=&today=` | collected (by mode, by day), billed/paid/balance/overdue, class-wise, next 30 days, recent payments |
| GET | `/api/fees/plans` | `?archived=false\|true\|all` | with `stats: { students, billed, paid }` |
| POST | `/api/fees/plans` | `{ name, academicYear?, grade?, description?, installments: [{ label, dueDate, items: [{ name, amount }] }] }` | `201` |
| GET / PATCH / DELETE | `/api/fees/plans/:planId` | PATCH: any plan field or `archived`; keep `_id` on installments you edit | removing an installment with dues → `409 INSTALLMENT_IN_USE`; deleting a plan with dues → `409 PLAN_IN_USE` (archive instead) |
| POST | `/api/fees/plans/:planId/assign` | `{ grade, section? }` **or** `{ studentIds }`, plus optional `concession: { type: "percent"\|"amount", value, reason }` | `{ students, created, skipped }` |
| GET | `/api/fees/register` | `?search=&grade=&section=&status=all\|overdue\|due\|paid\|none&sort=name\|balance\|overdue\|grade&page=&limit=&today=` | per-student billed/discount/paid/balance/overdue/nextDue, plus `totals` |
| GET | `/api/fees/students/:studentId` | `?today=` | the student's dues, payments and totals |
| PATCH | `/api/fees/dues/:invoiceId` | `{ discount?, discountReason?, dueDate? }` | discount can't exceed the unpaid part |
| DELETE | `/api/fees/dues/:invoiceId` | | only if nothing paid (`409 DUE_HAS_PAYMENTS`) |
| POST | `/api/fees/payments` | `{ studentId, amount, date, mode, reference?, note?, allocations?: [{ invoiceId, amount }] }` | `201` with the receipt; modes: `cash, upi, card, bank, cheque, other` |
| GET | `/api/fees/payments` | `?from=&to=&mode=&search=&includeVoided=&page=&limit=` | `totals` exclude voided payments |
| GET | `/api/fees/payments/export` | same filters, no paging | up to 20 000 rows |
| GET | `/api/fees/payments/:paymentId` | | receipt: payment, school name, current balance |
| POST | `/api/fees/payments/:paymentId/void` | `{ reason }` | owner/admin only |

## WhatsApp ([src/modules/whatsapp](src/modules/whatsapp))

Fee receipts, fee reminders, absence/late alerts and monthly attendance reports
to parents (the student's `guardianPhone`). Each school picks a mode in
Settings → WhatsApp:

- **`link` (default, click-to-send):** free, no setup. The app opens
  `https://wa.me/<number>?text=…` with the message ready, and staff press Send.
- **`api` (automatic):** sent through the school's own WhatsApp Business number
  (Meta Cloud API) using approved **Utility** templates. Delivery and read ticks
  come back through the webhook.

Messages are always built on the server from its own records. The client only
sends references (`paymentId`, `studentId`, `studentId + date`,
`studentId + month`), never message text. Fee messages: owner/admin/accountant;
attendance messages: owner/admin/teacher; settings and history: owner/admin.

| Method | Route | Body / query | Notes |
|---|---|---|---|
| POST | `/api/whatsapp/prepare` | `{ type, refs, today? }` | recipients with `text`, `wa.me` `link`, `skip` reason (no phone, nothing due, present…) and `last` send |
| POST | `/api/whatsapp/send` | `{ type, refs, today? }` | API mode only; sends ≤5 at a time, `{ results, sent, failed, skipped }` |
| POST | `/api/whatsapp/log` | `{ type, entries: [{ refKey, studentId?, to? }] }` | records "opened in WhatsApp" for click-to-send |
| GET / PUT | `/api/whatsapp/settings` | `{ mode, defaultCountryCode, phoneNumberId, displayPhone, accessToken, templates: { <type>: { name, language } } }` | the token is write-only: encrypted with AES-256-GCM, never returned |
| POST | `/api/whatsapp/settings/test` | `{ to }` | sends Meta's `hello_world` |
| GET | `/api/whatsapp/messages` | `?type=&page=&limit=` | message history |
| GET / POST | `/api/whatsapp/webhook` | Meta verification / status callbacks | public; POST requires a valid `X-Hub-Signature-256` |

`type` is `fee_receipt`, `fee_reminder`, `absence` or `attendance_summary`.
Phone numbers are normalised to digits with the school's country code (default
`91`) added to 10-digit numbers.

**Platform setup for automatic sending** (once, by whoever runs the server):

1. Set `DATA_ENCRYPTION_KEY` (stores each school's access token encrypted).
   Changing it later makes saved tokens unreadable, and schools must re-enter them.
2. For delivery/read ticks, in the Meta app's WhatsApp → Configuration set the
   callback URL to `https://<your-api>/api/whatsapp/webhook`, choose a verify
   token, and subscribe to `messages`. Then set `WHATSAPP_VERIFY_TOKEN` and
   `WHATSAPP_APP_SECRET` (App settings → Basic → App secret).
3. `WHATSAPP_GRAPH_VERSION` defaults to `v22.0`. Raise it when Meta retires that version.

Each school then enters its Phone number ID, a permanent System User token and
the four template names; Settings shows the exact template text to submit.

## Super admin (platform administration)

A super admin manages **every** tenant and user. This is a flag on the user
(`isSuperAdmin`), not a tenant role. It can **only** be set from the command line:

```bash
npm run superadmin -- create  --email admin@eduflow.com --name "Platform Admin"   # prompts for password
npm run superadmin -- promote --email someone@example.com
npm run superadmin -- revoke  --email someone@example.com
npm run superadmin -- list
```

Use a dedicated account. A super admin's login gives a **platform token**
(`{ sub, type: "platform", scope: "superadmin" }`) instead of a tenant token.

- Platform tokens only work on `/api/admin/*`, and tenant tokens never work there.
- Every admin request re-checks `isSuperAdmin` in the database, so `revoke` takes effect immediately.
- The API cannot modify a super admin account. Use the CLI.
- Every admin action is written to the `auditlogs` collection, with before and after values.
- Rate limit: 300 requests per 15 min. Set `ADMIN_IP_ALLOWLIST` to limit which IPs can reach `/api/admin`.

All routes below need `Authorization: Bearer <platform token>`.

| Method | Route | Body / query | Notes |
|---|---|---|---|
| GET | `/api/admin/me` | | |
| GET | `/api/admin/stats` | | tenant/user counts, signups in the last 30 days, active sessions |
| GET | `/api/admin/tenants` | `?search=&status=active\|inactive\|all&page=&limit=` | includes `memberCount` |
| GET | `/api/admin/tenants/:tenantId` | | tenant + members |
| PATCH | `/api/admin/tenants/:tenantId` | `{ name?, isActive? }` | suspending logs everyone out of the tenant |
| POST | `/api/admin/tenants/:tenantId/enter` | | returns a 15-min tenant token (role `owner`, `impersonation: true`) for the normal tenant routes |
| GET | `/api/admin/tenants/:tenantId/members` | | |
| POST | `/api/admin/tenants/:tenantId/members` | `{ email, role }` | add an existing user |
| PATCH | `/api/admin/tenants/:tenantId/members/:userId` | `{ role }` | can't demote the last owner |
| DELETE | `/api/admin/tenants/:tenantId/members/:userId` | | can't remove the last owner |
| GET | `/api/admin/users` | `?search=&status=&page=&limit=` | includes `tenantCount`, `isSuperAdmin` |
| GET | `/api/admin/users/:userId` | | user + their tenants |
| PATCH | `/api/admin/users/:userId` | `{ name?, isActive? }` | deactivating logs them out everywhere |
| POST | `/api/admin/users/:userId/reset-password` | `{ password }` | sets a new password, ends all sessions, returns `204` |
| GET | `/api/admin/audit-logs` | `?action=&actorId=&targetId=&page=&limit=` | newest first |

## MongoDB indexes

| Collection | Index | Purpose |
|---|---|---|
| users | `{ email: 1 }` unique | login lookup, one account per email |
| tenants | `{ slug: 1 }` unique | URL-safe identifier |
| memberships | `{ userId: 1, tenantId: 1 }` unique | one role per user per tenant; finds a user's tenants |
| memberships | `{ tenantId: 1, role: 1 }` | list or filter a tenant's members |
| sessions | `{ userId: 1 }` | revoke all of a user's sessions |
| sessions | `{ tenantId: 1 }` | log everyone out of a suspended tenant |
| sessions | `{ expiresAt: 1 }` TTL | MongoDB deletes expired sessions automatically |
| students | `{ tenantId: 1, admissionNo: 1 }` unique, `{ tenantId, createdAt }`, `{ tenantId, grade, section }`, `{ tenantId, status }` | one admission no per tenant; list, filter |
| attendances | `{ tenantId, studentId, date }` unique, `{ tenantId, date, grade, section }`, `{ tenantId, grade, section, date }` | one mark per student per day; a day's registers; class reports |
| feeplans | `{ tenantId, archived, createdAt }` | plan list |
| invoices | `{ tenantId, studentId, planId, installmentId }` unique, `{ tenantId, studentId, dueDate }`, `{ tenantId, dueDate }`, `{ tenantId, planId }` | an installment is charged once per student; ledgers; overdue; plan stats |
| payments | `{ tenantId, receiptNo }` unique, `{ tenantId, date }`, `{ tenantId, studentId, date }` | receipt lookup; collections by date; a student's payments |
| counters | `{ tenantId, key }` unique | per-school receipt numbers |
| whatsappconfigs | `{ tenantId }` unique | one settings document per school |
| whatsappmessages | `{ tenantId, type, refKey, createdAt }`, `{ tenantId, createdAt }`, `{ waMessageId }` sparse | "already messaged" checks; history; webhook status updates |
| auditlogs | `{ createdAt: -1 }`, `{ actorId, createdAt }`, `{ targetId, createdAt }`, `{ action, createdAt }` | browse and filter the audit trail |

In development Mongoose builds these automatically. In production `autoIndex`
is off, so run `npm run db:indexes` on each deploy.

## Production checklist

- `NODE_ENV=production`. This makes the cookie `Secure`, so the API must be served over HTTPS.
- Set `CORS_ORIGINS` to your real frontend origin(s).
- If the frontend is on a different **site** (not just a subdomain), set
  `COOKIE_SAMESITE=none`. Otherwise keep `strict` or `lax`.
- Behind a proxy or load balancer, set `TRUST_PROXY=1` so rate limiting sees real client IPs.
- With more than one API instance, switch `express-rate-limit` to a shared store (for example Redis).
# EduFlowBackend
# EduFlowBackend
