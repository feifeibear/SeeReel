import { createHmac } from "node:crypto";
import express from "express";

/**
 * Tiny Alertmanager -> Feishu webhook relay.
 *
 * Alertmanager speaks its own JSON webhook shape; Feishu custom bots expect a different payload (and
 * optional HMAC signature). This service translates one into the other so alerts land in a Feishu
 * group with no extra dependencies (reuses the project's express + node crypto).
 *
 * Env:
 *  - FEISHU_WEBHOOK_URL     (required) Feishu custom-bot webhook URL
 *  - FEISHU_WEBHOOK_SECRET  (optional) enables signed requests
 *  - FEISHU_RELAY_PORT      (optional, default 8088)
 */

const PORT = Number(process.env.FEISHU_RELAY_PORT || 8088);
const WEBHOOK_URL = (process.env.FEISHU_WEBHOOK_URL || "").trim();
const WEBHOOK_SECRET = (process.env.FEISHU_WEBHOOK_SECRET || "").trim();

interface AmAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
}
interface AmPayload {
  status?: string;
  alerts?: AmAlert[];
}

function sign(timestampSec: number) {
  // Feishu: HMAC-SHA256 with key = `${timestamp}\n${secret}` over an empty message, base64-encoded.
  const stringToSign = `${timestampSec}\n${WEBHOOK_SECRET}`;
  return createHmac("sha256", stringToSign).update("").digest("base64");
}

function formatAlerts(payload: AmPayload) {
  const alerts = payload.alerts || [];
  const firing = alerts.filter((a) => a.status === "firing");
  const resolved = alerts.filter((a) => a.status === "resolved");
  const lines: string[] = [];
  const header = payload.status === "resolved" ? "✅ ReelyAI 告警已恢复" : "🚨 ReelyAI 告警";
  lines.push(header);
  for (const alert of [...firing, ...resolved]) {
    const sev = alert.labels?.severity || "-";
    const name = alert.labels?.alertname || "alert";
    const state = alert.status === "resolved" ? "[resolved]" : "[firing]";
    const summary = alert.annotations?.summary || "";
    const desc = alert.annotations?.description || "";
    const instance = alert.labels?.instance ? ` (${alert.labels.instance})` : "";
    lines.push(`${state} ${sev} · ${name}${instance}`);
    if (summary) lines.push(`  ${summary}`);
    if (desc) lines.push(`  ${desc}`);
  }
  return lines.join("\n");
}

async function postToFeishu(text: string) {
  if (!WEBHOOK_URL) {
    console.warn("[feishu-relay] FEISHU_WEBHOOK_URL not set; dropping alert:\n" + text);
    return;
  }
  const body: Record<string, unknown> = { msg_type: "text", content: { text } };
  if (WEBHOOK_SECRET) {
    const ts = Math.floor(Date.now() / 1000);
    body.timestamp = String(ts);
    body.sign = sign(ts);
  }
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const respText = await res.text();
  if (!res.ok) {
    console.error(`[feishu-relay] Feishu webhook failed: ${res.status} ${respText.slice(0, 300)}`);
  } else {
    console.log(`[feishu-relay] delivered alert (${res.status})`);
  }
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/alert", async (req, res) => {
  try {
    const text = formatAlerts((req.body || {}) as AmPayload);
    await postToFeishu(text);
    res.json({ ok: true });
  } catch (error) {
    console.error(`[feishu-relay] error: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ ok: false });
  }
});

app.listen(PORT, () => {
  console.log(`[feishu-relay] listening on :${PORT} (webhook ${WEBHOOK_URL ? "configured" : "MISSING"}, signing ${WEBHOOK_SECRET ? "on" : "off"})`);
});
