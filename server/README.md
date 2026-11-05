# SendIt server

A minimal self-hosted backend for the SendIt browser extension (Via-compatible API).

## Run
```bash
SENDIT_ADMIN_USER=alice SENDIT_ADMIN_PASS=secret PORT=8080 npm run start:server
```
Then in the extension setup choose **Via server** (default `http://localhost:8080`) or **Custom server** with your LAN address.

## API
`GET /v1/info` · `POST /v1/auth/login` · `GET|POST /v1/devices` · `GET /v1/devices/me` ·
`POST /v1/pushes` · `POST /v1/pushes/file` · `GET /v1/inbox` · `GET /v1/inbox/events` (SSE) ·
`GET /v1/inbox/:id` · `GET /v1/inbox/:id/file` · `POST /v1/inbox/ack` · `POST /v1/inbox/:id/ack`

Limits: `SENDIT_MAX_FILE_SIZE` (default 100 MiB), `SENDIT_MAX_TEXT_LENGTH` (default 256 KiB). Data persists to `SENDIT_DATA` (default `server/data.json`).
