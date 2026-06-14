import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildAutoSubtitleSrtFromScript,
  buildFfmpegSubtitleAss,
  buildHyperframesIndexHtml,
  computeHyperframesPostProductionSignature,
  normalizeHyperframesTranscriptToSrt,
  normalizeHyperframesTranscribeResultToSrt,
  parsePostProductionSubtitleCues,
  renderHyperframesPostProduction,
  selectPostProductionRenderer
} from "../src/server/hyperframesPost";
import { runFfmpegCommand } from "../src/server/generators";
import {
  buildVolcAsrRequest,
  buildVolcAsrQueryRequest,
  buildVolcAsrSubmitRequest,
  normalizeVolcAsrResponseToSrt,
  resolveVolcAsrConfigFromEnv
} from "../src/server/volcAsr";

const baseInput = {
  finalVideoSignature: "stitch-sig-1",
  title: "白门楼",
  subtitle: "最后一分钟",
  coverAssetId: "asset-cover",
  subtitleText: "00:00:01,000 --> 00:00:03,000\n陈宫回头。\n\n00:00:04,000 --> 00:00:06,000\n吕布沉默。",
  subtitleMode: "manual" as const,
  audioMode: "voiceover" as const,
  voice: "zh_male_M392_conversation_wvae_bigtts",
  voiceoverScript: "陈宫回头。吕布沉默。",
  musicPrompt: "",
  sourceVolume: 0.25,
  audioVolume: 1.2
};

const signature = computeHyperframesPostProductionSignature(baseInput);
assert.equal(typeof signature, "string");
assert.ok(signature.length >= 12, "signature should be stable and filename-safe");
assert.notEqual(
  signature,
  computeHyperframesPostProductionSignature({ ...baseInput, title: "白门楼 新标题" }),
  "title changes must produce a new package signature"
);
assert.notEqual(
  signature,
  computeHyperframesPostProductionSignature({ ...baseInput, finalVideoSignature: "stitch-sig-2" }),
  "source full-video changes must produce a new package signature"
);

const cues = parsePostProductionSubtitleCues(baseInput.subtitleText, {
  videoDurationSec: 10,
  videoStartSec: 1.5
});
assert.deepEqual(
  cues.map((cue) => ({ startSec: cue.startSec, endSec: cue.endSec, text: cue.text })),
  [
    { startSec: 2.5, endSec: 4.5, text: "陈宫回头。" },
    { startSec: 5.5, endSec: 7.5, text: "吕布沉默。" }
  ],
  "SRT cues should be shifted after the cover/title intro"
);

const longSrtCues = parsePostProductionSubtitleCues(
  "1\n00:00:00,000 --> 00:00:06,000\n这是一个很长很长的对白字幕段落如果不主动拆分和换行就会跑出竖屏画面边界影响观看",
  { videoDurationSec: 6, videoStartSec: 0 }
);
assert.ok(longSrtCues.length >= 2, "long SRT cue text should be split into multiple timed cues");
assert.ok(
  longSrtCues.every((cue) => cue.text.length <= 24),
  "split SRT cue text should stay short enough for subtitle-safe rendering"
);

const html = buildHyperframesIndexHtml({
  compositionId: "seereel-post",
  width: 1920,
  height: 1080,
  outputDurationSec: 11.5,
  videoStartSec: 1.5,
  videoDurationSec: 10,
  sourceVideoFile: "assets/base.mp4",
  coverImageFile: "assets/cover.jpg",
  title: "白门楼",
  subtitle: "最后一分钟",
  subtitleCues: cues
});

assert.match(html, /data-composition-id="seereel-post"/);
assert.match(html, /<video[^>]+src="assets\/base\.mp4"/);
assert.match(html, /data-start="1\.5"[^>]+data-duration="10"/);
assert.match(html, /<img[^>]+src="assets\/cover\.jpg"/);
assert.match(html, />白门楼</);
assert.match(html, />最后一分钟</);
assert.match(html, />陈宫回头。</);
assert.match(html, /window\.__timelines\["seereel-post"\]/);

