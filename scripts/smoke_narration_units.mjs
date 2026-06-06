// Quick smoke test for the pure helpers in src/server/narration.ts.
// Verifies CJK + English split, timeline assembly (fit + truncate), SRT, and signature stability.

import {
  splitScriptIntoLines,
  assembleNarrationTimeline,
  buildSrt,
  computeNarrationSignature,
  buildAmixFilter
} from "../src/server/narration.ts";

// ---------- 1. CJK split ----------
const cjkScript = `镜头一推开宫门。\n紫禁城的清晨笼罩在薄雾中，宫人扫过青砖地面。\n远处传来钟声，三声悠长，回荡在飞檐之上。\n年轻的皇帝坐在窗边，注视一只飞过的乌鸦。\n他抬起手，指尖停在半空，又缓缓放下。\n这一刻，整个帝国都仿佛屏住了呼吸。`;
const cjkLines = splitScriptIntoLines(cjkScript);
console.log("== splitScriptIntoLines (CJK) ==");
cjkLines.forEach((line, idx) => console.log(`  [${idx + 1}] ${line}`));
console.log(`count=${cjkLines.length}`);
if (cjkLines.length !== 6) throw new Error(`FAIL: expected 6 CJK lines, got ${cjkLines.length}`);

// ---------- 2. English split (with hard line wraps mid-sentence + punctuation traps) ----------
const englishScript = `Pumas are large, cat-like animals which are found in America. When
reports came into London Zoo that a wild puma had been spotted
forty-five miles south of London, they were not taken seriously.
However, as the evidence began to accumulate, experts from the
Zoo felt obliged to investigate. Mr. Smith mentioned 1.5 sightings
per week. The hunt for the puma began in a small village.`;
const enLines = splitScriptIntoLines(englishScript);
console.log("\n== splitScriptIntoLines (English) ==");
enLines.forEach((line, idx) => console.log(`  [${idx + 1}] ${line}`));
console.log(`count=${enLines.length}`);
// We expect: 1) "Pumas are large..." 2) "When reports came... seriously." 3) "However, ... investigate." 4) "Mr. Smith mentioned 1.5 sightings per week." 5) "The hunt..."
if (enLines.length !== 5) throw new Error(`FAIL: expected 5 English lines, got ${enLines.length}`);
if (!enLines[1].startsWith("When reports came into London Zoo"))
  throw new Error(`FAIL: mid-sentence newline did not fold into a space: ${enLines[1]}`);
if (!enLines[3].includes("Mr. Smith") || !enLines[3].includes("1.5"))
  throw new Error(`FAIL: "Mr." / "1.5" were split incorrectly: ${enLines[3]}`);

// ---------- 3. Timeline that fits in video ----------
const fakeDurations = cjkLines.map((line) => Math.max(1.4, line.length * 0.22));
const videoDuration = fakeDurations.reduce((a, b) => a + b, 0) + 1.5;
const fitTimeline = assembleNarrationTimeline(
  cjkLines.map((text, i) => ({ text, audioPath: `/tmp/${i}.mp3`, rawDurationSec: fakeDurations[i] })),
  videoDuration
);
console.log("\n== timeline (narration fits in video) ==");
console.log(
  `video=${videoDuration.toFixed(2)}s narration=${fitTimeline.narrationDurationSec.toFixed(2)}s tempo=${fitTimeline.globalTempo.toFixed(3)} dropped=${fitTimeline.droppedLineCount}`
);
fitTimeline.segments.forEach((seg) =>
  console.log(`  #${seg.index + 1} [${seg.startSec.toFixed(2)} -> ${seg.endSec.toFixed(2)}] ${seg.text.slice(0, 18)}…`)
);
if (fitTimeline.globalTempo !== 1.0) throw new Error("FAIL: fitting narration must not bump tempo");
if (fitTimeline.droppedLineCount !== 0) throw new Error("FAIL: fitting narration must not drop");
if (fitTimeline.outputDurationSec !== videoDuration)
  throw new Error("FAIL: outputDurationSec must equal videoDuration");

