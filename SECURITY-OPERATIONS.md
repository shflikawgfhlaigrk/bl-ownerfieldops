# OwnerFieldOps security configuration

The server now requires owner or worker sign-in for business APIs. Before a
reviewed deployment, configure `OFO_OWNER_PASSWORD` with at least 16 characters
in the server environment or its private `.env`. An empty or shorter value
leaves owner access disabled. No default password or existing customer data is
included. Open `/login.html` to sign in. Workers use their owner-provided ID and
PIN; a blank/unconfigured PIN does not grant a session.

Sessions last eight hours, use random credentials stored as hashes, and use
HttpOnly, SameSite=Strict cookies. Worker deactivation or PIN changes revoke
their sessions. Owner password rotation invalidates existing owner sessions.
Workers can operate their own clock and assigned jobs, checklists and photos;
owner authority is required for business records and selecting other workers.

The default listener is `127.0.0.1`. Network deployment is an explicit
configuration using `OFO_BIND_HOST`; authentication remains required. For an
HTTPS reverse proxy, set `OFO_PUBLIC_ORIGIN` to its exact origin (without a
trailing slash), which also enables secure cookies. Browser writes require
same-origin JSON. Existing plain external API clients must authenticate and
send `Content-Type: application/json`, including DELETE requests.

Private photographs retain their existing filenames, but `/uploads/<filename>`
now requires an owner or assigned-worker session. Customer API responses
provide a `url` scoped to the existing customer portal token. Customer download
routes always enforce that token's customer, even if another session is also
present. Photo responses are not publicly cached. Existing remote caches and
previously downloaded copies were not inspected or changed.

Both upload paths share these defaults:

| Budget | Count | Bytes |
| --- | ---: | ---: |
| Single file | 1 | 15 MiB |
| Job | 50 | 200 MiB |
| Customer across jobs | 300 | 1 GiB |
| Entire installation | 10,000 | 10 GiB |

At least 512 MiB is reserved on the data and upload volumes. Overrides are
positive integers named `OFO_PHOTO_FILE_BYTES`, `OFO_PHOTO_JOB_COUNT`,
`OFO_PHOTO_JOB_BYTES`, `OFO_PHOTO_CUSTOMER_COUNT`, `OFO_PHOTO_CUSTOMER_BYTES`,
`OFO_PHOTO_GLOBAL_COUNT`, `OFO_PHOTO_GLOBAL_BYTES`, and
`OFO_PHOTO_RESERVE_BYTES`. Inventories and reservations run under a SQLite
writer transaction. Existing orphan files remain counted. Unexpected symlinks
or directories stop further uploads for review. No legacy files were swept.
Deleting a photo or its deletable job reclaims its file; an interrupted cleanup
can leave a counted orphan requiring operator review.

`OFO_DB_PATH` selects a database; its default accompanying photo directory is
`uploads` beside that database. `OFO_UPLOADS_DIR` explicitly selects a different
server-owned directory. Test runs use temporary paths and synthetic records.

CSV exports prefix formula-like strings as literal text and preserve numeric
values and quoted delimiters. Email uses pinned Nodemailer with verified
single-mailbox fields, no header controls, required TLS and protocol framing.
SMTP acceptance and recipient delivery remain separate facts. Quote approval
requires a valid unexpired UTC date in its conditional database transition.

`npm test` exercises source behavior, synthetic HTTP/SMTP, and mocked login
form interactions. It does not deploy, start the production automation loop,
send real messages, or establish installed/browser acceptance. This checkout
still lacks the existing `portal.html`, `invoice-print.html`, `reports.js`, and
`settings.js` pages referenced by the app. Missing optional page imports are
deferred so they do not prevent the sign-in screen or available app pages from
loading. Those missing pages remain separate product-readiness work.
