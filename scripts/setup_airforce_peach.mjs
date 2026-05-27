#!/usr/bin/env node
// Setup script for 《空军一号蜜桃突入》.
//
// It creates/reuses a 6-shot, 60s vertical action-comedy session and writes the
// story panel + per-shot Seedance prompts. It does not generate images or videos.

const BASE = process.env.CINEMA_BASE_URL || "http://127.0.0.1:5174";
const TITLE = "空军一号蜜桃突入";
const LOG_PREFIX = "[airforce-peach]";

const log = (...args) => console.log(LOG_PREFIX, ...args);

async function jfetch(method, url, body) {
  const response = await fetch(`${BASE}${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${method} ${url} -> ${response.status}: ${detail}`);
  }
  return data;
}

const STYLE = [
  "vertical 9:16 cinematic action-comedy short",
  "fictional satirical movie scene, not a real event",
  "near-photoreal public-figure likeness, but presented as stylized movie characters",
  "John Woo inspired action-opera grammar: strong backlight, slow motion, wind-blown clothes, elegant blocking, warm cabin light, dramatic lens flares",
  "Jackie Chan style physical comedy and practical stunt rhythm for Jensen Huang: agile, inventive, dangerous but playful",
  "no guns, no blood, no gore, no on-screen subtitles, no watermarks, no title cards, no logos or readable brand marks",
  "Seedance should generate clean cinematic plates; dialogue and captions will be handled outside the image"
].join("; ");

const STORY = {
  premise:
    "特朗普和马斯克登上空军一号风格总统专机，准备前往亚洲谈生意。飞机起飞时，黄仁勋驾驶迈巴赫冲进跑道，成龙式爬上车顶并抓住起落架，沿机腹摸进舱门，优雅地跳入机舱。紧张瞬间被一杯蜜桃四季春化解，三人哈哈大笑。",
  synopsis:
    "动作电影式开场：总统专机停在夕阳跑道，特朗普与马斯克在安保簇拥下登机，谈论亚洲生意。" +
    "飞机滑跑起飞时，黑色迈巴赫从远端高速追来，黄仁勋在车内稳住方向盘，随后打开天窗爬上车顶。" +
    "他借车顶冲刺，抓住刚离地飞机的起落架轮胎，黑皮衣在狂风中翻飞。" +
    "黄仁勋沿机腹攀到舱门控制区，成龙式险险避过气流，打开外舱门翻身入内。" +
    "机舱里特朗普和马斯克被吓得站起，黄仁勋却整理衣领，礼貌问好。" +
    "他转头问空姐能否来一杯蜜雪冰城蜜桃四季春，尴尬瞬间化解，特朗普让他入座，三人一起大笑。",
  theme: "商务巨头的荒诞会面、动作片礼仪、危险特技和冷幽默反差",
  tone: "电影级动作喜剧、吴宇森式动作歌剧、成龙式身体喜剧、短视频强节奏",
  characters: [
    {
      name: "特朗普",
      role: "美国前总统式公众人物，西装、金发、夸张但不恶意的商务喜剧形象",
      arc: "准备出发谈生意 → 被突入吓到 → 被礼貌和饮品化解 → 让黄仁勋入座"
    },
    {
      name: "马斯克",
      role: "科技企业家式公众人物，深色夹克，机舱里冷幽默观察者",
      arc: "随行谈生意 → 惊讶看着舱门突入 → 和特朗普一起放松大笑"
    },
    {
      name: "黄仁勋",
      role: "黑皮衣银发 AI 芯片 CEO 式公众人物，礼貌、敏捷、成龙式动作明星",
      assetMention: "@黄仁勋",
      arc: "开迈巴赫追机 → 车顶起跳 → 攀上起落架 → 入舱仍保持礼仪 → 点蜜桃四季春"
    }
  ],
  beats: [
    {
      index: 1,
      title: "登机出发",
      purpose: "建立动作大片商务出行开场",
      plot: "夕阳机场跑道，空军一号风格白蓝总统专机待命。特朗普和马斯克登上飞机，准备前往亚洲谈生意。",
      emotion: "庄重、昂贵、略带喜剧夸张",
      visual: "长焦低机位、飞机舷梯、保镖剪影、夕阳逆光、商务大片开场",
      assetMentions: [],
      durationSec: 10
    },
    {
      index: 2,
      title: "迈巴赫追机",
      purpose: "黄仁勋登场，动作危机启动",
      plot: "黄仁勋驾驶黑色迈巴赫冲进跑道，车身漂移追向正在滑跑的总统专机。",
      emotion: "惊险、潇洒、荒诞",
      visual: "跑道低角度跟拍、轮胎烟、飞机发动机热浪、黑皮衣驾驶员特写",
      assetMentions: ["@黄仁勋"],
      durationSec: 10
    },
    {
      index: 3,
      title: "车顶起跳",
      purpose: "成龙式身体喜剧和实拍特技高潮",
      plot: "黄仁勋从车内爬上车顶，在狂风里保持平衡，纵身抓住刚离地飞机的起落架轮胎。",
      emotion: "危险但好笑，灵活到不可思议",
      visual: "慢动作、风吹黑皮衣、迈巴赫车顶、起落架轮胎、跑道极速后退",
      assetMentions: ["@黄仁勋"],
      durationSec: 10
    },
    {
      index: 4,
      title: "贴机潜入",
      purpose: "吴宇森式动作歌剧，把荒诞动作拍得优雅",
      plot: "黄仁勋挂在机腹，沿轮架摸到舱门控制位置，打开外舱门并翻身跳进飞机。",
      emotion: "紧张、华丽、干净利落",
      visual: "强逆光、机腹金属、云层、慢动作衣摆、无血无枪的空中特技",
      assetMentions: ["@黄仁勋"],
      durationSec: 10
    },
    {
      index: 5,
      title: "机舱惊吓",
      purpose: "动作落到喜剧反差",
      plot: "舱门打开，黄仁勋跳进机舱。特朗普和马斯克吓了一跳，黄仁勋整理衣领，保持礼仪向二位问好。",
      emotion: "惊吓转尴尬，礼貌制造笑点",
      visual: "豪华机舱暖光、两位商务人物站起、黄仁勋从舱门落地后优雅整理衣领",
      assetMentions: ["@黄仁勋"],
      durationSec: 10
    },
    {
      index: 6,
      title: "蜜桃四季春",
      purpose: "用饮品化解尴尬，完成短视频笑点",
      plot: "黄仁勋问空姐能否来一杯蜜雪冰城蜜桃四季春。特朗普让他入座，马斯克忍不住笑，三人一起哈哈大笑。",
      emotion: "尴尬解除、轻松、荒诞社交成功",
      visual: "机舱圆桌、透明桃色饮品道具、不强调商标、暖光笑场、动作片后的喜剧收尾",
      assetMentions: ["@黄仁勋"],
      durationSec: 10
    }
  ],
  locked: true
};

