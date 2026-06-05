#!/usr/bin/env node
// Setup-only script for 《追猎美洲狮·英伦乡野》 — BBC nature-documentary vertical short film
// based on the New Concept English Book 3 Lesson 1 "A Puma at Large".
//
// What it does (idempotent, can re-run):
//   1. Find or create the session 《追猎美洲狮·英伦乡野》.
//   2. PATCH the script panel (premise / synopsis / theme / tone / characters / beats).
//   3. PATCH each of 6 shots with rawPrompt / durationSec=15 / continuity flags / status=scripted.
//   4. For each shot, POST /api/shots/:shotId/sketches { count } to generate N private (shot-scoped)
//      sketches via Seedream. These sketches live ONLY inside the shot — they don't appear in the
//      global Asset Library, can't be picked up by other shots' @mentions, and get cascade-deleted
//      when the shot (or its session) is deleted.
//
// What it does NOT do: trigger any Seedance video generation or stitching. The user is expected
// to review the storyboard + sketches in the web UI first, regenerate/upload/delete sketches as
// needed, then run a separate runner script to actually produce the final mp4.
//
// 剧本注记:
//   - 课文片段:Pumas are large, cat-like animals which are found in America. When reports came
//     into London Zoo that a wild puma had been spotted forty-five miles south of London, ...
//   - 风格: BBC nature documentary, naturalistic available light, anamorphic 9:16, long-lens
//     observational pacing, hand-held when in pursuit, fog/dew/rain mood, low-saturation
//     greens/earth tones, fine 16mm film grain. Diegetic ambient only (birds, wind, distant
//     thunder, dog, grass rustle); NO music, NO subtitle, NO voiceover.
//   - 时长: 6 shots × 15s = 90s, vertical 9:16 (TikTok / Douyin).

import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.CINEMA_BASE_URL || "http://127.0.0.1:5173";
const TITLE = "追猎美洲狮·英伦乡野";
const LOG_PREFIX = "[puma-setup]";

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
  "英国乡野，雾色未散。伦敦动物园接到一系列报告：有人在伦敦以南四十五英里处目击一只野生美洲狮——一种本只产自美洲的大型猫科。证据陆续累积，专家不得不出动。证人描述惊人相似：黑莓灌木边五码外的金棕色身影、清晨在此夜里在二十英里外、爪印、灌木上的金毛、夜半的猫鸣、垂钓商人见它伏于树上。但所有动物园都没有失踪记录——它只可能是某位私人收藏者养而失控的。搜捕持续数周，美洲狮始终未被擒获。它仍在这片寂静的乡间逍遥。";

const STYLE = [
  "BBC nature documentary aesthetic, restrained Attenborough-era observational tone",
  "naturally motivated available light only (overcast English diffuse, golden hour rim, dusk silhouette, moonlit fog, headlamp pool); zero artificial movie lights visible in frame",
  "65mm-equivalent long lens compression for distant wildlife observation; occasional handheld shoulder-rig shake when in pursuit; rare dolly; mostly locked-off tripod",
  "anamorphic-ish vertical 9:16, restrained lens breathing, gentle 16mm film grain, low-saturation moss-green / wet-stone / oat-yellow palette",
  "diegetic ambient sound only — rooks cawing, wind through hawthorn, distant church bell, sheep, far thunder, rain on barn roof, footsteps on wet stubble; NO music score; NO voiceover narration; NO on-screen subtitles or captions",
  "production design: hedgerows, blackberry brambles, drystone walls, oak woodland, river fishing pegs, muddy farm tracks, paw-print plaster casts; period-agnostic English countryside",
  "the puma itself appears only briefly, partially, often in silhouette or in motion blur, never as a hero portrait — this is observation, not spectacle"
].join("; ");

