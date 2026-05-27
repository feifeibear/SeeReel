# Git and secrets

## Must stay out of git

- `.env` and any file with real `*_API_KEY`, `*_SECRET_*`, `VOLC_TTS_TOKEN`, etc.
- `data/` including `data/cinema-store.json` (often contains TOS pre-signed URLs with `X-Tos-Credential` / `X-Tos-Signature`)
- `data/media/` generated assets

## Safe to commit

- `.env.example` (empty placeholders only)
- Source code that reads `process.env.*` without embedding values

## Before push

```bash
git check-ignore -v .env data/cinema-store.json
git grep -E 'AKLT[A-Za-z0-9]{10,}|SECRET_ACCESS_KEY=[^[:space:]]{8,}' $(git rev-parse HEAD) || echo "OK: no obvious secrets in HEAD"
```

If `.env` or `data/` was ever committed, rotate Volcengine keys and use `git filter-repo` or BFG to purge history before pushing.
