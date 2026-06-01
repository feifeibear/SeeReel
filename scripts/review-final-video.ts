import "dotenv/config";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { runFfmpegCommand } from "../src/server/generators";

const videoPath = process.argv[2];
const promptPath = process.argv[3];
if (!videoPath) throw new Error("Usage: tsx scripts/review-final-video.ts <videoPath> [promptPath]");

const apiBase = (process.env.VISION_REVIEW_API_BASE || process.env.SEED_PROMPT_API_BASE || process.env.SEEDANCE_API_BASE || "https://ark.ap-southeast.bytepluses.com/api/v3").replace(/\/$/, "");
const apiKey = process.env.VISION_REVIEW_API_KEY || process.env.SEED_PROMPT_API_KEY || process.env.BP_ARK_API_KEY || process.env.ARK_API_KEY;
const model = process.env.VISION_REVIEW_MODEL || "seed-2-0-pro-260328";
if (!apiKey) throw new Error("Missing VISION_REVIEW_API_KEY / BP_ARK_API_KEY / ARK_API_KEY");

const prompt = promptPath
  ? await readFile(promptPath, "utf8")
  : "原创 1 分钟抖音向亲情反转短剧《最后一单，是妈妈点的》：雨夜外卖骑手送生日蛋糕到医院，发现订单来自去世前为他安排生日的母亲。要求人物、场景、道具、节奏连续，情绪有抓人开头、反转泪点、温暖收束。";

const outDir = path.resolve(process.cwd(), "data", "media", "vlm-final-review");
await mkdir(outDir, { recursive: true });
const stamp = path.basename(videoPath).replace(/\W+/g, "-");
const framePaths: string[] = [];
for (let i = 0; i < 10; i += 1) {
  const t = 2 + i * 6;
  const framePath = path.join(outDir, `${stamp}-frame-${String(i + 1).padStart(2, "0")}.jpg`);
  await runFfmpegCommand(["-y", "-ss", String(t), "-i", videoPath, "-frames:v", "1", "-q:v", "3", framePath]);
  framePaths.push(framePath);
}

const images = await Promise.all(framePaths.map(async (framePath) => {
  const b64 = await readFile(framePath, "base64");
  return { type: "input_image", image_url: `data:image/jpeg;base64,${b64}` };
}));

const systemPrompt = [
  "你是短剧成片终审 VLM，目标是判断一条 1 分钟竖屏短剧是否达到可发抖音、能获得点赞的最低上线标准。",
  "你会看到按时间顺序均匀采样的 10 帧。请严格判定：",
  "1. 人物一致性：男主林远是否像同一个人，母亲照片/回忆是否稳定，不应突然换人。",
  "2. 场景一致性：雨夜城市、医院走廊/病房、清晨收束是否空间/光线/道具连续。",
  "3. 叙事节奏：是否能看出雨夜接单→赶单/摔倒→医院→空病床/照片→录音泪点→生日蛋糕→清晨继续生活。",
  "4. 视觉质量：无严重畸形、乱码文字、水印、logo、跳变、明显拼接灾难。",
  "5. 抖音吸引力：前三秒是否有钩子，中段是否有反转，结尾是否有情绪释放。",
  "只输出严格 JSON，不要 Markdown：{\"ok\": boolean, \"score\": number, \"reasons\": string[], \"fixes\": [{\"shot\": number, \"action\": string}], \"douyin_comment\": string}。",
  "score 为 0-100；ok=true 必须 score>=80 且没有致命连续性/畸形问题。reasons 最多 5 条，fixes 最多 5 条。"
].join("\n");

const body = {
  model,
  stream: false,
  input: [
    { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
    {
      role: "user",
      content: [
        { type: "input_text", text: `原始创作要求：\n${prompt}` },
        { type: "input_text", text: "以下是最终 1min 视频按时间顺序抽取的 10 帧：" },
        ...images
      ]
    }
  ]
};

const response = await fetch(`${apiBase}/responses`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify(body)
});
const text = await response.text();
if (!response.ok) throw new Error(`VLM review failed ${response.status}: ${text.slice(0, 1000)}`);
const parsed = JSON.parse(text);
const rawText = parsed.output_text || parsed.output?.flatMap((o: any) => o.content || []).map((c: any) => c.text || "").join("") || "";
const verdict = parseFirstJsonObject(rawText);
if (!verdict) throw new Error(`No parseable JSON verdict in response: ${rawText}`);
const reviewPath = path.join(outDir, `${stamp}-review.json`);
await writeFile(reviewPath, JSON.stringify({ videoPath, prompt, model, verdict, rawText, frames: framePaths }, null, 2), "utf8");
console.log(JSON.stringify({ reviewPath, verdict }, null, 2));

function parseFirstJsonObject(text: string): unknown {
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }
  return undefined;
}

if (process.env.KEEP_VLM_FRAMES !== "1") {
  await Promise.all(framePaths.map((p) => unlink(p).catch(() => undefined)));
}