const STORY = {
  premise:
    "BBC 风格自然纪录片：英国南方乡野出现一只本不属于这片土地的美洲狮。从一位采黑莓的村妇五码外的对视，到爪印、毛丝、鹿骸、垂钓商人树梢一瞥、专家夜巡，证据层层堆叠，搜捕却始终落空。最后镜头停在雨夜的乡间小路，金棕色身影翻墙隐入树林。",
  synopsis:
    "晨雾中，俯瞰英国南方丘陵田野，篱笆与教堂尖顶若隐若现。" +
    "村庄边缘，一名穿粗呢的中年女子蹲在黑莓篱前采摘，五码外灌木摇动，一只金棕色大猫与她对视一瞬，转身没入草丛。" +
    "山野证据蒙太奇：泥地上深陷的爪印、缠在枸杞与黑刺李灌木上的金棕色毛丝、林缘一只被掏空的鹿尸——苍蝇环绕。" +
    "暮色河弯，戴呢帽的商人独坐垂钓，他抬眼，远处树梢逆光剪影里一只伏着的猫科身影一动不动。" +
    "潮湿深夜，伦敦动物园的专家披雨衣举手电筒走过田埂；光柱扫过草丛深处，一对兽眼短促反光后熄灭。" +
    "雨夜乡间小路，远处一道金棕色身影掠过石墙，无声地隐入林间。镜头停在空墙与雨幕，几声远雷，画面留白。",
  theme: "异乡生物在熟悉的田园里出没；目击的累积与抓捕的失败；寂静乡间隐藏的不安。",
  tone: "克制、慢、观察式；几乎全部环境音；让画面与等待说话。",
  characters: [
    {
      name: "村妇",
      role: "采黑莓的中年农妇",
      arc: "蹲身采摘 → 灌木摇动 → 与五码外金棕色大猫对视 → 大猫转身没入草丛"
    },
    {
      name: "垂钓商人",
      role: "戴呢帽的城里人，黄昏河边独钓",
      arc: "抬竿 → 抬眼 → 树梢逆光中看见一只伏着的猫科身影 → 不动声色"
    },
    {
      name: "动物园专家",
      role: "雨衣手电筒，伦敦动物园派来的实地调查员",
      arc: "雨夜手电沿田埂搜 → 光柱扫过 → 一对兽眼短促反光后熄灭"
    },
    {
      name: "美洲狮 puma",
      role: "本片真正的主角；从未正面亮相，只以剪影、毛丝、爪印、反光眼、远去身影出现"
    }
  ],
  beats: [
    {
      index: 1,
      title: "静晨乡野",
      purpose: "建立 BBC 自然纪录片基调；引出英国南方乡野的雾色与安静",
      plot:
        "黎明前微光，雾从低洼草地升起。远景一架无人机般的高空缓推：英国南方丘陵、绵延的篱笆、远处一座灰石教堂尖顶、一片绿到发黑的橡树林。前景一只小鹿警觉抬头，瞬即跳入灌木消失。无人出现，无字幕。",
      emotion: "宁静、克制、有一丝预兆性的紧张",
      visual: "高空缓推 → 落到丘陵地平线 → 长焦推近警觉的小鹿；自然 ambient 鸟鸣 + 远处教堂钟",
      assetMentions: [],
      durationSec: 15,
      sketchCount: 2
    },
    {
      index: 2,
      title: "黑莓边缘·五码对视",
      purpose: "第一次目击；最关键的证人镜头",
      plot:
        "村庄边缘的黑莓篱笆。一名身穿深绿粗呢外套、头戴方巾的中年女子蹲在篱前，提着柳条篮摘黑莓，手指被刺扎得通红。镜头长焦从她肩后越过篱笆——五码外灌木里现出一只金棕色大猫的脸：圆头、短耳、低伏。两者对视一瞬。大猫无声转身，金色身影沿草丛低速远去，只留摇动的草。村妇缓慢直起腰，脸上是惊未及发的呆滞。无对白、无字幕。",
      emotion: "克制的惊心；纪录片式的旁观，不渲染",
      visual: "肩后越肩长焦 → 灌木中浮现兽脸 → 大猫转身远去；ambient 风声 + 黑莓篱沙沙",
      assetMentions: [],
      durationSec: 15,
      sketchCount: 2
    },
    {
      index: 3,
      title: "证据蒙太奇·爪印·毛丝·残骸",
      purpose: "证据累积的视觉化；专家说服自己「这真的是美洲狮」的素材",
      plot:
        "一组慢节奏蒙太奇，全部局部特写，无人物：① 雨后泥地上一只清晰的猫科爪印特写（无爪痕——猫科爪可缩，正是判断依据），手指比例棍轻轻入画做对照后退出；② 黑刺李灌木枝上挂着一缕金棕色毛丝，被微风吹动；③ 林缘草地一只死去多日的小鹿，肋骨已露，皮毛被啃出整齐圆口，几只乌鸦警觉跃开；④ 一只野兔的零散白毛散落在湿石路面。每一格切换都有简短停顿。",
      emotion: "冷静、近乎科学的观察；却又一格比一格更不安",
      visual: "四个静物特写连切；rack focus / 缓推；ambient 雨后滴水、苍蝇翅、乌鸦",
      assetMentions: [],
      durationSec: 15,
      sketchCount: 3
    },
    {
      index: 4,
      title: "暮河垂钓·树梢一瞥",
      purpose: "第二个清晰目击；动物在「看着」我们而非反过来",
      plot:
        "暮色河弯。一位戴深褐色呢帽、穿驼色防风外套的中年商人独坐折叠凳上垂钓，鱼线在水面映出夕阳。他喝一口保温瓶里的茶，缓缓抬眼望向对岸——长焦推过去：河对岸一棵孤立大橡树的低粗树枝上，逆光金色剪影里，一只伏着的猫科身影一动不动，尾巴尖偶尔轻甩。商人的脸定在那里，喉结动了一下，没有放下茶杯，也没有大喊。",
      emotion: "屏息；一个普通人意识到自己看见了不该看见的东西",
      visual: "中景人物 → 越肩望向对岸 → 长焦推树梢 puma 逆光剪影；ambient 水声 + 远处羊叫 + 茶杯轻响",
      assetMentions: [],
      durationSec: 15,
      sketchCount: 2
    },
    {
      index: 5,
      title: "专家夜巡·一双反光眼",
      purpose: "搜捕开始；但夜色与雨水让一切归于徒劳",
      plot:
        "潮湿的深夜，断续雨。一名穿橄榄绿橡胶雨衣、肩背帆布袋的中年男子（伦敦动物园专家），举一支大手电筒，沿田埂缓步向前。手电光柱穿过雨幕，扫过齐腰高的湿草丛、一段坍塌的石墙、几个被踩出的猫科脚印——光柱停在草丛深处，远端两点贴近地面的兽眼短促反光，绿中带金；不到两秒，反光消失。专家半举手停在原地，雨水沿帽檐落下。",
      emotion: "克制的紧张；不是恐怖片的吓你一跳，而是纪录片的徒劳感",
      visual: "肩后跟拍手电光柱 → 草丛深处兽眼反光 → 反光熄灭；ambient 雨打雨衣 + 远雷 + 水滴",
      assetMentions: [],
      durationSec: 15,
      sketchCount: 2
    },
    {
      index: 6,
      title: "雨夜乡间·身影翻墙",
      purpose: "结尾留白；它依然在外面",
      plot:
        "深夜雨幕中的乡间小路，路灯一盏，远端一段干石墙。镜头静止长达数秒，只有雨声与一两声远雷。突然，画面远端、几乎边缘处，一道金棕色身影低伏掠过石墙顶，无声跃入墙后林间。镜头不追、不切近，仍然静止。雨继续下，水洼起涟漪。两秒后，画面渐渐变暗收尾。无字幕，无任何收尾文字，仅雨声渐弱、一声远处犬吠收音。",
      emotion: "苍凉、未完、隐忧",
      visual: "锁定中长镜头乡间小路 → 远端石墙顶 puma 身影掠过 → 画面渐黑；ambient 雨 + 远雷 + 远犬吠",
      assetMentions: [],
      durationSec: 15,
      sketchCount: 1
    }
  ],
  locked: true
};

