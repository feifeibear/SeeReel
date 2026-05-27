#!/usr/bin/env node
// Fully-automated driver for 《末代皇帝·宫墙旧影》 (72s, 6 shots, Bertolucci/Storaro homage).
//
// Unlike setup_last_emperor.mjs + run_last_emperor.mjs, this script does EVERYTHING in one go,
// with no human-in-the-loop:
//
//   1. Refresh @溥仪 and @黄仁勋 image assets via Seedream so their mediaUrl is a fresh
//      (non-expired) TOS signed URL — the old TOS URLs from a previous day return 403 when
//      Seedance tries to download them as reference images.
//   2. Create (or reuse) the session 《末代皇帝·宫墙旧影》 and patch the script panel.
//   3. Patch all 6 shot rawPrompts / durations / continuity flags / assetIds, never accidentally
//      including unrelated characters from other sessions.
//   4. Generate each shot serially with up to 2 retries; skip shots that are already ready.
//   5. Trigger the async stitch flow, poll /stitch/poll until ready, retry once on error.
//   6. Copy the final mp4 into ~/Downloads.
//
// The whole thing is idempotent. Run it again after a crash and it resumes from where it left.
//
// 关键叙事修改 (vs 末代皇帝·阿美莉卡使节):
//   - 不交代具体年代背景；视觉氛围像辛亥前夜的紫禁城 (暮鸦、铜环氧化、苔痕、夕阳染脊)。
//   - 没有"阿美莉卡"这样的明示外交称谓；@黄仁勋 是"远来异邦使节"。
//   - 第 5 个 shot 溥仪不给任何承诺，只是哲学暗示：所谓护城河不过一时，大清宫墙数百年砖石犹有
//     蚀痕，万物之旧皆有跟不上时代之日。
//   - 第 6 个 shot 用哥窑天青茶盏，不再蜜雪冰城，结尾画面渐黑，没有年份字幕。