assert.equal(
  selectPostProductionRenderer({
    title: "",
    subtitle: "",
    subtitleMode: "manual",
    subtitleText: baseInput.subtitleText
  }),
  "ffmpeg-subtitles",
  "subtitle-only post-production should use the low-memory ffmpeg subtitle renderer by default"
);
assert.equal(
  selectPostProductionRenderer({
    title: "白门楼",
    subtitle: "",
    subtitleMode: "manual",
    subtitleText: baseInput.subtitleText
  }),
  "hyperframes",
  "title-card packaging should stay on HyperFrames so packaging visuals are not silently dropped"
);

const ass = buildFfmpegSubtitleAss(cues, { width: 720, height: 1280 });
assert.match(ass, /\[Script Info\]/);
assert.match(ass, /PlayResX: 720/);
assert.match(ass, /PlayResY: 1280/);
assert.match(ass, /Style: Default,Arial Unicode MS,/);
assert.match(ass, /Dialogue: 0,0:00:02\.50,0:00:04\.50,Default/);
assert.match(ass, /陈宫回头。/);

const longAss = buildFfmpegSubtitleAss(
  [{ startSec: 0, endSec: 2, text: "这是一个很长很长的对白字幕段落如果不换行就会跑出竖屏画面边界" }],
  { width: 720, height: 1280 }
);
const longDialogue = longAss.split("\n").find((line) => line.startsWith("Dialogue:"));
assert.ok(longDialogue?.includes("\\N"), "long ASS dialogue should include explicit line breaks");
assert.ok(
  (longDialogue || "")
    .split(",", 10)
    .slice(-1)[0]
    .split("\\N")
    .every((line) => line.length <= 14),
  "each explicit ASS subtitle line should fit within the vertical video safe width"
);

const punctuationAss = buildFfmpegSubtitleAss(
  [{ startSec: 0, endSec: 2, text: "那个曾经刺杀董卓的曹孟德，却也站到了当年董卓的位置上。" }],
  { width: 720, height: 1280 }
);
const punctuationDialogue = punctuationAss.split("\n").find((line) => line.startsWith("Dialogue:")) || "";
assert.doesNotMatch(punctuationDialogue, /\\N[。！？!?，,；;]($|\\N)/, "ASS wrapping should not leave punctuation alone on a line");

const generatedSrt = buildAutoSubtitleSrtFromScript("第一句旁白。\n第二句旁白。", {
  videoDurationSec: 6,
  videoStartSec: 1.5
});
assert.match(generatedSrt, /1\n00:00:01,500 --> 00:00:04,500\n第一句旁白。/);
assert.match(generatedSrt, /2\n00:00:04,500 --> 00:00:07,500\n第二句旁白。/);

const transcriptSrt = normalizeHyperframesTranscriptToSrt({
  segments: [
    { start: 0.2, end: 1.4, text: "自动识别第一句" },
    { start: 1.6, end: 2.4, text: "自动识别第二句" }
  ]
});
assert.match(transcriptSrt, /1\n00:00:00,200 --> 00:00:01,400\n自动识别第一句/);
assert.match(transcriptSrt, /2\n00:00:01,600 --> 00:00:02,400\n自动识别第二句/);

