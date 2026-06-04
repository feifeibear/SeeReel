# Vercel Static Frontend

`reelyai.app` should serve the built client from Vercel's edge and proxy only dynamic routes to the
ECS backend. This avoids loading frontend JS/CSS/HTML through the Cloudflare Quick Tunnel.

Deploy flow:

```bash
npm run build
tmp=/tmp/reelyai-vercel-static
rm -rf "$tmp"
mkdir -p "$tmp/.vercel"
cp -R dist/client/. "$tmp/"
cp deploy/vercel-static-frontend.json "$tmp/vercel.json"
cat > "$tmp/.vercel/project.json" <<'JSON'
{"projectId":"prj_xrCjyWAS8RtB4jA5X8MpX5bCC3po","orgId":"team_xSdyCmQP2DWCugsGCLtqVTMk"}
JSON
(cd "$tmp" && npx vercel deploy --prod --yes)
```

If Vercel does not automatically assign `reelyai.app`, alias the deployment:

```bash
npx vercel alias set <deployment-host>.vercel.app reelyai.app
```

The backend target in `vercel-static-frontend.json` is the currently reachable Cloudflare Quick
Tunnel. Direct Vercel rewrites to `https://api.reelyai.app` and raw ECS IP were tested and returned
502/timeouts from Vercel Edge even though Caddy handled direct client requests successfully. Keep
Caddy blocking `/metrics` and `/api/diagnostics` publicly. The current tunnel is
`https://complement-arrested-batteries-believed.trycloudflare.com`.