const STYLE_PREFIX =
  "BBC nature-documentary visual homage, restrained Attenborough-era observational tone. Vertical 9:16, anamorphic-ish long-lens compression, fine 16mm film grain, low-saturation moss-green / wet-stone / oat-yellow English countryside palette. Naturally motivated available light only (overcast diffuse, golden-hour rim, dusk silhouette, moonlit fog, headlamp pool); no artificial movie lights visible in frame. " +
  "Diegetic ambient sound only — rooks cawing, wind through hawthorn, distant church bell, sheep, far thunder, rain on barn roof, footsteps on wet stubble; NO music score; NO voiceover narration; NO on-screen subtitles, captions, lower thirds, or title cards anywhere. " +
  "Production design: hedgerows, blackberry brambles, drystone walls, oak woodland, river fishing pegs, muddy farm tracks. The puma itself, when shown, appears only briefly and partially — in silhouette, in motion blur, half-hidden in foliage, as paw-prints, as a tuft of fur on a thorn, as a pair of eye-shines — never as a hero glamour portrait. This is observation, not spectacle. Composition values negative space and long held takes.";

const SHOT_TEMPLATES = [
  {
    title: "1 · 静晨乡野",
    durationSec: 15,
    usePreviousShotClip: false,
    sketchCount: 2,
    sketchPrompt:
      "BBC nature documentary establishing still, vertical 9:16. Pre-dawn English countryside in soft mist: rolling chalk-down hills, hedgerow grids, a distant grey-stone village church spire, a black oak copse on the horizon, low fog drifting through a hayfield. Foreground: a young roe deer lifts its head alert at the edge of long wet grass. Naturally diffused overcast first-light, desaturated moss/oat palette, fine 16mm grain. No people, no text, no subtitles, no logos.",
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 1 of 6, 15s, vertical 9:16. Pre-dawn English countryside, BBC nature-doc establishing shot. " +
      "0-6s: slow drone-style high crane move from above the mist, gliding north over rolling chalk-down hills, hedgerow grids and a grey-stone village church spire emerging through low fog. Restrained motion; the air still cold-blue, the eastern horizon flushing pale amber. " +
      "6-12s: descent into a long-lens shoulder of a hillside; the camera locks off on a hayfield edge. " +
      "12-15s: a young roe deer lifts its head alert at the far edge of long wet grass, ears swiveling toward an unseen rustle, then bounds into the hedgerow and vanishes. Ambient: distant rook cawing, far church bell, wind through hawthorn. NO subtitle, NO title card, NO music."
  },
  {
    title: "2 · 黑莓边缘·五码对视",
    durationSec: 15,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    sketchCount: 2,
    sketchPrompt:
      "BBC nature documentary still, vertical 9:16. Hedgerow of wild blackberry brambles at a village edge, mid-morning overcast. A middle-aged English woman in a dark-green tweed jacket and headscarf squats in front of the bramble holding a wicker basket of dark berries, fingers scratched red. Five yards beyond the bramble, deep in the foliage, the partial face of a large tawny cat (puma / cougar) — round head, short rounded ears, low to the ground, golden eyes — peers out, almost camouflaged. Long-lens over-the-shoulder framing. Naturally diffused light. No text.",
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 2 of 6, 15s, vertical 9:16. The first clear sighting of the puma — the key witness moment. Long-lens over-the-shoulder framing throughout. " +
      "0-5s: locked over-the-shoulder long-lens of a middle-aged English country woman (dark-green tweed jacket, headscarf) squatting at a wild-blackberry hedgerow, picking berries into a wicker basket, fingers scratched red. " +
      "5-10s: rustle in the brambles five yards beyond her. Slow rack focus past her shoulder to the bramble — emerging from the foliage a large tawny puma's partial face: round head, short rounded ears, low to the ground, golden eyes. Two seconds of mutual gaze. " +
      "10-15s: the puma turns silently; only the moving grass marks its slow exit along the hedgerow. The woman straightens up slowly, mouth slightly open, too stunned to speak. Ambient: wind in brambles, far sheep bleat, the woman's quiet breath. NO subtitle, NO music. " +
      "Continuity: continues directly from the establishing shot's color temperature and ambient sound design (overcast English diffuse)."
  },
  {
    title: "3 · 证据蒙太奇·爪印·毛丝·残骸",
    durationSec: 15,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    sketchCount: 3,
    sketchPrompt:
      "BBC nature documentary still, vertical 9:16. A clean still-life macro insert in muted English countryside palette: deeply impressed cat-family paw print in wet brown clay, no claw marks visible (the felid trait), fallen oak leaves around it, soft overcast light, fine film grain. Naturalistic available light only. No text, no people in frame.",
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 3 of 6, 15s, vertical 9:16. Slow evidence montage of close-ups, NO human characters in frame, NO dialogue, NO subtitle. Four micro-sequences, each ~3.5s, hard cuts on a beat: " +
      "(a) MACRO INSERT — a deeply impressed felid paw print in wet brown clay, no claw marks visible (the diagnostic trait), a brief gloved hand enters frame with a small wooden scale stick for comparison then exits. Ambient: post-rain dripping. " +
      "(b) MACRO INSERT — a tuft of tawny puma fur snagged on the thorn of a blackthorn branch, swaying very slightly in cold wind. Ambient: hawthorn wind. " +
      "(c) WIDE-ENOUGH INSERT — a partially-eaten roe deer carcass on woodland edge, ribs exposed in a clean circular feed pattern, several rooks startle and hop back. Ambient: rook caw, fly buzz. " +
      "(d) MACRO INSERT — wisps of soft white rabbit underfur scattered on a wet flagstone path. Ambient: distant farm dog. " +
      "Cold, almost forensic observation; soft diffused overcast English daylight throughout. No music."
  },
  {
    title: "4 · 暮河垂钓·树梢一瞥",
    durationSec: 15,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    sketchCount: 2,
    sketchPrompt:
      "BBC nature documentary still, vertical 9:16. Late golden-hour at a quiet bend of an English river. Foreground: a middle-aged businessman in a deep-brown felt fedora and camel windbreaker sits on a folding stool fishing, line catching the orange last light on dark water. He glances slowly across the river. Across the water on a low thick branch of a solitary backlit oak: a crouched feline silhouette, motionless, tail tip flicking. Long lens, shallow depth of field. Naturalistic light. No text, no people other than the angler.",
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 4 of 6, 15s, vertical 9:16. Dusk sighting at a quiet river bend. " +
      "0-5s: medium two-shot of a middle-aged businessman in a deep-brown felt fedora and camel windbreaker, seated on a low folding stool, fishing alone. He sips from a thermos cap; the rod tip flexes lazily; orange last-light reflects on dark slow water. Ambient: water lap, far sheep, kettle-thermos clink. " +
      "5-10s: he slowly raises his eyes toward the far bank. Long-lens slow push across the river to a solitary backlit oak — on a low thick branch, in golden-hour silhouette, a crouched feline form (puma) lies motionless, only the tail tip flicking once. " +
      "10-15s: back to a tight close-up of the angler's face; he does not lower the cup; throat moves once; he does not call out. The light slowly drains. NO music, NO subtitle, NO title card."
  },
  {
    title: "5 · 专家夜巡·一双反光眼",
    durationSec: 15,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    sketchCount: 2,
    sketchPrompt:
      "BBC nature documentary still, vertical 9:16. Rainy mid-night in English farmland. A middle-aged man in an olive-green rubber rain mac with the hood up, canvas messenger bag across his shoulder, holds a large yellow torch. The torch beam cuts through rain across a waist-high wet grass meadow toward a collapsed drystone wall. Far at the end of the beam, low to the ground, a pair of feline eye-shines glow green-gold for an instant. Naturalistic torch-only lighting against deep cold-blue night, fine grain. No text.",
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 5 of 6, 15s, vertical 9:16. Rainy night patrol. " +
      "0-6s: handheld shoulder-rig from behind a middle-aged man in an olive-green rubber rain mac with the hood up, canvas messenger bag across his shoulder. He walks carefully along a wet farm track, a large yellow torch in his right hand. The torch beam cuts through fine rain; we see his breath fog. Ambient: rain on rubber, distant thunder, gravel under boots. " +
      "6-12s: the torch beam sweeps across waist-high wet grass, a collapsed drystone wall, several pressed cat-family paw prints in the mud — pauses. " +
      "12-15s: at the far end of the torch beam, low to the ground in the grass, a pair of feline eye-shines glow green-gold for slightly under two seconds, then wink out as the animal silently turns. The man half-raises his free hand, freezes. Rain continues. NO music."
  },
  {
    title: "6 · 雨夜乡间·身影翻墙",
    durationSec: 15,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    sketchCount: 1,
    sketchPrompt:
      "BBC nature documentary final still, vertical 9:16. Deep rainy night on a narrow English country lane. A single overhead sodium street lamp casts a small amber pool of light on wet tarmac; on the far side of the road runs a long drystone wall with a dark wood beyond. A tawny puma silhouette is in mid-leap over the top of the wall, partial body visible at the very far end of frame, low and silent. Empty middle ground. Rain visible against the lamp glow. Naturalistic light only, deep cold blue around the warm lamp pool. No text.",
    rawPrompt:
      `${STYLE_PREFIX}\n` +
      "Shot 6 of 6, 15s, vertical 9:16. Closing tableau — it is still out there. Locked-off medium-long tripod shot throughout, NO camera move. " +
      "0-6s: a narrow English country lane at deep rainy night. A single overhead sodium street lamp casts a small amber pool of light on wet tarmac; on the far side of the road runs a long drystone wall with a dark wood beyond. Empty middle ground. Rain visible in the lamp glow. Ambient: steady rain on stone, distant thunder, faint far-off farm dog. Hold the empty composition. " +
      "6-10s: at the very far end of frame, low and silent, a tawny puma silhouette lifts onto the top of the drystone wall and pours over it in one continuous low arc, vanishing into the dark wood. The camera does NOT pan, NOT push, NOT cut closer. " +
      "10-15s: the lane returns to empty. Water in the lane's puddles still rippling slightly. Rain very gradually softens. Image slowly darkens to near-black; the last sound is one faint distant dog bark. NO title card, NO end text, NO date overlay, NO music, NO subtitle anywhere."
  }
];

