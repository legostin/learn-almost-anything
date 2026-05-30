# Learn (Almost) Anything Catalog

Small dependency-free Node service for the public course catalog.

Environment:

- `PORT` default `8080`
- `HOST` default `127.0.0.1`
- `PUBLIC_ORIGIN` default `https://catalog.almost-anything.io`
- `CATALOG_DATA_DIR` default `data`
- `CATALOG_UPLOAD_TOKEN` bearer token required for write endpoints. Publishing is disabled with `503` when this is empty.
- `CATALOG_WRITE_RATE_LIMIT` default `30` write attempts per client window
- `CATALOG_WRITE_RATE_WINDOW_MS` default `3600000`
- `CATALOG_MAX_UPLOAD_BYTES` default `83886080`

API:

- `GET /api/courses` or `GET /api/catalog` lists published course summaries.
- `GET /api/courses/:id` returns one course summary.
- `GET /api/courses/:id/download` returns the `.laacourse` package.
- `POST /api/courses` creates or updates a course package using `package.course.id`.
- `PUT /api/courses/:id` creates or updates a specific course package.

Course packages are stored under `CATALOG_DATA_DIR`; publishing never creates git commits.
Public catalog reads do not require auth. Only the app/server-side publishing path should know `CATALOG_UPLOAD_TOKEN`.

Run:

```bash
npm start
```
