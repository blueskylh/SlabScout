# SlabScout

Surf Studio dashboard for the Renaiss OS Index API. SlabScout monitors graded-card indices, featured movers, search results, slab cert lookup, FMV history, source quality, and recent realized sales.

## What is included

- React + Vite frontend using the Surf Studio template styling tokens.
- Express backend route mounted at `/api/renaiss/*` through `@surf-ai/sdk/server`.
- Server-side Renaiss OS API proxy so `X-Api-Key` and `X-Api-Secret` never reach the browser.
- In-memory TTL cache and safe allowlisted endpoint routing for fast dashboard refreshes.
- Index chart, card FMV chart, movers grid, search workflow, graded cert lookup, recent trade tape, and card valuation panel.

## Environment

Copy the examples and fill deployment secrets in the platform environment, not in git:

```bash
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
```

Backend variables:

| Var | Required | Purpose |
| --- | --- | --- |
| `BACKEND_PORT` | yes | Express backend port. |
| `RENAISS_API_BASE_URL` | no | Defaults to `https://api.renaissos.com`. |
| `RENAISS_API_KEY` | recommended | Renaiss partner key id (`X-Api-Key`). |
| `RENAISS_API_SECRET` | recommended | Renaiss partner secret (`X-Api-Secret`). |
| `SURF_API_KEY` | optional | Surf SDK runtime/admin token for protected runtime endpoints. |

Frontend variables:

| Var | Required | Purpose |
| --- | --- | --- |
| `PORT` | dev | Vite dev server port. |
| `BACKEND_PORT` | yes | Backend proxy target port. |
| `BASE_PATH` | yes | Surf Studio base path; `/` locally. |

## Local development

Install and run backend:

```bash
cd backend
npm install
npm run dev
```

Install and run frontend in another terminal:

```bash
cd frontend
npm install
npm run dev
```

## Checks

```bash
cd frontend
npm run type-check
npm run lint
npm run build

cd ../backend
node -c server.js
node -c routes/renaiss.js
```

## Deployment notes

Set `RENAISS_API_KEY` and `RENAISS_API_SECRET` as backend environment variables in Surf Studio. The frontend only calls relative `/api/renaiss/*` paths, so credentials stay server-side and the app remains portable under non-root `BASE_PATH` deployments.