async function findSession() {
  const state = await jfetch("GET", "/api/state");
  const existing = state.sessions.find((s) => s.title === TITLE);
  if (existing) {
    const shots = state.shots.filter((s) => s.sessionId === existing.id).sort((a, b) => a.index - b.index);
    log(`reusing session ${existing.id} (${TITLE}) with ${shots.length} shots`);
    return { ...existing, shots };
  }
  return undefined;
}

async function ensureSession() {
  const existing = await findSession();
  if (existing) return existing;
  log(`creating session ${TITLE}...`);
  const session = await jfetch("POST", "/api/sessions", {
    title: TITLE, logline: LOGLINE, style: STYLE, targetDurationSec: 90, shotCount: 6
  });
  log(`session ${session.id} created with ${session.shots.length} shots`);
  return session;
}

async function patchScript(session) {
  log("patching session.story (script panel)...");
  await jfetch("PATCH", `/api/sessions/${session.id}/script`, { story: STORY });
}

async function patchShots(session) {
  log(`patching ${session.shots.length} shots (rawPrompt / 15s / continuity / status=scripted)...`);
  const result = [];
  for (let i = 0; i < session.shots.length; i += 1) {
    const shot = session.shots[i];
    const tpl = SHOT_TEMPLATES[i];
    if (!tpl) continue;
    const patch = {
      title: tpl.title,
      durationSec: tpl.durationSec,
      seedanceVariant: "standard",
      usePreviousShotClip: tpl.usePreviousShotClip,
      previousShotClipSec: tpl.previousShotClipSec || 2,
      rawPrompt: tpl.rawPrompt,
      prompt: "",
      // We intentionally leave assetIds untouched here; sketch generation will append shot-scoped
      // sketch ids onto assetIds afterwards via POST /sketches.
      status: "scripted"
    };
    log(`  shot ${i + 1}: ${tpl.title}  (continuity=${tpl.usePreviousShotClip}, planned sketches=${tpl.sketchCount})`);
    const updated = await jfetch("PATCH", `/api/shots/${shot.id}`, patch);
    result.push(updated);
    await sleep(50);
  }
  return result;
}

