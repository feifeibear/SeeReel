#!/usr/bin/env node
// Setup-only script for 《末代皇帝·阿美莉卡使节》(architectural 1976 alt-history, 72s, 6 shots,
// Bertolucci/Storaro homage). It patches session.story and patches each shot with prompt /
// duration / continuity flags / assetIds. It DOES NOT trigger generation - run /generate per shot
// (or via the web UI) after the user reviews the storyboard.
//
// Idempotent: if the named session already exists, reuse it.

import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.CINEMA_BASE_URL || "http://127.0.0.1:5173";
const TITLE = "末代皇帝·阿美莉卡使节";
const LOG_PREFIX = "[last-emperor]";

const log = (...args) => console.log(LOG_PREFIX, ...args);
const errlog = (...args) => console.error(LOG_PREFIX, ...args);

async function jfetch(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!res.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${method} ${url} -> ${res.status}: ${detail}`);
  }
  return data;
}

const LOGLINE =
  "1976 年架空时空，紫禁城仍由末代皇帝溥仪坐镇。阿美莉卡通商使节黄仁勋越洋而来，献上一物名曰显卡——龙椅之下，皇权语言与硅基生态六问六答，从一片金属升到一座文明的护城河。最后皇上以一盏蜜桃四季春赐使节，宫灯将熄。";

const STYLE = [
  "Bernardo Bertolucci 1987 Last Emperor cinematic homage, Vittorio Storaro-style natural light",
  "65mm widescreen aesthetic trimmed to vertical 9:16, anamorphic lens feel, restrained flare",
  "color palette: warm amber lantern glow inside Forbidden City, cold jade-cyan north window light, deep vermilion lacquer, oxidized gold, low-saturation overall",
  "low-ISO film grain, 24fps contemplative pacing, slow dolly horizontal moves, low-angle architecture, occasional overhead palace symmetry",
  "diegetic sound: silk rustle, ceremonial bronze bell, distant pipa, footsteps on stone, restrained orchestral cue only at emotional peaks",
  "period-accurate costuming: minister black robes, palace eunuch grey, emperor imperial yellow dragon robe with mianliu crown for formal scenes / black silk Sun-Yat-sen suit with round black-rimmed glasses for private chambers",
  "no Hollywood-style burned-in subtitle, only minimal single-line ZH text appears briefly at the bottom for dialogue beats"
].join("; ");

const STORY = {
  premise:
    "1976 年架空时空：紫禁城仍是当朝宫廷，末代皇帝溥仪在位。阿美莉卡通商使节黄仁勋越洋而来，献显卡为礼，于太和殿、御书房、御花园三处递进对答，最终从一片金属上升到 \"开放生态如何让文明胜过宫墙\" 的哲学高度，皇上以一盏蜜桃四季春赐使节作结。",
  synopsis:
    "1976 年仲秋，紫禁城金水河晨雾未散，阿美莉卡通商使节黄仁勋的车队穿过午门。太和殿前殿，@溥仪 着明黄龙袍冕旒坐于龙椅，@黄仁勋 单膝半跪呈金匣，称 \"阿美莉卡通商国书\"。" +
    "御书房密谈一变：@溥仪 换深色丝绸中山装、戴黑框圆眼镜，@黄仁勋 开匣，匣内并非金银，而是一片闪着绿光的金属——\"显卡\"。" +
    "黄缓声讲解：\"不是显卡，是 AI 工厂的地基；地基之上，万民聚而生态成；生态便是新国族的护城河。\" 镜头慢慢由黄推到溥仪侧脸，宫灯将显卡映成翡翠。" +
    "溥仪走至御花园回廊，望着真正的护城河，缓缓道：\"朕的护城河，曾困住朕。汝言生态，是把护城河变成桥。\"" +
    "暮色御花园石桌前，宫女托红盏 (蜜桃四季春) 而来，@黄仁勋 双手接过，啜一口；@溥仪 侧脸轻语：\"以此茶饯使节，归后告于阿美莉卡：朕之护城河，今为汝开。\" 宫灯一盏一盏熄灭，画面渐黑。",
  theme: "古老封闭文明与开放硅基生态的对话；护城河从困住人的墙到连接人的桥；末代皇权的反向馈赠",
  tone: "庄严、克制、电影质感，慢节奏长镜头，喜剧元素只在蜜雪冰城收尾处隐隐浮出",
  characters: [
    {
      name: "溥仪",
      role: "主角·末代皇帝（架空 1976 仍在位）",
      arc: "庄严接见 → 私下密谈识物 → 望护城河沉思 → 以茶相赠完成反向馈赠",
      assetMention: "@溥仪"
    },
    {
      name: "黄仁勋",
      role: "主角·阿美莉卡通商使节",
      arc: "正式呈国书 → 开匣示物 → 哲学化抬升 (显卡→AI 工厂→护城河→文明) → 受茶并俯首",
      assetMention: "@黄仁勋"
    }
  ],
  beats: [
    {
      index: 1,
      title: "玉河晨色·使节入京",
      purpose: "建立 1976 架空紫禁城时空，引出使节越洋而来",
      plot:
        "清晨金水河薄雾，@黄仁勋 着深色驼绒大氅外搭黑皮夹克（保留使节特征），随仪仗穿过午门长甬道。题字：『1976 · 仲秋 · 紫禁城』。",
      emotion: "庄严、压抑、史诗序曲",
      visual: "65mm 大画幅低饱和、午门飞檐金水河倒影、低角度仰拍仪仗、自然晨光",
      assetMentions: ["@黄仁勋"],
      durationSec: 12
    },
    {
      index: 2,
      title: "太和殿前殿·递国书",
      purpose: "首次接见，礼仪秩序确立",
      plot:
        "@溥仪 着明黄龙袍冕旒坐于龙椅，金漆殿宇深处烛火摇曳。@黄仁勋 单膝半跪，双手呈金漆扁匣。字幕：『外臣自阿美莉卡来，献阿美莉卡通商国书。』长焦缓推至溥仪冕旒下眼神。",
      emotion: "礼仪克制、相互试探",
      visual: "太和殿御座俯仰镜头、丹陛金漆、冕旒前珠串轻颤、冷蓝大殿+暖烛对比",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    },
    {
      index: 3,
      title: "御书房密谈·开匣识物",
      purpose: "皇帝换装入凡，第一次直面 \"显卡\"",
      plot:
        "场景切到御书房密室，@溥仪 换深色丝绸中山装、戴黑框圆眼镜，端坐紫檀书案旁。@黄仁勋 开匣，匣内现一片闪着绿光的金属。字幕：『此物名曰：显卡。』溥仪缓缓抬手，宫灯将显卡映成翡翠，眼神由审视转为好奇。",
      emotion: "亲近、被吸引、内敛震惊",
      visual: "书案近景、宫灯反射、显卡绿光投在皇帝脸侧、虚化书案与笔砚",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    },
    {
      index: 4,
      title: "哲学高潮·从显卡到护城河",
      purpose: "全片思想高峰——开放生态如何从企业上升到国家",
      plot:
        "@黄仁勋 缓声陈情：『不是显卡，是 AI 工厂的地基。地基之上，万民聚而生态成。生态便是新国族的护城河。』镜头从黄缓缓横移推到 @溥仪 侧脸，皇帝长久沉默，目光投向窗外远处真正的护城河。",
      emotion: "顿悟、广义化、历史尺度的克制激动",
      visual: "横向缓推+焦点拉移，背景虚化的故宫飞檐和远处护城河水光",
      assetMentions: ["@黄仁勋", "@溥仪"],
      durationSec: 12
    },
    {
      index: 5,
      title: "国族隐喻·护城河成桥",
      purpose: "皇帝接住哲学命题并反向输出，权力的自我和解",
      plot:
        "@溥仪 缓步走过御花园朱漆回廊，远处真正的护城河泛冷蓝光。皇帝半侧脸轻语：『朕的护城河，曾困住朕。汝言生态，是把护城河变成桥。』@黄仁勋 立于阶下俯首聆听。",
      emotion: "和解、广博、淡淡苍凉",
      visual: "横移跟拍御花园回廊、自然暮光斜射、长焦虚化使节剪影",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    },
    {
      index: 6,
      title: "蜜桃四季春·宫灯将熄",
      purpose: "古今物件并置完成反向馈赠，全片收尾",
      plot:
        "暮色御花园石桌前，宫女托红盏（外形似现代蜜桃四季春饮品杯，不强调商标）盈盈而入，置于皇帝面前。@溥仪 微抬手赐于使节，@黄仁勋 双手接过，啜一口眼神柔软。@溥仪 侧脸轻语：『以此茶饯使节，归后告于阿美莉卡：朕之护城河，今为汝开。』宫灯一盏一盏熄灭，画面渐黑，远处一声暮鼓。",
      emotion: "古今同框的温柔反差、史诗收束",
      visual: "石桌静物特写、红色塑料杯与汉白玉器并置、宫灯熄灭节奏剪辑、最后画面渐黑+一行小字幕『紫禁城 · 1976』",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    }
  ],
  locked: true
};

const STYLE_PREFIX =
  "Bertolucci-Storaro 1987《末代皇帝》visual homage. 65mm widescreen aesthetic cropped to vertical 9:16. " +
  "Natural-source lighting only: warm amber palace lanterns + cold jade-cyan north window light + deep vermilion lacquer. " +
  "Low-ISO 24fps film grain, slow dolly horizontal moves, restrained anamorphic flare, no neon, no modern UI overlay, no on-screen English subtitle. " +
  "Diegetic ambient sound: silk rustle, bronze ceremonial bell, distant pipa, palace footstep echo; orchestral cue only at emotional peaks. " +
  "Costume accuracy: emperor in imperial yellow dragon robe with mianliu crown for formal throne scenes / black silk Sun-Yat-sen suit with thick round black-rimmed glasses for private chamber scenes; envoy in dark camel overcoat over signature black leather jacket. " +
  "Minimal single-line Chinese subtitle appears briefly at lower frame for dialogue beats. Real historical-figure faces follow the attached @character reference images.";

const SHOT_TEMPLATES = [
  {
    title: "1 · 玉河晨色·使节入京",
    durationSec: 12,
    usePreviousShotClip: false,
    assetNames: ["黄仁勋"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 1 of 6, 12s, vertical 9:16. Pre-dawn mist on the Jinshui (Golden Water) River outside the Meridian Gate of the Forbidden City, 1976 alt-history autumn. " +
      "0-4s: a slow wide overhead crane shot of the Meridian Gate flying eaves and the curved white-marble bridges, golden amber sunrise breaks behind the gate, faint mist drifting low. " +
      "4-8s: the foreign envoy procession enters the long stone corridor — @黄仁勋 stands at the head, dressed in a dark camel-wool diplomatic overcoat layered over his signature black leather jacket, breath visible in the cold air. He pauses, looks up at the gate's gilded plaque. " +
      "8-12s: a single line of minimal ZH subtitle fades in briefly: 『1976 · 仲秋 · 紫禁城』then dissolves. Slow horizontal dolly past silent palace guards in Qing-era ceremonial robes lining the corridor. " +
      "Color: cold jade-cyan dawn sky, warm vermilion gate, oxidized gold accents; no on-screen English subtitle; restrained natural ambient sound: distant bronze bell, footstep echoes on stone."
  },
  {
    title: "2 · 太和殿前殿·递国书",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 2 of 6, 12s, vertical 9:16. Interior of the Hall of Supreme Harmony, deep golden lacquer, dragon-carved pillars, towering throne. " +
      "0-4s: low-angle establishing of the throne — @溥仪 sits enthroned in imperial yellow dragon robe with the mianliu crown, the strings of jade beads in front of his face trembling slightly. Soft warm key light from above, cold blue ambient from the hall's far depths. " +
      "4-8s: cut to @黄仁勋 walking up the dan-bi (丹陛) ceremonial steps, kneels on one knee at the base of the throne, raises a small gold-lacquered flat box held in both hands. Minimal ZH subtitle fades in briefly: 『外臣自阿美莉卡来，献阿美莉卡通商国书。』 " +
      "8-12s: long-lens slow push-in past the jade beads to a tight close-up of @溥仪's eyes — calm, evaluating, not yet warm. He extends a single hand forward in acceptance. " +
      "Continuity: continues directly from the previous corridor shot's pacing and color temperature (cold jade-cyan exterior giving way to warm amber interior)."
  },
  {
    title: "3 · 御书房密谈·开匣识物",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 3 of 6, 12s, vertical 9:16. Private imperial study chamber (御书房), intimate scale: zitan-wood writing desk, scattered bamboo-slip scrolls, a single brass palace lantern. " +
      "Costume shift: @溥仪 is now in a deep black silk Sun-Yat-sen suit, thick round black-rimmed glasses (matches his reference image directly), seated calmly at the desk. @黄仁勋 has shed the diplomatic overcoat, still in his signature black leather jacket. " +
      "0-4s: medium two-shot across the desk. @黄仁勋 carefully sets down the gold-lacquered box and slowly lifts the lid. A soft jade-green glow rises from within. " +
      "4-8s: insert macro shot of the box's interior — a single rectangular metal object (subtly resembling a high-end GPU but stylized as a polished jade-green metal slab with restrained tracery, no modern logos, no neon, no screens). Minimal ZH subtitle fades in: 『此物名曰：显卡。』 " +
      "8-12s: slow rack focus from the device up to @溥仪's face, the jade-green glow reflected in his glasses, his expression shifting from polite evaluation to genuine curiosity. He raises one hand slowly toward the object but does not touch. " +
      "No music, only the soft hiss of the lantern flame and quiet breathing."
  },
  {
    title: "4 · 哲学高潮·从显卡到护城河",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["黄仁勋", "溥仪"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 4 of 6, 12s, vertical 9:16. Same imperial study chamber, slightly later — the lantern oil has burned down a touch, shadows deeper. " +
      "0-4s: tight close-up of @黄仁勋, lit primarily by the jade-green glow of the device. He speaks quietly, deliberately, in a measured low tone. Minimal ZH subtitle fades in line by line: 『不是显卡，是 AI 工厂的地基。』 " +
      "4-8s: the subtitle dissolves, a new line fades in: 『地基之上，万民聚而生态成。』 Camera begins a very slow horizontal dolly from @黄仁勋 to @溥仪, focus follows. " +
      "8-12s: third line fades in over @溥仪's profile: 『生态便是新国族的护城河。』 @溥仪 is now fully in frame, silent, his gaze drifting past @黄仁勋 toward the latticed window — through the lattice we glimpse, distant and softly out of focus, the actual moat (筒子河) of the Forbidden City catching cold blue evening light. " +
      "Sound: a single low cello note enters at second 8, sustains through the end. No cuts."
  },
  {
    title: "5 · 国族隐喻·护城河成桥",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 5 of 6, 12s, vertical 9:16. Exterior dusk: a vermilion-lacquered covered walkway in the Imperial Garden (御花园), curved gilded ridge tiles overhead. Deep amber low-angle setting sun rim-lights the architecture from screen-left. " +
      "0-4s: long-lens horizontal tracking shot following @溥仪 (still in the black Sun-Yat-sen suit, glasses on) walking slowly along the covered walkway, one hand brushing the lacquered handrail. He stops, turns his head three-quarters toward the moat. " +
      "4-8s: matched dolly past him to reveal the actual Forbidden City moat (筒子河) in the background, water surface a cold metallic blue. Minimal ZH subtitle fades in: 『朕的护城河，曾困住朕。』 " +
      "8-12s: subtitle dissolves, a second line fades in as @溥仪 speaks even more quietly: 『汝言生态，是把护城河变成桥。』 In the foreground rack-focus reveals @黄仁勋 standing one step lower on the stone stair, head slightly bowed in listening. " +
      "The single sustained cello from the previous shot fades into a sparse pipa figure."
  },
  {
    title: "6 · 蜜桃四季春·宫灯将熄",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 6 of 6, 12s, vertical 9:16. Deep dusk in the Imperial Garden, a low white-marble stone table set with traditional jade tea cups and brass incense pieces. Two rows of palace lanterns hang behind it, glowing warm amber. " +
      "0-4s: a soft static medium shot — a young palace attendant in grey eunuch robes glides into frame from screen-right, holding a single modern-looking tall plastic-style red cup (clearly a contemporary peach-tea drink, the visual quality of a现代蜜桃四季春饮品 but with NO visible brand text or logos, just the distinctive deep pink-red color and the simple cylinder silhouette). The attendant places the cup respectfully on the marble table beside the jade ware. The visual juxtaposition of the modern red cup against the antique marble is intentional and quietly absurd but framed entirely seriously, Bertolucci-style. " +
      "4-8s: @溥仪 (in the Sun-Yat-sen suit, glasses on) lifts one hand in a small ceremonial gesture, signaling the cup is for the envoy. @黄仁勋 receives the cup in both hands, lowers his head briefly, takes one slow sip; his eyes soften, almost a smile. Minimal ZH subtitle fades in over @溥仪's profile: 『以此茶饯使节。』 " +
      "8-12s: second subtitle line fades in: 『归后告于阿美莉卡：朕之护城河，今为汝开。』 The palace lanterns begin to extinguish, one by one, in a slow procession across the back of frame, leaving only the cold blue twilight. The final frame goes nearly black; a tiny lower ZH title card fades in centered: 『紫禁城 · 1976』, holds 1.5s, then full black. A single distant evening drum strike (暮鼓) closes the audio."
  }
];

async function ensureSession() {
  const state = await jfetch("GET", "/api/state");
  const existing = state.sessions.find((s) => s.title === TITLE);
  if (existing) {
    const shots = state.shots.filter((s) => s.sessionId === existing.id).sort((a, b) => a.index - b.index);
    log(`reusing session ${existing.id} (${TITLE}) with ${shots.length} shots`);
    return { ...existing, shots };
  }
  log(`creating session ${TITLE}...`);
  const session = await jfetch("POST", "/api/sessions", {
    title: TITLE, logline: LOGLINE, style: STYLE, targetDurationSec: 72, shotCount: 6
  });
  log(`session ${session.id} created with ${session.shots.length} shots`);
  return session;
}

async function patchScript(session) {
  log("patching session.story (script panel)...");
  await jfetch("PATCH", `/api/sessions/${session.id}/script`, { story: STORY });
}

async function patchShots(session, characters) {
  log(`patching ${session.shots.length} shots (rawPrompt / 12s / assetIds / continuity flags)...`);
  const result = [];
  for (let i = 0; i < session.shots.length; i += 1) {
    const shot = session.shots[i];
    const tpl = SHOT_TEMPLATES[i];
    if (!tpl) continue;
    const assetIds = tpl.assetNames
      .map((name) => characters.find((c) => c.name === name)?.id)
      .filter(Boolean);
    const patch = {
      title: tpl.title,
      durationSec: tpl.durationSec,
      seedanceVariant: "standard",
      usePreviousShotClip: tpl.usePreviousShotClip,
      previousShotClipSec: tpl.previousShotClipSec || 2,
      rawPrompt: tpl.rawPrompt,
      prompt: "",
      assetIds,
      status: "scripted"
    };
    log(`  shot ${i + 1}: ${tpl.title}  (assets=${assetIds.length}, continuity=${tpl.usePreviousShotClip})`);
    const updated = await jfetch("PATCH", `/api/shots/${shot.id}`, patch);
    result.push(updated);
    await sleep(50);
  }
  return result;
}

async function main() {
  const session = await ensureSession();
  const state = await jfetch("GET", "/api/state");
  const puyi = state.assets.find((a) => a.name === "溥仪");
  const huang = state.assets.find((a) => a.name === "黄仁勋");
  if (!puyi || !huang) throw new Error("缺少 @溥仪 或 @黄仁勋 资产");
  log(`assets: @溥仪 ${puyi.id} / @黄仁勋 ${huang.id}`);
  await patchScript(session);
  await patchShots(session, [puyi, huang]);
  log(`SETUP DONE. Web: ${BASE} → 「${TITLE}」`);
  log(`Session id: ${session.id}`);
  log("No generation triggered. Review the script panel + 6 shot prompts in the web UI before running /generate.");
}

main().catch((err) => {
  errlog(`FATAL: ${err.message}`);
  process.exit(1);
});