// ---------- 4. Timeline that needs tempo bump but everything still fits ----------
const tempoOnlyTimeline = assembleNarrationTimeline(
  cjkLines.map((text, i) => ({ text, audioPath: `/tmp/${i}.mp3`, rawDurationSec: fakeDurations[i] })),
  videoDuration * 0.85,
  { maxTempo: 1.5 }
);
console.log("\n== timeline (tempo-only fit) ==");
console.log(
  `tempo=${tempoOnlyTimeline.globalTempo.toFixed(3)} dropped=${tempoOnlyTimeline.droppedLineCount} warning=${tempoOnlyTimeline.warning || "<none>"}`
);
if (tempoOnlyTimeline.globalTempo <= 1.0) throw new Error("FAIL: expected tempo bump");
if (tempoOnlyTimeline.droppedLineCount !== 0) throw new Error("FAIL: tempo-only fit must not drop");

// ---------- 5. Timeline that overruns even at max tempo -> trailing lines dropped ----------
const overrunTimeline = assembleNarrationTimeline(
  cjkLines.map((text, i) => ({ text, audioPath: `/tmp/${i}.mp3`, rawDurationSec: fakeDurations[i] })),
  videoDuration * 0.4,
  { maxTempo: 1.3 }
);
console.log("\n== timeline (truncate trailing) ==");
console.log(
  `videoDuration=${(videoDuration * 0.4).toFixed(2)}s tempo=${overrunTimeline.globalTempo.toFixed(3)} kept=${overrunTimeline.segments.length} dropped=${overrunTimeline.droppedLineCount}`
);
console.log(`warning=${overrunTimeline.warning}`);
if (overrunTimeline.droppedLineCount === 0)
  throw new Error("FAIL: expected trailing sentences to be dropped");
if (overrunTimeline.outputDurationSec !== videoDuration * 0.4)
  throw new Error("FAIL: outputDurationSec must equal videoDuration even when truncating");
if (!overrunTimeline.warning) throw new Error("FAIL: expected warning when dropping");

// ---------- 6. SRT ----------
const srt = buildSrt(fitTimeline.segments);
console.log("\n== buildSrt (first 240 chars) ==");
console.log(srt.slice(0, 240));
if (!/\d{2}:\d{2}:\d{2},\d{3}/.test(srt)) throw new Error("FAIL: srt missing timecode format");

// ---------- 7. Signature stability ----------
const sig1 = computeNarrationSignature({ script: cjkScript, voice: "v1", strategy: "natural", finalVideoSignature: "abc" });
const sig2 = computeNarrationSignature({ script: cjkScript, voice: "v1", strategy: "natural", finalVideoSignature: "abc" });
const sig3 = computeNarrationSignature({ script: cjkScript + " more", voice: "v1", strategy: "natural", finalVideoSignature: "abc" });
const sig4 = computeNarrationSignature({ script: cjkScript, voice: "v1", strategy: "natural", finalVideoSignature: "def" });
console.log(`\n== computeNarrationSignature ==\n  sig1=${sig1}\n  sig2=${sig2}  (must equal sig1)\n  sig3=${sig3}  (must differ from sig1)\n  sig4=${sig4}  (must differ from sig1)`);
if (sig1 !== sig2) throw new Error("FAIL: same input must yield same signature");
if (sig1 === sig3) throw new Error("FAIL: changed script must yield different signature");
if (sig1 === sig4) throw new Error("FAIL: changed finalVideoSignature must yield different signature");

// ---------- 8. ffmpeg compatibility ----------
const amix = buildAmixFilter(10);
console.log(`\n== buildAmixFilter ==\n  ${amix}`);
if (amix.includes("normalize=")) {
  throw new Error("FAIL: amix normalize option is not supported by the production ffmpeg build");
}
if (!/amix=inputs=10:duration=longest/.test(amix)) {
  throw new Error(`FAIL: unexpected amix filter: ${amix}`);
}
console.log("\nALL UNIT CHECKS OK");