const volcRequest = buildVolcAsrRequest({
  audioBase64: Buffer.from("fake wav bytes").toString("base64"),
  apiKey: "test-api-key",
  resourceId: "volc.bigasr.auc_turbo",
  requestId: "request-123",
  uid: "seereel-smoke"
});
assert.equal(volcRequest.url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash");
assert.equal(volcRequest.headers["X-Api-Key"], "test-api-key");
assert.equal(volcRequest.headers["X-Api-Resource-Id"], "volc.bigasr.auc_turbo");
assert.equal(volcRequest.headers["X-Api-Request-Id"], "request-123");
assert.equal(volcRequest.headers["X-Api-Sequence"], "-1");
assert.equal(volcRequest.body.user.uid, "seereel-smoke");
assert.equal(volcRequest.body.audio.data, Buffer.from("fake wav bytes").toString("base64"));
assert.equal(volcRequest.body.request.model_name, "bigmodel");

const legacyVolcRequest = buildVolcAsrRequest({
  audioBase64: "AAA=",
  appid: "legacy-appid",
  token: "smoke-access",
  resourceId: "volc.bigasr.auc_turbo",
  requestId: "request-legacy"
});
assert.equal(legacyVolcRequest.headers["X-Api-App-Key"], "legacy-appid");
assert.equal(legacyVolcRequest.headers["X-Api-Access-Key"], "smoke-access");
assert.ok(!("X-Api-Key" in legacyVolcRequest.headers), "legacy auth should not also send new console API key");

const genericVolcConfig = resolveVolcAsrConfigFromEnv({
  VOLC_APP_ID: "2500000000",
  VOLC_ACCESS_KEY: "generic-ak",
  VOLC_SECRET_KEY: "generic-sk"
});
assert.equal(genericVolcConfig.mode, "standard");
assert.equal(genericVolcConfig.resourceId, "volc.seedasr.auc");
assert.equal(genericVolcConfig.apiKey, "");
assert.equal(genericVolcConfig.appid, "2500000000");
assert.equal(genericVolcConfig.token, "generic-ak");
assert.equal(genericVolcConfig.secretKey, "generic-sk");
assert.equal(genericVolcConfig.uid, "2500000000");
const genericVolcSubmit = buildVolcAsrSubmitRequest({
  ...genericVolcConfig,
  audioBase64: "AAA=",
  requestId: "request-generic",
  base: genericVolcConfig.submitBase
});
assert.equal(genericVolcSubmit.url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit");
assert.equal(genericVolcSubmit.headers["X-Api-App-Key"], "2500000000");
assert.equal(genericVolcSubmit.headers["X-Api-Access-Key"], "generic-ak");
assert.equal(genericVolcSubmit.headers["X-Api-Resource-Id"], "volc.seedasr.auc");
assert.equal(genericVolcSubmit.headers["X-Api-Sequence"], "-1");
assert.ok(!("X-Api-Key" in genericVolcSubmit.headers), "standard ASR 2.0 should not send the flash X-Api-Key header");
assert.ok(!Object.values(genericVolcSubmit.headers).includes("generic-sk"), "standard ASR token auth must not send the secret key");
const genericVolcQuery = buildVolcAsrQueryRequest({
  ...genericVolcConfig,
  requestId: "request-generic",
  base: genericVolcConfig.queryBase
});
assert.equal(genericVolcQuery.url, "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query");
assert.equal(genericVolcQuery.headers["X-Api-App-Key"], "2500000000");
assert.equal(genericVolcQuery.headers["X-Api-Access-Key"], "generic-ak");
assert.equal(genericVolcQuery.headers["X-Api-Request-Id"], "request-generic");

const dedicatedVolcConfig = resolveVolcAsrConfigFromEnv({
  VOLC_ACCESS_KEY: "generic-ak",
  VOLC_SECRET_KEY: "generic-sk",
  VOLC_ASR_API_KEY: "asr-api-key",
  VOLC_ASR_APPID: "asr-appid",
  VOLC_ASR_TOKEN: "asr-token"
});
assert.equal(dedicatedVolcConfig.apiKey, "asr-api-key");
assert.equal(dedicatedVolcConfig.appid, "asr-appid");
assert.equal(dedicatedVolcConfig.token, "asr-token");
assert.equal(dedicatedVolcConfig.mode, "standard");
const dedicatedVolcSubmit = buildVolcAsrSubmitRequest({
  ...dedicatedVolcConfig,
  audioBase64: "AAA=",
  requestId: "request-api-key",
  base: dedicatedVolcConfig.submitBase
});
assert.equal(dedicatedVolcSubmit.headers["X-Api-Key"], "asr-api-key");
assert.ok(!("X-Api-App-Key" in dedicatedVolcSubmit.headers), "new-console standard ASR should prefer X-Api-Key");
assert.ok(!("X-Api-Access-Key" in dedicatedVolcSubmit.headers), "new-console standard ASR should not also send legacy token auth");

const flashVolcConfig = resolveVolcAsrConfigFromEnv({
  VOLC_ASR_MODE: "flash",
  ["VOLC_ASR_" + "API_KEY"]: "flash-api-key"
});
assert.equal(flashVolcConfig.mode, "flash");
assert.equal(flashVolcConfig.resourceId, "volc.bigasr.auc_turbo");

const volcSrt = normalizeVolcAsrResponseToSrt({
  result: {
    text: "自动识别第一句。自动识别第二句。",
    utterances: [
      { start_time: 450, end_time: 1530, text: "自动识别第一句。" },
      { start_time: 1800, end_time: 3260, text: "自动识别第二句。" },
      {
        start_time: 4000,
        end_time: 12000,
        text: "这是一个很长很长的火山识别字幕段落没有标点但是仍然需要被切成多个短字幕否则画面会完全放不下"
      }
    ]
  }
});
assert.match(volcSrt, /1\n00:00:00,450 --> 00:00:01,530\n自动识别第一句。/);
assert.match(volcSrt, /2\n00:00:01,800 --> 00:00:03,260\n自动识别第二句。/);
assert.match(volcSrt, /3\n00:00:04,000 -->/);
assert.match(volcSrt, /4\n/);
assert.ok(volcSrt.split("\n\n").length >= 4, "long Volc ASR utterances should be split into readable cues");

const tempDir = await mkdtemp(path.join(os.tmpdir(), "seereel-hf-transcript-"));
try {
  const transcriptPath = path.join(tempDir, "transcript.json");
  await writeFile(transcriptPath, JSON.stringify([
    {
      start: 0,
      end: 12,
      text: "这是一个很长很长的自动识别字幕段落没有标点但是仍然需要被切成多个短字幕否则画面会完全放不下"
    }
  ]));
  const pathSrt = await normalizeHyperframesTranscribeResultToSrt({ ok: true, transcriptPath });
  assert.match(pathSrt, /1\n00:00:00,000 -->/);
  assert.match(pathSrt, /2\n/);
  assert.ok(pathSrt.split("\n\n").length >= 2, "long transcriptPath segment should be split into multiple subtitle cues");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

const renderTempDir = await mkdtemp(path.join(os.tmpdir(), "seereel-ffmpeg-subtitle-render-"));
try {
  const sourceVideoPath = path.join(renderTempDir, "source.mp4");
  await runFfmpegCommand([
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=320x568:d=1.4:r=15",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    sourceVideoPath
  ], 4096);
  const renderResult = await renderHyperframesPostProduction({
    sessionId: "smoke-lowmem",
    signature: `smoke-lowmem-${Date.now()}`,
    finalVideoSignature: "final-smoke-lowmem",
    sourceVideoPath,
    subtitleMode: "manual",
    subtitleText: "1\n00:00:00,100 --> 00:00:01,100\n低内存字幕"
  });
  assert.equal(renderResult.renderer, "ffmpeg-subtitles");
  assert.match(renderResult.videoUrl, /\/media\/final-smoke-lowmem-subtitles-/);
  const outputStat = await stat(renderResult.outputPath);
  assert.ok(outputStat.size > 1000, "ffmpeg subtitle render should produce a non-empty mp4");
  await rm(renderResult.outputPath, { force: true });
  await rm(renderResult.projectDir, { recursive: true, force: true });
} finally {
  await rm(renderTempDir, { recursive: true, force: true });
}

console.log("smoke-hyperframes-postproduction passed");