const SHOTS = [
  {
    title: "1 · 登机出发",
    durationSec: 10,
    usePreviousShotClip: false,
    prompt:
      `${STYLE}\nShot 1/6, 10 seconds. A fictional action-comedy movie opening on an airport runway at golden hour. A white-and-blue presidential jet inspired by Air Force One waits with mobile stairs attached. A near-photoreal Trump-like businessman in a dark suit and red tie and a near-photoreal Elon Musk-like tech billionaire in a dark jacket walk up the stairs, preparing to fly to Asia for a business negotiation. Security silhouettes and warm lens flare, low-angle long-lens composition, expensive political-business thriller mood with subtle satire. No text, no subtitles, no readable logos.`
  },
  {
    title: "2 · 迈巴赫追机",
    durationSec: 10,
    usePreviousShotClip: true,
    prompt:
      `${STYLE}\nShot 2/6, 10 seconds. Continue from the runway departure. The presidential jet begins taxiing and accelerating. From the far end of the runway, a glossy black Maybach-style luxury sedan drifts into frame, tires smoking. Inside is @黄仁勋, a near-photoreal silver-haired tech CEO in a black leather jacket, focused but polite, gripping the wheel. Camera is low and fast beside the car, engine heat shimmer from the jet, sunset backlight, practical stunt energy. No text, no readable logos.`
  },
  {
    title: "3 · 车顶起跳",
    durationSec: 10,
    usePreviousShotClip: true,
    prompt:
      `${STYLE}\nShot 3/6, 10 seconds. @黄仁勋 climbs out through the sedan sunroof onto the roof while the car races beside the lifting jet. Jackie Chan style practical stunt: he wobbles, regains balance with a charming polite expression, runs two steps on the roof, then leaps in slow motion toward the landing gear. His black leather jacket whips in the wind, the landing gear wheel fills the frame, runway streaks below. Dangerous but playful, no gore, no weapons, no text.`
  },
  {
    title: "4 · 贴机潜入",
    durationSec: 10,
    usePreviousShotClip: true,
    prompt:
      `${STYLE}\nShot 4/6, 10 seconds. @黄仁勋 hangs from the newly airborne jet's landing gear, then climbs along the underside of the aircraft toward an exterior service door. John Woo action-opera lighting: blinding backlight, clouds, metal belly of the plane, wind blasting his jacket, elegant slow-motion beats. He reaches the door control, opens the outer hatch, and flips inside with clean acrobatic timing. No guns, no violence, no text, no logos.`
  },
  {
    title: "5 · 机舱惊吓",
    durationSec: 10,
    usePreviousShotClip: true,
    prompt:
      `${STYLE}\nShot 5/6, 10 seconds. Interior of a luxurious presidential jet cabin, warm amber light, polished wood and cream leather. The side hatch opens and @黄仁勋 lands inside, then calmly straightens his black leather jacket and gives a polite greeting. A Trump-like businessman and an Elon Musk-like tech billionaire jump back in surprise, then freeze in awkward silence. Physical comedy timing, clean cinematic cabin blocking, no subtitles, no readable text.`
  },
  {
    title: "6 · 蜜桃四季春",
    durationSec: 10,
    usePreviousShotClip: true,
    prompt:
      `${STYLE}\nShot 6/6, 10 seconds. The awkward cabin tension dissolves. @黄仁勋 politely asks the flight attendant for a peach oolong tea drink, shown only as a clear plastic cup with peach-colored tea and ice, no readable brand or logo. The Trump-like businessman gestures for him to sit; the Musk-like tech billionaire starts laughing; all three sit around the cabin table and laugh together. Warm cabin light, action-comedy ending, no text, no subtitles, no logos.`
  }
];