import { setTimeout as sleep } from "node:timers/promises";
import { writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = process.env.CINEMA_BASE_URL || "http://127.0.0.1:5173";
const TITLE = "末代皇帝·宫墙旧影";
const LOG_PREFIX = "[gongqiang]";
const SHOT_POLL_INTERVAL_MS = 8000;
const SHOT_TIMEOUT_MS = 25 * 60 * 1000;
const STITCH_POLL_INTERVAL_MS = 5000;
const STITCH_TIMEOUT_MS = 45 * 60 * 1000;

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
  "紫禁城黄昏。宫墙旧而帝业犹存，铜环氧化，琉璃褪光。远来异邦使节 @黄仁勋 越洋叩门，向 @溥仪 进献一物名曰显卡——龙椅之下、御书房深处、雕花窗前三段递进对答。皇帝不许诺、不应允，只在最后以哲学之意暗示：所谓护城河者，不过一时；大清宫墙数百年，砖石犹有蚀痕；万物之旧，皆有跟不上时代之日。一盏哥窑茶送使节归去，宫灯将熄。";

const STYLE = [
  "Bernardo Bertolucci 1987 Last Emperor cinematic homage, Vittorio Storaro-style naturally motivated light",
  "65mm widescreen aesthetic cropped to vertical 9:16, anamorphic lens feel, restrained flare, no modern UI overlay",
  "color palette: deep oxidized vermilion lacquer with copper-green tarnish, oxidized gold, jade-cyan twilight north window, warm amber palace lantern; low saturation overall; late-imperial dust-on-velvet patina",
  "low-ISO 24fps film grain, slow horizontal dolly, low-angle architecture, occasional overhead palace symmetry, frequent silhouettes and contre-jour windows",
  "diegetic ambient sound: silk rustle, distant bronze bell, palace footstep echoes, occasional crow caw, faint pipa; a single sustained low cello only at the philosophical peak",
  "period costuming aligned with late-Qing twilight aesthetic (NOT explicit calendar date): emperor in imperial yellow dragon robe with mianliu crown for the throne scene only; switches to dark black silk Sun-Yat-sen suit with round thick-rim glasses for private chambers; envoy in dark wool overcoat layered over signature black leather jacket",
  "NO on-screen English subtitle; NO calendar-year title cards; NO modern brand logos; minimal single-line classical Chinese subtitle appears briefly at lower frame for dialogue beats only"
].join("; ");

const STORY = {
  premise:
    "架空朝代之暮色：紫禁城犹是当朝宫廷，末代皇帝 @溥仪 仍居其上。远来异邦使节 @黄仁勋 越洋而至，献金匣内一物——显卡。三段递进对答之后，皇帝既不应许，也不拒斥，只以哲学之语暗示：护城河不过一时，宫墙再旧也有蚀痕，万物之旧皆有跟不上时代之日。最后以一盏哥窑茶饯使节，宫灯将熄。",
  synopsis:
    "黄昏紫禁城。@黄仁勋 独行越金水石桥过午门，暮鸦掠过琉璃顶。" +
    "太和殿前殿，@溥仪 着明黄龙袍冕旒于龙椅，金漆斑驳，冕旒前珠串轻颤。@黄仁勋 单膝半跪，呈金漆扁匣。" +
    "御书房密室，@溥仪 已换深色丝绸中山装、戴黑框圆眼镜。@黄仁勋 开匣，匣内一片闪着翡翠绿光的金属。" +
    "@黄仁勋 缓声陈情：『此物非显卡，是机器之地基。地基之上，万民聚而生态成；生态者，新国之护城河也。』" +
    "镜头横移至 @溥仪 侧脸，皇帝沉默良久，起身踱步至雕花窗前，望真正的护城河水光，半侧脸轻语：『汝言护城河。朕亦曾据护城河。大清宫墙数百年，砖石犹有蚀痕。所谓护城河者，不过一时；万物之旧，皆有跟不上时代之日。』" +
    "暮色御花园，宫女托哥窑青瓷茶盏盈盈献上。@溥仪 轻抬手赐使节，@黄仁勋 双手接过，啜一口，眼神柔软。宫灯一盏一盏熄灭，画面渐黑，远处一声暮鼓。",
  theme: "古老封闭文明与开放硅基生态的擦肩——皇帝既不应许也不拒斥，只以哲学之语暗示宫墙再旧亦有蚀痕；旧物自有跟不上时代之日。",
  tone: "庄严、克制、暮色苍凉、淡淡哲学；无承诺，无戏剧化高潮，节奏舒缓。Bertolucci 长镜头、自然光、低饱和。",
  characters: [
    {
      name: "溥仪",
      role: "主角·末代皇帝",
      arc: "正殿庄严接见 → 私下密谈识物 → 凝视护城河沉思 → 以哲学之语暗示宫墙旧物之命，但不许诺",
      assetMention: "@溥仪"
    },
    {
      name: "黄仁勋",
      role: "主角·远来异邦使节",
      arc: "独行入禁门 → 正式呈金匣 → 开匣示物 → 哲学化抬升 (显卡→机器地基→万民生态→新国之护城河) → 受茶饯归去",
      assetMention: "@黄仁勋"
    }
  ],
  beats: [
    {
      index: 1,
      title: "暮鸦寒鸣·使节入禁门",
      purpose: "建立晚清-辛亥前夜般的紫禁城暮色基调，引出独行异邦使节",
      plot:
        "黄昏时分，紫禁城午门飞檐被夕阳染成深红，铜钉门环氧化暗绿。寒鸦数只掠过琉璃顶。@黄仁勋 独自一人，身着深色驼绒大氅外搭其标志性黑皮夹克，缓步过金水河石桥，停在午门下仰望。无字幕，无任何年份提示。",
      emotion: "孤寂、史诗序曲、暮色苍凉",
      visual: "65mm 大画幅低饱和、夕阳侧光、寒鸦剪影、低角度仰拍午门、铜环氧化绿与朱漆并置",
      assetMentions: ["@黄仁勋"],
      durationSec: 12
    },
    {
      index: 2,
      title: "太和殿·递异方物",
      purpose: "首次正殿接见，礼仪秩序确立但不渲染外交称谓",
      plot:
        "太和殿前殿幽深。@溥仪 着明黄龙袍冕旒坐于龙椅，金漆斑驳，烛火摇曳。@黄仁勋 已脱大氅，单膝半跪，双手呈金漆扁匣。长焦缓推过冕旒前珠串到 @溥仪 倦倦的眼神。无字幕，仅镜头语言。",
      emotion: "礼仪克制、相互试探、皇帝眼神含倦",
      visual: "太和殿御座俯仰镜头、丹陛金漆、冕旒前珠串轻颤、冷蓝大殿深处对比暖烛、长焦虚化",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    },
    {
      index: 3,
      title: "御书房密谈·开匣识物",
      purpose: "皇帝换装入凡，第一次直面 \"显卡\"",
      plot:
        "场景切到御书房密室。@溥仪 已换深色丝绸中山装、戴黑框圆眼镜，端坐紫檀书案旁。@黄仁勋 也已脱去皮夹克外的氅衣，仅剩标志性黑皮夹克。他开匣，匣内一片闪着翡翠绿光的金属。字幕短现：『此物名曰：显卡。』溥仪缓缓抬手，宫灯将绿光映于眼镜片，眼神由审视转为好奇。",
      emotion: "亲近、被吸引、内敛震惊",
      visual: "书案近景、宫灯反射、显卡绿光投在皇帝眼镜片、虚化书案笔砚",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    },
    {
      index: 4,
      title: "显卡如基·万民为河",
      purpose: "异邦使节的哲学陈情：从一片金属上升到一国之护城河",
      plot:
        "同一御书房，灯油更低，影子更长。@黄仁勋 在显卡绿光中缓声陈情：『此物非显卡，是机器之地基。地基之上，万民聚而生态成。生态者，新国之护城河也。』字幕逐行显现。镜头由 @黄仁勋 极缓横移至 @溥仪 侧脸，皇帝沉默不语。",
      emotion: "陈情、广义化、克制庄严",
      visual: "横移缓推+焦点拉移，背景虚化的雕花窗与远处护城河水光",
      assetMentions: ["@黄仁勋", "@溥仪"],
      durationSec: 12
    },
    {
      index: 5,
      title: "帝心独答·护城河非永",
      purpose: "全片哲学顶点——皇帝不许诺、不拒斥，只暗示宫墙再旧亦有蚀痕之命",
      plot:
        "@溥仪 起身离案，缓步走至雕花窗前，背手凝视真正的护城河水光，水面冷蓝。半侧脸轻语，语气克制无承诺：『汝言护城河。朕亦曾据护城河。大清宫墙数百年，砖石犹有蚀痕。所谓护城河者，不过一时。』顿一顿，更轻：『万物之旧，皆有跟不上时代之日。』字幕逐行隐现。@黄仁勋 立于书案旁，低头静听，不答。",
      emotion: "苍凉、超脱、克制、淡淡哲学；无承诺、无应允",
      visual: "长焦背影到三分之一侧脸、雕花窗光斑落于皇帝面颊、护城河虚焦冷蓝、@黄仁勋 始终模糊于前景",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    },
    {
      index: 6,
      title: "茶饯·宫灯渐熄",
      purpose: "古礼收尾，皇帝既未应许亦未拒斥，仅以一盏茶饯送使节归去",
      plot:
        "暮色御花园石桌前，宫女着青灰宫装托哥窑天青釉茶盏盈盈而入，置于皇帝面前。@溥仪 微抬手赐于使节，@黄仁勋 双手接过，啜一口，眼神柔软不语。无字幕，无对白。宫灯一盏一盏熄灭，画面渐黑，远处一声暮鼓。最终全黑——不出现任何年份、地点字幕。",
      emotion: "和缓、温柔、暮色收束、淡淡苍凉",
      visual: "石桌静物特写、哥窑天青釉茶盏与汉白玉石面并置、宫灯熄灭节奏剪辑、画面渐黑+暮鼓收音",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    }
  ],
  locked: true
};

const STYLE_PREFIX =
  "Bertolucci-Storaro 1987《末代皇帝》visual homage. 65mm widescreen aesthetic cropped to vertical 9:16. " +
  "Naturally motivated lighting only: warm amber palace lanterns + cold jade-cyan north window light + deep vermilion lacquer with oxidized copper-green tarnish on bronze fittings. " +
  "Low-ISO 24fps film grain, slow horizontal dolly moves, restrained anamorphic flare, no neon, no modern UI overlay, no on-screen English subtitle. " +
  "Diegetic ambient sound: silk rustle, distant bronze ceremonial bell, palace footstep echoes on stone, occasional crow caw, faint pipa; a single sustained low cello only at the philosophical peak. " +
  "Costume rule: the emperor is in imperial yellow dragon robe with mianliu crown ONLY for the throne hall scene; for all private chamber and garden scenes he wears a deep black silk Sun-Yat-sen suit with thick round black-rimmed glasses (matches the emperor reference image directly). The envoy wears a dark camel-wool diplomatic overcoat layered over his signature fitted black leather moto jacket; in private chamber scenes he sheds the overcoat and wears only the black leather jacket (matches the envoy reference image directly). " +
  "Minimal single-line classical Chinese subtitle appears briefly at lower frame ONLY for the marked dialogue beats. " +
  "NEVER show calendar year, dynasty year, country names, English subtitles, or modern brand logos anywhere in the frame. Faces follow the supplied subject reference images for each named role exactly.";

const SHOT_TEMPLATES = [
  {
    title: "1 · 暮鸦寒鸣·使节入禁门",
    durationSec: 12,
    usePreviousShotClip: false,
    assetNames: ["黄仁勋"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 1 of 6, 12s, vertical 9:16. Late twilight at the Meridian Gate of the Forbidden City, late-imperial atmosphere — no calendar year, no country label anywhere. " +
      "0-4s: a slow wide overhead crane shot of the Meridian Gate flying eaves silhouetted against a deep amber-orange dusk sky streaked with bronze cloud. A flock of crows lifts off the glazed-tile roofs, calling. Copper-green oxidized tarnish on the gate's bronze door studs, deep vermilion lacquer faded. Faint cold mist drifts low over the Jinshui (Golden Water) River below. " +
      "4-8s: a single figure — @黄仁勋, alone, dressed in a long dark camel-wool diplomatic overcoat over his signature fitted black leather moto jacket, his breath visible in the cold autumn air — walks slowly across the white-marble Jinshui stone bridge toward camera. He pauses mid-bridge. " +
      "8-12s: low-angle reverse, the towering Meridian Gate fills frame above him; he tilts his head back, looking up at the gilded plaque, eyes calm but tired. NO subtitle, NO title card, NO date overlay, NO English text anywhere. Sound: distant bronze bell, single crow caw, footsteps on stone."
  },
  {
    title: "2 · 太和殿·递异方物",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 2 of 6, 12s, vertical 9:16. Interior of the Hall of Supreme Harmony (太和殿), deep golden lacquer with patina, dragon-carved pillars, towering throne. Atmosphere of late-imperial twilight; cold blue ambient light from the hall's depths, warm amber key light from above the throne. " +
      "0-4s: low-angle establishing shot of the throne — @溥仪 sits enthroned in imperial yellow dragon robe with the mianliu crown, the strings of jade beads in front of his face trembling slightly. His eyes look quietly tired beneath the beads. " +
      "4-8s: cut to @黄仁勋 walking up the dan-bi (丹陛) ceremonial steps. He has shed his camel-wool overcoat; he is now in his signature fitted black leather moto jacket only, paired with a plain black crew-neck t-shirt underneath. He kneels on one knee at the foot of the throne and raises a small gold-lacquered flat box held in both hands. " +
      "8-12s: long-lens slow push-in past the trembling jade beads to a tight close-up of @溥仪's eyes — calm, evaluating, almost weary, not warm. He extends a single hand forward in acceptance. NO subtitle, NO title card. " +
      "Continuity: this shot continues directly from the prior Meridian Gate exterior (the envoy's pacing and overcoat-then-jacket transition), keeping the same low-saturation, copper-green tarnish-and-vermilion palette."
  },
  {
    title: "3 · 御书房密谈·开匣识物",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 3 of 6, 12s, vertical 9:16. Private imperial study chamber (御书房), intimate scale: zitan-wood writing desk, scattered bamboo-slip scrolls, a single brass palace lantern, latticed window casting cold blue twilight from one side. " +
      "Costume shift: @溥仪 is now in a deep black silk Sun-Yat-sen suit, thick round black-rimmed glasses (matches @溥仪 reference image exactly), seated calmly at the desk. @黄仁勋 remains in his signature fitted black leather moto jacket. " +
      "0-4s: medium two-shot across the desk. @黄仁勋 carefully sets down the gold-lacquered box and slowly lifts the lid. A soft jade-green glow rises from within. " +
      "4-8s: insert macro shot of the box's interior — a single rectangular metal object (subtly resembling a high-end GPU, stylized as a polished jade-green metal slab with restrained traditional tracery, NO modern logos, NO neon, NO screens, NO English text). Minimal single-line classical Chinese subtitle fades in briefly at the lower frame: 『此物名曰：显卡。』 " +
      "8-12s: slow rack focus from the device up to @溥仪's face, the jade-green glow reflected in his glasses, his expression shifting from polite evaluation to genuine curiosity. He raises one hand slowly toward the object but does NOT touch. " +
      "Sound: only the soft hiss of the lantern flame and quiet breathing. NO music."
  },
  {
    title: "4 · 显卡如基·万民为河",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["黄仁勋", "溥仪"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 4 of 6, 12s, vertical 9:16. Same imperial study chamber, slightly later — the lantern oil has burned down a touch, shadows deeper, latticed window glow has cooled toward blue. " +
      "0-4s: tight close-up of @黄仁勋, lit primarily by the jade-green glow of the device on the desk. He speaks quietly, deliberately, in a low measured tone. Minimal single-line classical Chinese subtitle fades in at the lower frame: 『此物非显卡，是机器之地基。』 " +
      "4-8s: the first subtitle dissolves; a new line fades in: 『地基之上，万民聚而生态成。』 Camera begins a very slow horizontal dolly from @黄仁勋 across the desk toward @溥仪, focus follows. " +
      "8-12s: third line fades in over @溥仪's profile: 『生态者，新国之护城河也。』 @溥仪 is now fully in frame, silent, eyes lowered, his face giving nothing away — neither agreement nor refusal. Beyond the latticed window, far in the background and softly out of focus, the actual moat (筒子河) of the Forbidden City catches the last cold blue light. " +
      "Sound: a single low sustained cello note enters at second 8 and holds through the end. No cuts."
  },
  {
    title: "5 · 帝心独答·护城河非永",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 5 of 6, 12s, vertical 9:16. The philosophical peak of the film. Same imperial study, but @溥仪 has risen and crossed to the carved latticed window on the north wall. The window glow on his face is a cold jade-cyan, the rest of the room is deep warm amber from the lantern behind him. " +
      "0-4s: slow long-lens tracking from behind — @溥仪 (deep black silk Sun-Yat-sen suit, round thick-rim glasses) walks slowly from the desk to the lattice window, hands clasped behind his back. He stops, gazes out at the actual Forbidden City moat (筒子河) visible through the lattice, water surface a metallic cold blue in late twilight. " +
      "4-8s: dolly slowly past his shoulder to a tight three-quarter profile. He speaks in a low even voice, with no warmth and no harshness — only meditation. Minimal single-line classical Chinese subtitle fades in at the lower frame, line by line: 『汝言护城河。朕亦曾据护城河。』 then dissolves; new line: 『大清宫墙数百年，砖石犹有蚀痕。』 " +
      "8-12s: final line of the speech fades in, even quieter: 『所谓护城河者，不过一时；万物之旧，皆有跟不上时代之日。』 Rack focus pulls to reveal @黄仁勋 standing softly out of focus in the foreground, beside the desk, head lowered in silent listening. He does NOT respond. The cello sustains, then resolves down a single half-step. " +
      "Critical: the emperor must give NO promise, NO concession, NO consent — only weary meditation. His expression is reserved, almost gentle, never triumphant or defeated."
  },
  {
    title: "6 · 茶饯·宫灯渐熄",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 6 of 6, 12s, vertical 9:16. Deep dusk in the Imperial Garden (御花园). A low white-marble stone table beneath a covered walkway, traditional bronze incense pieces set on it. Behind the table, two rows of brass palace lanterns hang in symmetry, glowing warm amber. The actual moat (筒子河) visible faintly in the cold blue distance. " +
      "0-4s: a soft static medium shot — a young palace attendant in muted grey-blue palace robes glides into frame from screen-right, holding a single small Ge-yao (哥窑) celadon tea cup in pale jade-green with the classic crackled glaze (NO modern logos, NO branded plastic, only authentic-looking late-imperial ceramic). She places the cup respectfully on the marble table in front of @溥仪. " +
      "4-8s: @溥仪 (still in the deep black Sun-Yat-sen suit, round thick-rim glasses) lifts one hand in a small ceremonial gesture, signaling the cup is for the envoy. @黄仁勋 (signature fitted black leather moto jacket) receives the cup in both hands, bows his head briefly, takes one slow sip. His eyes soften, almost a smile. NO subtitle, NO dialogue. " +
      "8-12s: the palace lanterns begin to extinguish, one by one in a slow procession across the back of frame, leaving only the cold blue twilight on the marble table. The final frame fades to near black. Sound: a single distant evening drum strike (暮鼓) closes the audio. " +
      "Absolutely NO title card, NO calendar-year text, NO English subtitle anywhere — final frame is pure black silence with only the residual drum reverberation."
  }
];

async function findSession(state) {
  return state.sessions.find((s) => s.title === TITLE);
}

async function ensureFreshAsset(name) {
  // Always re-generate so the TOS mediaUrl is freshly signed and Seedance can download it. The
  // existing prompt on the asset is reused; the resulting URL is a fresh 24h signed TOS link.
  log(`refreshing asset @${name}...`);
  const state = await jfetch("GET", "/api/state");
  const asset = state.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`asset @${name} not found in store`);
  const refreshed = await jfetch("POST", `/api/assets/${asset.id}/generate`, { model: "seedream-4" });
  log(`  @${name} -> ${refreshed.id} mediaUrl=${(refreshed.mediaUrl || "").slice(0, 90)}...`);
  return refreshed;
}

async function ensureSession() {
  const state = await jfetch("GET", "/api/state");
  const existing = await findSession(state);
  if (existing) {
    const shots = state.shots.filter((s) => s.sessionId === existing.id).sort((a, b) => a.index - b.index);
    log(`reusing session ${existing.id} (${TITLE}) with ${shots.length} shots`);
    return { ...existing, shots };
  }
  log(`creating new session ${TITLE}...`);
  const session = await jfetch("POST", "/api/sessions", {
    title: TITLE, logline: LOGLINE, style: STYLE, targetDurationSec: 72, shotCount: 6
  });
  log(`session ${session.id} created with ${session.shots.length} shots`);
  return session;
}

async function patchScriptAndShots(session, characters) {
  log("patching session.story...");
  await jfetch("PATCH", `/api/sessions/${session.id}/script`, { story: STORY });

  log(`patching ${session.shots.length} shots (rawPrompt / 12s / assetIds / continuity)...`);
  const patched = [];
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
    patched.push(updated);
    await sleep(50);
  }
  return patched;
}

async function pollShotUntilTerminal(shotId) {
  const deadline = Date.now() + SHOT_TIMEOUT_MS;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const shot = await jfetch("POST", `/api/shots/${shotId}/poll`, {});
    if (shot.status !== lastStatus) {
      log(`    [poll] status=${shot.status}${shot.error ? ` error=${shot.error}` : ""}`);
      lastStatus = shot.status;
    }
    if (shot.status === "ready" && shot.videoUrl) return shot;
    if (shot.status === "error" || shot.status === "cancelled") return shot;
    await sleep(SHOT_POLL_INTERVAL_MS);
  }
  throw new Error(`Shot ${shotId} polling timed out after ${(SHOT_TIMEOUT_MS / 60000).toFixed(0)}min`);
}