async function generateSketchesForShot(shot, tpl) {
  const existing = (shot.assetIds || []).length;
  if (existing >= tpl.sketchCount) {
    log(`  shot ${shot.index} already has ${existing} attached asset(s), skip sketch gen`);
    return;
  }
  const need = tpl.sketchCount - existing;
  log(`  shot ${shot.index} (${tpl.title}): generating ${need} sketch(es) via Seedream-4...`);
  const start = Date.now();
  const { sketches } = await jfetch("POST", `/api/shots/${shot.id}/sketches`, {
    prompt: tpl.sketchPrompt,
    count: need,
    model: "seedream-4",
    name: `S${shot.index} ${tpl.title.replace(/^\d+\s·\s/, "")} 草图`
  });
  const ms = Date.now() - start;
  log(`    ok, ${sketches.length} sketch(es) added in ${(ms / 1000).toFixed(1)}s`);
}

async function generateAllSketches(session) {
  log(`generating per-shot sketches (private to each shot, cascaded on shot delete)...`);
  const state = await jfetch("GET", "/api/state");
  const refreshed = state.shots.filter((s) => s.sessionId === session.id).sort((a, b) => a.index - b.index);
  for (let i = 0; i < refreshed.length; i += 1) {
    const shot = refreshed[i];
    const tpl = SHOT_TEMPLATES[i];
    if (!tpl || !tpl.sketchCount) continue;
    try {
      await generateSketchesForShot(shot, tpl);
    } catch (err) {
      // Don't abort the whole setup just because one sketch failed — the user can re-trigger
      // single sketches from the web UI's "再画一张" button.
      errlog(`    sketch gen failed for shot ${shot.index}: ${err.message}`);
    }
  }
}

