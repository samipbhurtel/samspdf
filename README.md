# Word to PDF Converter

## Current Phase

**Phase 0** — Project setup and environment verification only. Actual Word-to-PDF conversion has **NOT** been implemented yet.

## Technology Stack

- Frontend: Vanilla HTML/CSS/JavaScript
- Backend: Node.js + Express.js
- Conversion: LibreOffice Headless (not yet implemented)

## Setup

```bash
npm install
```

## Run

```bash
npm start
```

Server starts on `http://localhost:3000` (or set `PORT` environment variable).

## Health Check

```bash
curl http://localhost:3000/api/health
# {"status":"ok"}
```