async function submitShotOnce(shot) {
  // Always re-fetch the most recent shot snapshot first so we pick up the latest assetIds /
  // continuity flags / rawPrompt patched above.
  const state = await jfetch("GET", "/api/state");
  const fresh = state.shots.find((s) => s.id === shot.id);
  const target = fresh || shot;
  const submission = await jfetch("POST", `/api/shots/${target.id}/generate`, {
    rawPrompt: target.rawPrompt,
    prompt: target.rawPrompt,
    seedanceVariant: target.seedanceVariant,
    usePreviousShotClip: target.usePreviousShotClip,
    previousShotClipSec: target.previousShotClipSec,
    assetIds: target.assetIds,
    durationSec: target.durationSec,
    firstFrameAssetId: target.firstFrameAssetId
  });
  log(`    submitted, status=${submission.status}, task=${submission.generationTaskId || "-"}`);
}

async function generateShotWithRetry(shot, indexLabel) {
  if (shot.status === "ready" && shot.videoUrl) {
    log(`>>> ${indexLabel}: ${shot.title}  (already ready, skip)`);
    return shot;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    log(`>>> ${indexLabel}: ${shot.title}  (attempt ${attempt}/3)`);
    try {
      await submitShotOnce(shot);
    } catch (err) {
      errlog(`    submit failed: ${err.message}`);
      if (attempt === 3) throw err;
      await sleep(10000);
      continue;
    }
    const result = await pollShotUntilTerminal(shot.id);
    if (result.status === "ready" && result.videoUrl) {
      log(`    DONE: videoUrl=${(result.videoUrl || "").slice(0, 80)}${result.videoUrl?.length > 80 ? "..." : ""}`);
      return result;
    }
    errlog(`    shot ${indexLabel} terminated with status=${result.status} error=${result.error || "-"}`);
    if (attempt === 3) throw new Error(`Shot ${indexLabel} failed after ${attempt} attempts: ${result.error || result.status}`);
    log(`    will retry in 15s...`);
    await sleep(15000);
  }
  throw new Error(`unreachable`);
}

