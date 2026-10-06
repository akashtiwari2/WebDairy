# Phase 1 synthetic development API

Go binds to 127.0.0.1:8080; Angular proxies `/api` from port 4200. Requests use
same-origin browser fetch. No permissive CORS is enabled. Only loopback Host names
on these ports are accepted. Writes require matching `Origin: http://<Host>` and
`Content-Type: application/json`. Origin checks do not replace account authentication,
which belongs to Phase 2. All responses use `Cache-Control: no-store`.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/health` | Database migration 4 readiness; 503 if unavailable |
| GET | `/api/entries` | `{ "dates": ["2030-10-20", ...] }`, active dates only |
| GET | `/api/entries/:date` | Date, title, body, revision, UTC created_at/updated_at; 404 if absent |
| PUT | `/api/entries/:date` | Create/update atomically; return the committed entry |
| DELETE | `/api/entries/:date` | Confirmed revision deletion, 204; stale revision 409; absent 404 |

## Save request

```json
{
  "title": "Synthetic future plan",
  "body": "Sample text only",
  "expected_revision": 0,
  "operation_id": "11111111-1111-4111-8111-111111111111"
}
```

Revision 0 creates only if the date has no active entry. Updates require the last
confirmed positive revision. One SQL operation checks and changes the revision.
The browser uses a fresh random UUID per captured write and reuses it only when
retrying that same request after an unconfirmed response. Retry returns the same
committed revision if operation ID, original expected revision and content match.
It never increments twice. Committed operation IDs and request hashes are retained after deletion, so a delayed retry cannot resurrect a deleted entry. If another write has superseded it, retry conflicts.

A stale write/delete returns `409` with `{ "error": "revision_conflict", "current":
<entry-or-null> }`. `current: null` means the entry was deleted. The client preserves
its draft and requires an explicit resolution. Recreating a deleted date continues
its revision sequence; a stale editor cannot overwrite the replacement. Tombstones
retain only the date/revision metadata and clear title/body. Phase 1 has no trash.

DELETE JSON is `{ "expected_revision": 3 }`. The client treats a missing entry as
an already completed deletion when retrying after a lost response.

Civil dates must be real YYYY-MM-DD dates, years 0001–9999, including past/future
and leap dates. The server rejects unknown JSON fields, trailing data, empty or
whitespace-only entries, titles over 200 Unicode characters, bodies over 1 MiB
UTF-8, unsafe/negative revisions, and invalid operation UUIDs. JSON cap is 2 MiB.
Errors: 400 invalid request, 403 untrusted local origin/host, 404 absent entry,
409 stale revision, 413 oversized request, 503 database unavailable. No database
credentials, SQL errors or submitted bodies are included in error responses/logs.

This API deliberately operates on plaintext **synthetic** `development_entries`,
separately from future encrypted vault storage. It is not a private diary API.