async function main() {
  log(`base=${BASE}`);
  // 1. health check
  await jfetch("GET", "/api/state");

  // 2. ensure session + script + shots
  const session = await ensureSession();
  await patchScript(session);
  await patchShots(session);

  // 3. generate per-shot sketches
  await generateAllSketches(session);

  // 4. final summary
  const finalState = await jfetch("GET", "/api/state");
  const finalSession = finalState.sessions.find((s) => s.id === session.id);
  const finalShots = finalState.shots
    .filter((s) => s.sessionId === session.id)
    .sort((a, b) => a.index - b.index);
  const sketchTotal = finalState.assets.filter(
    (a) => a.ownerShotId && finalShots.some((s) => s.id === a.ownerShotId)
  ).length;

  log("=========================================");
  log(`SETUP DONE.`);
  log(`Web: ${BASE}  → 「${TITLE}」`);
  log(`Session id: ${finalSession.id}`);
  log(`Shots: ${finalShots.length} × ${finalShots[0]?.durationSec || "?"}s = ${finalShots.reduce((s, x) => s + (x.durationSec || 0), 0)}s`);
  log(`Per-shot sketches generated: ${sketchTotal}`);
  log(`No Seedance video generation has been triggered.`);
  log(`Please review storyboard + sketches in the web UI. When satisfied, run the runner script`);
  log(`(to be added) to produce the final mp4.`);
  log("=========================================");
}

main().catch((err) => {
  errlog(`FATAL: ${err.message}`);
  process.exit(1);
});
