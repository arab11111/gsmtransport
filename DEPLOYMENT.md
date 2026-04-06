Production deployment guide

Overview
- This repository runs an Express server (`server.js`) that serves the frontend and provides a `/generate-pdf/:id` endpoint using puppeteer-core and a system Chromium.
- For production, use Docker (preferred) or deploy to a VPS/Cloud VM.

Build and run with Docker

1. Build the image:

```bash
docker build -t gsm-transport-app:latest .
```

2. Run the container (exposes port 3002):

```bash
docker run -d -p 3002:3002 --name gsm-transport \
  -e PORT=3002 \
  -e NODE_ENV=production \
  gsm-transport-app:latest
```

Notes
- The Dockerfile installs system `chromium` and sets `CHROME_PATH=/usr/bin/chromium`.
- If you prefer running Chromium provided by `puppeteer`, replace `puppeteer-core` with `puppeteer` in `package.json` and allow full install (larger image).

Firebase / Firestore
- Firestore is used by the frontend (compat SDK). For production, secure your Firestore rules and ensure the correct Firebase config is injected into the deployed `index.html` or via env-managed config.

Storing PDFs
- PDFs are written to `/pdfs` inside the container. For production, use object storage (S3 / Cloud Storage) and serve via CDN. You can modify `server.js` to upload on generation and return signed URLs.

Security
- Protect `/generate-pdf` endpoint behind authentication (JWT / Firebase Auth) and rate-limit to prevent abuse.

Alternative: Cloud Functions
- For serverless, implement a Firebase Cloud Function using `chrome-aws-lambda` + `puppeteer-core`.

If you want I can:
- Add a Docker Compose file with a persistent volume for `pdfs`.
- Add a script to upload generated PDFs to Firebase Storage.
- Create a Cloud Function example for PDF generation.
