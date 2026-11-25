# Dibi Party: invitation + RSVP

    PORT=3000 ADMIN_KEY=<secret> node server.mjs   # DATA_FILE=... to move the store
    node --test                                    # runs server.test.mjs

- Guests answer at `/`. One entry per phone number; re-submitting updates it.
- Host list and totals: `GET /api/rsvps` with header `x-admin-key: <secret>` (or `?key=`). Disabled if ADMIN_KEY is unset.
- Data: `data/rsvps.json` (gitignore it, it holds phone numbers).
- To edit copy (arrival time, address note), edit `index.html` directly.
