#!/usr/bin/env node
// End-to-end driver for the short film 《阿美莉卡使节进宫》(60s vertical 9:16, 5 shots).
//
// Steps:
//   1. Reuse or create the session 阿美莉卡使节进宫 (60s, 5 shots).
//   2. Resolve characters @溥仪 / @黄仁勋 from the asset library (assumed already public).
//   3. PATCH session.story so the script panel in the web UI shows the full beat sheet.
//   4. PATCH each shot with rawPrompt / durationSec=12 / assetIds; turn on
//      usePreviousShotClip=true (2s) for shots 2..5 for continuity.
//   5. Serially generate each shot (continuity requires order) and poll until ready.
//   6. Stitch the session and copy the final mp4 into ~/Downloads.

import { setTimeout as sleep } from "node:timers/promises";
import { writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = process.env.CINEMA_BASE_URL || "http://127.0.0.1:5173";
const TITLE = "阿美莉卡使节进宫";
const LOG_PREFIX = "[amellica]";

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
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${method} ${url} -> ${res.status}: ${detail}`);
  }
  return data;
}

const LOGLINE =
  "2026 年故宫影视拍摄现场，溥仪入戏扮皇上，黄仁勋扮阿美莉卡使节带着一箱发光显卡进宫通商。" +
  "皇权语言（朝贡/腰牌/国库/宫墙）与硅谷商业话术（显卡/生态/CUDA/AI 工厂）一路错位互译，喜剧落幕在一杯蜜雪冰城上。";

const STYLE =
  "vertical 9:16 short-drama format, 轻喜剧 + 商业混搭, 古装剧片场质感叠加现代摄影灯/直播补光, " +
  "故宫红墙金瓦 × 硅谷发布会舞台美学, 绿色 GPU 全息光效, 短视频节奏, 电影质感, 4K 写实, 自然口语对白";

const STORY = {
  premise:
    "2026 年故宫影视拍摄现场，溥仪入戏扮清宫皇上，黄仁勋扮阿美莉卡使节献上一箱发光显卡，" +
    "两套语言系统互相错位翻译，最后合同没签成，使节却被一杯蜜雪冰城蜜桃四季春征服。",
  synopsis:
    "2026 年，剧组在故宫拍清宫戏《阿美莉卡使节进宫》。场记板一打，溥仪入戏扮皇上接见使节；" +
    "黄仁勋穿外国使节礼服外搭经典黑皮衣，自称从『阿美莉卡』远渡重洋而来，开箱不是金银而是一排发光的 GPU。" +
    "皇上听不懂『显卡』，以为是显摆身份的腰牌；听到『AI 工厂』『地基』，则联想到紫禁城后来变景点。" +
    "进入军机处议价环节，使节大谈 CUDA、生态、开发者网络，皇上以宫墙护城河的方式去理解：『宫墙关人，生态留人。』" +
    "合同因『国库不允』流产，皇上赏使节一杯蜜雪冰城蜜桃四季春，使节一饮大悦，决定不回阿美莉卡了。" +
    "结尾皇上对着镜头总结：这才叫真正的开放生态。整部短片用皇权语言 vs 硅谷话术的错位翻译制造喜剧。",
  theme: "古今错位、商业话术的去神秘化、文化反 soft-power 段子",
  tone: "轻喜剧 / 段子节奏 / 反差萌 / 电影质感",
  characters: [
    {
      name: "戏中皇上 / 溥仪",
      role: "主角·皇上",
      arc: "从威严接见 → 困惑听商 → 看穿生态 → 反向输出开放生态",
      assetMention: "@溥仪"
    },
    {
      name: "戏中阿美莉卡使节 / 黄仁勋",
      role: "主角·使节",
      arc: "从产品发布会式高调推销 → 被『国库不允』拒绝 → 一杯蜜桃四季春就投降",
      assetMention: "@黄仁勋"
    }
  ],
  beats: [
    {
      index: 1,
      title: "午门递国书",
      purpose: "建立 2026 年故宫拍摄现场设定，引出两位主角",
      plot:
        "2026 故宫影视拍摄现场，场记板一打，@溥仪 入戏成皇上。@黄仁勋 穿外国使节礼服外搭经典黑皮衣，手捧『阿美莉卡通商国书』。",
      emotion: "庄重 + 古今错位的喜感",
      visual: "古装剧组、场记板、红墙金瓦、现代摄影灯混杂",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    },
    {
      index: 2,
      title: "太和殿开箱卖显卡",
      purpose: "卡梗第一击：显卡 vs 腰牌，机器替天下人作画/写文/炼丹",
      plot:
        "@黄仁勋 打开科技箱，露出一排发光显卡；@溥仪 第一次听『显卡』，把它当成显摆身份的腰牌或玉器。",
      emotion: "好奇 + 推销",
      visual: "太和殿龙椅御案 × 绿色发光 GPU × AI 全息小特效",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    },
    {
      index: 3,
      title: "养心殿谈价格",
      purpose: "卡梗第二击：『买得越多省得越多』vs『花得越多还叫省』、AI 工厂 vs 紫禁城景点",
      plot:
        "@黄仁勋 像产品发布会一样报价；@溥仪 拿算盘拨珠，紫禁城中轴线短暂变成数据中心机柜通道，龙纹与电路纹融合。",
      emotion: "商务谈判感 + 文化反讽",
      visual: "御案上奏折/算盘/玉玺/发光显卡同框，宫殿建筑↔数据中心融合",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    },
    {
      index: 4,
      title: "军机处争 CUDA",
      purpose: "卡梗第三击：CUDA 生态 → 宫墙护城河",
      plot:
        "群臣围观显卡，@溥仪 问『天下显卡，难道只你一家？』@黄仁勋 抬手浮现 CUDA / 开发者 / AI 模型全息图；故宫护城河转化为发光科技护城河，程序员剪影像朝贡队伍涌进宫门。",
      emotion: "顿悟",
      visual: "古代议事房 + 现代屏幕 + 绿色全息生态",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    },
    {
      index: 5,
      title: "合同没签成，赏茶收尾",
      purpose: "反转 + 短视频爆梗 + 主题字幕",
      plot:
        "@溥仪 以『国库不允』拒签，赏 @黄仁勋 一杯蜜雪冰城蜜桃四季春，使节大悦，对镜头表态『此间乐，不思美』，皇上看镜头：『这才叫真正的开放生态。』",
      emotion: "反差萌 + 收束",
      visual: "神武门黄昏、合同合上、太监工作人员端饮品、GPU 光效 + 桃花特效定格",
      assetMentions: ["@溥仪", "@黄仁勋"],
      durationSec: 12
    }
  ],
  locked: true
};

const SHOT_TEMPLATES = [
  {
    title: "1 · 午门递国书",
    durationSec: 12,
    usePreviousShotClip: false,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      "@溥仪 作为皇上角色参考，@黄仁勋 作为外国使节角色参考。竖屏 9:16，2026 年故宫午门影视拍摄现场，古装剧组、" +
      "场记板、红墙金瓦、现代摄影灯混在一起。0-4 秒：场记板『阿美莉卡使节进宫 / 镜 1 / Take 1』打响，画面从现代剧组瞬间切入清宫戏质感；" +
      "4-8 秒：@溥仪 角色坐在临时龙椅上入戏成皇上，明黄龙袍冕旒，神情庄重，对白（中文字幕浮现）：『通商？你带了什么贡品？』；" +
      "8-12 秒：@黄仁勋 角色穿外国使节礼服外搭经典黑皮衣，双手捧上『阿美莉卡通商国书』竖卷，身后随从抬着黑色科技箱，回答（字幕）：" +
      "『外臣来自阿美莉卡，特来通商。不是贡品，是商品。』轻喜剧节奏，电影质感，自然环境音 + 古风轻 BGM。"
  },
  {
    title: "2 · 太和殿开箱卖显卡",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      "@溥仪 作为皇上角色参考，@黄仁勋 作为外国使节角色参考。承接上一镜：场景切到太和殿内，龙椅、御案、金色梁柱。" +
      "0-4 秒：@黄仁勋 角色打开黑色科技箱，箱中一排绿色发光显卡升起，伴随产品发布会式蓝绿冷光；" +
      "4-8 秒：@溥仪 角色身体前倾，把显卡当成古代腰牌或玉器，皱眉端详，字幕：『显卡？是显摆身份的腰牌？』；" +
      "8-12 秒：显卡周围浮现 AI 作画/写字/炼丹炉般的奇幻小全息特效，@黄仁勋 解释（字幕）：" +
      "『插上它，机器就能替天下人作画、写文、炼丹。』@溥仪 立刻接梗（字幕）：『炼丹？那你该去太医院。』" +
      "古代宫殿与现代 GPU 科技融合。运镜：开箱大特写 → 双人中景，幽默但高级。"
  },
  {
    title: "3 · 养心殿谈价格",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      "@溥仪 作为皇上角色参考，@黄仁勋 作为外国使节角色参考。承接上一镜：场景切到养心殿，御案上摆着奏折、算盘、玉玺、发光显卡同框。" +
      "0-4 秒：@黄仁勋 角色像产品发布会一样展示显卡，背后浮起绿色 AI 工厂全息图，字幕：『皇上，买得越多，省得越多。』；" +
      "4-8 秒：@溥仪 角色拿起算盘认真拨珠，表情从威严变成困惑，字幕：『朕第一次听说，花得越多还叫省。』" +
      "@黄仁勋 接话（字幕）：『这不是显卡，这是 AI 工厂的地基。』；" +
      "8-12 秒：紫禁城中轴线短暂变成数据中心机柜通道，龙纹与电路纹融合，@溥仪 看着窗外淡淡道（字幕）：" +
      "『朕以前也有地基，叫紫禁城，后来成景点了。』运镜：横移跟拍 + 桌面物品特写，轻喜剧商务谈判感。"
  },
  {
    title: "4 · 军机处争 CUDA",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      "@溥仪 作为皇上角色参考，@黄仁勋 作为外国使节角色参考。承接上一镜：场景切到军机处风格议事房，古代大臣剪影围绕御案，现代屏幕与奏折并存。" +
      "0-4 秒：@溥仪 角色指着显卡发问（字幕）：『天下显卡，难道只你一家？』镜头低角度表现皇上威严；" +
      "4-8 秒：@黄仁勋 角色抬手，空中浮现 CUDA、开发者网络、AI 模型、芯片生态的绿色全息图，字幕：" +
      "『显卡易得，生态难修。CUDA 一开，万国程序员皆来朝。』；" +
      "8-12 秒：故宫护城河视觉转化为发光科技护城河，程序员剪影像朝贡队伍一样进入宫门，@溥仪 点头悟道（字幕）：" +
      "『朕懂了，宫墙关人，生态留人。』@黄仁勋 拱手（字幕）：『皇上圣明。』运镜：环绕镜头 + 全息特效，古代朝会与现代商业生态隐喻结合。"
  },
  {
    title: "5 · 合同没签成，赏茶收尾",
    durationSec: 12,
    usePreviousShotClip: true,
    previousShotClipSec: 2,
    assetNames: ["溥仪", "黄仁勋"],
    rawPrompt:
      "@溥仪 作为皇上角色参考，@黄仁勋 作为外国使节角色参考。承接上一镜：场景切到神武门外黄昏收尾，古装剧组灯光、红墙、宫门与现代外卖饮品形成喜剧反差。" +
      "0-4 秒：御案上的合同缓缓合上，@溥仪 角色摆手表示不签，字幕：『此物甚贵，国库不允，合同先不签了。』" +
      "@黄仁勋 角色微微鞠躬略显失落，字幕：『外臣远渡重洋，竟空手而归？』；" +
      "4-8 秒：太监风格工作人员双手端上一杯现代蜜桃四季春饮品（红白杯身做成短视频道具感，不强调商标细节），@溥仪 字幕：" +
      "『来人，赏阿美莉卡使节蜜桃四季春。』；" +
      "8-12 秒：@黄仁勋 喝一口眼睛发亮，背景绽放绿色 GPU 光效 + 粉色桃花飘落特效，字幕：『此间乐，不思美。』" +
      "镜头切到 @溥仪 微笑看镜头，字幕：『这才叫真正的开放生态。』" +
      "结尾叠加大字幕收尾：『合同没签成。/ 但阿美莉卡使节，找到了新的护城河。』轻快短视频 BGM 收束。"
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
    title: TITLE,
    logline: LOGLINE,
    style: STYLE,
    targetDurationSec: 60,
    shotCount: 5
  });
  log(`session ${session.id} created with ${session.shots.length} shots`);
  return session;
}

function findAsset(state, name) {
  return state.assets.find((a) => a.name === name);
}

async function patchScript(session) {
  log("patching session.story (script panel)...");
  await jfetch("PATCH", `/api/sessions/${session.id}/script`, { story: STORY });
}

async function patchShots(session, characters) {
  log("patching 5 shots (rawPrompt / 12s / assetIds / continuity flags)...");
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
    log(`  shot ${i + 1}: ${tpl.title}`);
    const updated = await jfetch("PATCH", `/api/shots/${shot.id}`, patch);
    result.push(updated);
  }
  return result;
}

async function pollUntilReady(shotId) {
  const deadline = Date.now() + 18 * 60 * 1000;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const shot = await jfetch("POST", `/api/shots/${shotId}/poll`, {});
    if (shot.status !== lastStatus) {
      log(`    [poll] status=${shot.status}${shot.error ? ` error=${shot.error}` : ""}`);
      lastStatus = shot.status;
    }
    if (shot.status === "ready" && shot.videoUrl) return shot;
    if (shot.status === "error") {
      throw new Error(`Shot ${shotId} failed: ${shot.error || "unknown"}`);
    }
    await sleep(8000);
  }
  throw new Error(`Shot ${shotId} timed out after 18min`);
}

async function generateSerial(shots) {
  log("generating each shot serially (continuity)...");
  const finals = [];
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    if (shot.status === "ready" && shot.videoUrl) {
      log(`>>> shot ${i + 1}/${shots.length}: ${shot.title}  (already ready, skip)`);
      finals.push(shot);
      continue;
    }
    log(`>>> shot ${i + 1}/${shots.length}: ${shot.title}`);
    const launched = await jfetch("POST", `/api/shots/${shot.id}/generate`, {
      rawPrompt: shot.rawPrompt,
      prompt: shot.rawPrompt,
      seedanceVariant: shot.seedanceVariant,
      usePreviousShotClip: shot.usePreviousShotClip,
      previousShotClipSec: shot.previousShotClipSec,
      assetIds: shot.assetIds,
      durationSec: shot.durationSec
    });
    log(`    submitted, status=${launched.status}, task=${launched.generationTaskId || "-"}`);
    const ready = await pollUntilReady(shot.id);
    log(`    DONE: videoUrl=${ready.videoUrl}`);
    finals.push(ready);
  }
  return finals;
}

async function stitchSession(sessionId) {
  log("stitching final video...");
  const session = await jfetch("POST", `/api/sessions/${sessionId}/stitch`);
  log(`final video URL: ${session.finalVideoUrl}`);
  return session;
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
  const session = await ensureSession();
  const state = await jfetch("GET", "/api/state");
  const puyi = findAsset(state, "溥仪");
  const huang = findAsset(state, "黄仁勋");
  if (!puyi || !huang) throw new Error("缺少 @溥仪 或 @黄仁勋 资产，请先在资产库注册并 seedream 生成公网图");
  log(`assets: @溥仪 ${puyi.id} / @黄仁勋 ${huang.id}`);
  await patchScript(session);
  const shots = await patchShots(session, [puyi, huang]);
  await generateSerial(shots);
  const stitched = await stitchSession(session.id);
  const target = await deliver(stitched);
  log(`ALL DONE -> ${target}`);
}

main().catch((err) => {
  errlog(`FATAL: ${err.message}`);
  process.exit(1);
});
