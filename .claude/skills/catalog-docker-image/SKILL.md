---
name: catalog-docker-image
description: Build and push the catalog Docker image (legostin/laa-catalog) used by private/self-hosted catalogs. Use when asked to rebuild, publish, or update the catalog Docker image, or to ship a catalog change to private catalog operators.
---

# Build & push the catalog Docker image

`legostin/laa-catalog` is the image **private / self-hosted catalogs** run
(README → "Private deployment (Docker)"). It is **not** how the public catalog
(catalog.almost-anything.io) updates — that deploys automatically via the
catalog repo's `.github/workflows/deploy.yml` (rsync + `npm ci && npm run build`
+ systemd restart) on every push to `main`. **No CI builds this image** — it is
a manual step, so run this skill whenever private catalogs need the latest code.

## Repo

The catalog is a **separate repo**: `/Users/legostin/claude-projects/learn-almost-anything-catalog`
(origin `git@github.com:legostin/learn-almost-anything-catalog.git`). The
`Dockerfile` there runs `npm ci && npm run build`, binds `0.0.0.0:8080`, and
stores SQLite data on a `/data` volume.

## Prerequisites (verify, set up if missing)

- Docker daemon running: `docker version`.
- Logged into Docker Hub as **legostin** (the image namespace). Check:
  `security find-internet-password -s index.docker.io 2>/dev/null | grep '"acct"'`
  → expect `legostin`. If not, ask the user to run `! docker login`.
- A buildx builder that supports linux/amd64 + linux/arm64. Check `docker buildx ls`;
  if none, create one: `docker buildx create --name laa-builder --use --bootstrap`.

## Build & push (multi-arch)

Build for **both** linux/amd64 and linux/arm64 — private catalog servers are
usually amd64 (some are ARM/Graviton). `--push` writes a multi-arch manifest
directly (you cannot `--load` a multi-arch image locally).

```bash
cd /Users/legostin/claude-projects/learn-almost-anything-catalog
git fetch origin --quiet && git merge --ff-only origin/main   # build from current main
SHA=$(git rev-parse --short HEAD)
docker buildx build --platform linux/amd64,linux/arm64 \
  -t legostin/laa-catalog:latest \
  -t "legostin/laa-catalog:$SHA" \
  --push .
```

Tag both `:latest` (the pull tag operators use) and `:<git-short-sha>`
(immutable, traceable). Build the working tree of a **clean** `main` — confirm
`git status --short` is empty first. Run in the background (emulated amd64
`npm ci` + `next build` takes a few minutes) and report when it finishes.

## Verify

```bash
docker buildx imagetools inspect legostin/laa-catalog:latest
```

Confirm the manifest lists `linux/amd64` and `linux/arm64`, and that the
`Digest:` changed from the previous build (i.e. the new code is in).

## How operators pick it up (mention in your report)

A running private catalog updates with:

```bash
docker pull legostin/laa-catalog:latest
docker rm -f laa-catalog
docker run -d --name laa-catalog -p 8080:8080 \
  -e PUBLIC_ORIGIN=... -e CATALOG_UPLOAD_TOKEN=... \
  -v laa-catalog-data:/data legostin/laa-catalog:latest
```

The `/data` volume (SQLite) persists across the recreate.