function stripShots(session) {
  const { shots, ...rest } = session;
  return rest;
}

async function main() {
  const state = await jfetch("GET", "/api/state");
  let session = state.sessions.find((item) => item.title === TITLE);
  if (!session) {
    session = await jfetch("POST", "/api/sessions", {
      title: TITLE,
      logline: STORY.premise,
      style: STYLE,
      targetDurationSec: 60,
      shotCount: 6
    });
  } else {
    session = await jfetch("GET", "/api/state").then((next) => ({
      ...session,
      shots: next.shots.filter((shot) => shot.sessionId === session.id).sort((a, b) => a.index - b.index)
    }));
  }

  if ((session.shots || []).length !== 6) {
    throw new Error(`Session ${TITLE} has ${(session.shots || []).length} shots; expected 6`);
  }

  await jfetch("PATCH", `/api/sessions/${session.id}`, {
    logline: STORY.premise,
    style: STYLE,
    story: STORY
  });

  const latest = await jfetch("GET", "/api/state");
  const huang = latest.assets.find((asset) => asset.name === "黄仁勋");
  const shots = latest.shots.filter((shot) => shot.sessionId === session.id).sort((a, b) => a.index - b.index);
  for (const [index, shot] of shots.entries()) {
    const planned = SHOTS[index];
    const assetIds = huang && planned.prompt.includes("@黄仁勋") ? [huang.id] : [];
    await jfetch("PATCH", `/api/shots/${shot.id}`, {
      title: planned.title,
      durationSec: planned.durationSec,
      rawPrompt: planned.prompt,
      prompt: planned.prompt,
      camera: "Vertical 9:16 cinematic action-comedy, John Woo backlight + Jackie Chan practical stunt rhythm.",
      script: STORY.beats[index].plot,
      storyBeatIndex: index + 1,
      seedanceVariant: "standard",
      usePreviousShotClip: planned.usePreviousShotClip,
      previousShotClipSecOverride: false,
      firstFrameAssetId: "",
      assetIds,
      status: "scripted"
    });
  }

  const finalState = await jfetch("GET", "/api/state");
  const finalSession = finalState.sessions.find((item) => item.id === session.id);
  log(`ready: ${TITLE} (${session.id})`);
  log(`shots: ${finalState.shots.filter((shot) => shot.sessionId === session.id).length}`);
  log(`open: ${BASE}`);
  return stripShots(finalSession);
}

main().catch((error) => {
  console.error(LOG_PREFIX, error);
  process.exitCode = 1;
});
