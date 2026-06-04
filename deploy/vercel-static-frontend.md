# Vercel Static Frontend

`seereel.studio` should serve the built client from Vercel's edge and proxy only dynamic routes to the
ECS backend. This avoids loading frontend JS/CSS/HTML through the Cloudflare Quick Tunnel.

Deploy flow:

```bash
npm run build
tmp=/tmp/seereel-vercel-static
rm -rf "$tmp"
mkdir -p "$tmp/.vercel"
cp -R dist/client/. "$tmp/"
cp deploy/vercel-static-frontend.json "$tmp/vercel.json"
cp .vercel/project.json "$tmp/.vercel/project.json"
(cd "$tmp" && npx vercel deploy --prod --yes)
```

If Vercel does not automatically assign `seereel.studio`, alias the deployment:

```bash
npx vercel alias set <deployment-host>.vercel.app seereel.studio
```

The backend target in `vercel-static-frontend.json` is the currently reachable Cloudflare Quick
Tunnel. Direct Vercel rewrites to `https://api.seereel.studio` and raw ECS IP were tested and returned
502/timeouts from Vercel Edge even though Caddy handled direct client requests successfully. Keep
Caddy blocking `/metrics` and `/api/diagnostics` publicly. The current tunnel is
`https://complement-arrested-batteries-believed.trycloudflare.com`.
