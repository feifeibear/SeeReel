import path from "node:path";
import { stat, readFile } from "node:fs/promises";
import { TosClient } from "@volcengine/tos-sdk";

async function main() {
  const filePath = path.resolve(process.argv[2] || "");
  if (!filePath) throw new Error("usage: tsx scripts/upload-to-tos.ts <file>");
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) throw new Error(`not a file: ${filePath}`);

  const accessKeyId = need("TOS_ACCESS_KEY_ID");
  const accessKeySecret = need("TOS_SECRET_ACCESS_KEY");
  const region = need("TOS_REGION");
  const bucket = need("TOS_BUCKET");
  const endpoint = (process.env.TOS_ENDPOINT || "").replace(/^https?:\/\//, "").replace(/\/+$/g, "") || undefined;
  const publicBaseUrl = process.env.TOS_PUBLIC_BASE_URL?.replace(/\/+$/g, "") || "";
  const keyPrefix = (process.env.TOS_KEY_PREFIX || "cinema-agent/storyboards").replace(/^\/+|\/+$/g, "");
  const presignExpiresSec = Math.max(60, Number(process.env.TOS_PRESIGN_EXPIRES_SEC) || 86400);

  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath, ext).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const key = [keyPrefix, "ref-input", `${base}-${Date.now()}${ext}`].filter(Boolean).join("/");

  const client = new TosClient({ accessKeyId, accessKeySecret, region, endpoint, bucket });
  const buf = await readFile(filePath);
  await client.putObject({
    bucket,
    key,
    body: buf,
    contentType: contentTypeFor(ext),
    cacheControl: "public, max-age=604800"
  } as any);

  let url: string;
  if (publicBaseUrl) {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    url = `${publicBaseUrl}/${encodedKey}`;
  } else {
    url = client.getPreSignedUrl({ bucket, key, expires: presignExpiresSec });
  }
  process.stdout.write(JSON.stringify({ key, url, sizeBytes: info.size }) + "\n");
}

function need(name: string) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

function contentTypeFor(ext: string) {
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  return "application/octet-stream";
}

main().catch((err) => {
  process.stderr.write(String(err?.stack || err) + "\n");
  process.exit(1);
});