async function generateAllSerial(session) {
  log(`generating ${session.shots.length} shots serially (continuity matters)...`);
  const finals = [];
  for (let i = 0; i < session.shots.length; i += 1) {
    const label = `shot ${i + 1}/${session.shots.length}`;
    // refresh from server to pick up new continuity refs after the prior shot finished
    const state = await jfetch("GET", "/api/state");
    const fresh = state.shots.find((s) => s.id === session.shots[i].id) || session.shots[i];
    const shot = await generateShotWithRetry(fresh, label);
    finals.push(shot);
  }
  return finals;
}

async function triggerStitchAndWait(sessionId) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    log(`stitching final video (attempt ${attempt}/3)...`);
    const trigger = await jfetch("POST", `/api/sessions/${sessionId}/stitch`, {});
    log(`    POST /stitch -> status=${trigger.stitchStatus} progress=${JSON.stringify(trigger.stitchProgress || "")} finalVideoUrl=${trigger.finalVideoUrl || "(none)"}`);
    if (trigger.stitchStatus === "ready" && trigger.finalVideoUrl) return trigger;
    if (trigger.stitchStatus === "error") {
      errlog(`    immediate stitch error: ${trigger.stitchError || "(unknown)"}`);
      if (attempt === 3) throw new Error(`Stitch failed: ${trigger.stitchError || "unknown"}`);
      await sleep(10000);
      continue;
    }

    const deadline = Date.now() + STITCH_TIMEOUT_MS;
    let lastProgress = "";
    let lastStatus = trigger.stitchStatus;
    while (Date.now() < deadline) {
      await sleep(STITCH_POLL_INTERVAL_MS);
      const snapshot = await jfetch("POST", `/api/sessions/${sessionId}/stitch/poll`, {});
      if ((snapshot.stitchProgress || "") !== lastProgress || snapshot.stitchStatus !== lastStatus) {
        log(`    [stitch] ${snapshot.stitchStatus}: ${snapshot.stitchProgress || "(no progress text)"}`);
        lastProgress = snapshot.stitchProgress || "";
        lastStatus = snapshot.stitchStatus;
      }
      if (snapshot.stitchStatus === "ready" && snapshot.finalVideoUrl) {
        log(`    stitching done: ${snapshot.finalVideoUrl}`);
        return snapshot;
      }
      if (snapshot.stitchStatus === "error") {
        errlog(`    stitch worker reported error: ${snapshot.stitchError || "(unknown)"}`);
        break;
      }
    }
    if (attempt === 3) throw new Error(`Stitch failed after retry`);
    log(`    will retry stitch in 15s...`);
    await sleep(15000);
  }
  throw new Error("unreachable stitch retry loop");
}

async function deliver(session) {
  if (!session.finalVideoUrl) throw new Error("Session did not produce a final video");
  let localPath;
  if (session.finalVideoUrl.startsWith("/media/")) {
    localPath = path.resolve(process.cwd(), "data", "media", path.basename(session.finalVideoUrl));
  } else if (session.finalVideoUrl.startsWith("http")) {
    localPath = path.resolve(os.tmpdir(), `${session.id}-final.mp4`);
    const res = await fetch(session.finalVideoUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, buf);
  }
  if (!localPath) throw new Error(`Cannot resolve final video path from ${session.finalVideoUrl}`);
  const downloads = path.join(os.homedir(), "Downloads");
  await mkdir(downloads, { recursive: true });
  const target = path.join(downloads, `${TITLE}-cinema_agent-${session.id}.mp4`);
  await copyFile(localPath, target);
  log(`delivered: ${target}`);
  return target;
}

async function main() {
  log(`base=${BASE}`);

  // 1. Refresh asset images so reference TOS URLs are not stale.
  await jfetch("GET", "/api/state"); // health
  const fresh溥仪 = await ensureFreshAsset("溥仪");
  const fresh黄仁勋 = await ensureFreshAsset("黄仁勋");

  // 2. Ensure session exists, patch story + shot rawPrompts/assetIds.
  const session = await ensureSession();
  await patchScriptAndShots(session, [fresh溥仪, fresh黄仁勋]);

  // 3. Refresh session snapshot (assetIds/refClips may have changed).
  const state = await jfetch("GET", "/api/state");
  const refreshedSession = state.sessions.find((s) => s.id === session.id);
  const refreshedShots = state.shots
    .filter((s) => s.sessionId === session.id)
    .sort((a, b) => a.index - b.index);
  const full = { ...refreshedSession, shots: refreshedShots };

  // 4. Generate all 6 shots serially.
  log(`session ${full.id} (${full.shots.length} shots)`);
  await generateAllSerial(full);

  // 5. Stitch the final video.
  const stitched = await triggerStitchAndWait(full.id);

  // 6. Deliver to ~/Downloads.
  const target = await deliver(stitched);
  log(`ALL DONE -> ${target}`);
}

main().catch((err) => {
  errlog(`FATAL: ${err.message}`);
  process.exit(1);
});
