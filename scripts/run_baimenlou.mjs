#!/usr/bin/env node
// End-to-end script: build the "白门楼" short film from scratch via the local Cinema Agent HTTP API.
//
// Steps:
//   1. Create session (60s, 4 shots, vertical 9:16 styling)
//   2. Create 4 assets (曹操 / 陈宫 / 白门楼 / 中牟旧梦) and generate reference images via Seedream
//   3. Patch each shot with title / durationSec=15 / rawPrompt mentioning @assets
//      and turn on usePreviousShotClip for shot 2/3/4 to keep continuity
//   4. For each shot in order: plan -> generate -> poll until ready
//   5. Stitch the session into a final mp4
//   6. Print the deliverable path

import { setTimeout as sleep } from "node:timers/promises";
import { writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const BASE = process.env.CINEMA_BASE_URL || "http://127.0.0.1:5173";
const LOG_PREFIX = "[baimenlou]";

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

const STYLE =
  "cinematic late-Han Chinese epic, ink-wash desaturated palette, cold gray-blue present tone, warm amber for memory flashbacks, swirling smoke and sleet, low golden-hour key, 35mm grain, restrained classical drama, painterly composition, vertical 9:16 cinematic framing";

const LOGLINE =
  "建安三年冬，曹操于白门楼擒得故友陈宫。一句反问藏着挽留，一段旧梦埋着决裂；他端着帝王的架子开不了口求他活，刀落雪里，他才在风中微微颤动——这是他第一次为人后悔。";

const ASSETS = [
  {
    name: "曹操",
    type: "character",
    description:
      "三国魏武帝曹操，四十余岁中年男性，汉末枭雄。黑色玄甲覆鳞，外披白色狐裘大氅，发髻一丝不苟，鬓角微霜，颌下短须。眼神威严内敛，眉宇藏忧。右手按佩剑剑柄。青年时期亦清癯英气、无须，眉目锐利。汉末汉族男性面容。"
  },
  {
    name: "陈宫",
    type: "character",
    description:
      "三国汉末名士陈宫，字公台，三十余岁文士。青色文士儒袍，束发玉冠微歪，脸有泥灰但目光清亮坚定。双手被反剪而站姿挺直，文人之傲与赴死之静合一。汉末汉族男性，清癯儒雅。青年时期为中牟县令时玄色官袍，眉目纯净未染风霜。"
  },
  {
    name: "白门楼",
    type: "scene",
    description:
      "东汉末年下邳城白门楼遗存，土夯城墙，残破赤旗在风雪中翻卷，楼下烟尘未散，远处士兵列阵。竖画幅 9:16 仰望构图，雪粒夹雨斜飞，冷灰蓝色调，黄昏低位金光打侧。"
  },
  {
    name: "中牟旧梦",
    type: "scene",
    description:
      "汉末中牟县衙夜景，暖琥珀色钨丝油灯下木格窗轻颤，木枷靠墙，案几上简牍散落；与之并置的是下一夜吕伯奢宅院油灯倒地、柴扉半开的暖暗光影。整体竖画幅 9:16 怀旧暖色，灯花跳动颗粒，与现实场景的冷蓝色调形成对照。"
  }
];

const SHOT_TEMPLATES = [
  {
    title: "1 · 陈宫登楼·曹操不忍",
    durationSec: 15,
    usePreviousShotClip: false,
    assetNames: ["白门楼", "曹操", "陈宫"],
    rawPrompt:
      "竖画幅 9:16。开镜 @白门楼 城楼台基，烟尘未散，残赤旗在风雪中翻卷。镜头缓缓穿过烟雾推进，落在 @曹操 背影——他肩膀几不可察地动了一下，却没回头。@陈宫 被押上楼，束手挺胸，目光平静清明。曹操终于缓缓转身，眼里一闪痛色立刻被收回；他开口，语气端着帝王责备式的反问。中文字幕浮现：『公台，何故弃孤而去？』画面停在两人对峙的中近景两人入画，雪粒在中间穿过。冷灰蓝色调，35mm 胶片质感，肃穆电影感。无音乐对白，仅环境风声。"
  },
  {
    title: "2 · 闪回·友谊历历",
    durationSec: 15,
    usePreviousShotClip: true,
    previousShotClipSec: 3,
    assetNames: ["陈宫", "中牟旧梦", "曹操"],
    rawPrompt:
      "竖画幅 9:16。承接上一镜情绪：@陈宫 脸部大特写，他凝视着对面的曹操，眼神微微下沉。雪花在他眼前飘过，画面叠化进 @中牟旧梦：暖琥珀色油灯下，青年陈宫（younger version of @陈宫，无胡须，更清亮）俯身为木枷中的青年曹操（younger version of @曹操，无须英锐）松开木锁，曹操抬头眼神坚毅。烛火一颤，再次叠化——同一夜更深，油灯被打翻在地，年轻曹操满手沾血站在屋中，年轻陈宫立于门槛脸色铁青。画面再叠化回现在陈宫的脸，雪花重又飘过，他眼角一动，嘴角浮起一丝苦笑。整段以双层叠化承载两段回忆，冷蓝当下↔暖琥珀回忆色温对比清晰。无对白，只有低沉风声与遥远烛灯的余响。"
  },
  {
    title: "3 · 公台何故弃我·临别问家",
    durationSec: 15,
    usePreviousShotClip: true,
    previousShotClipSec: 3,
    assetNames: ["曹操", "陈宫"],
    rawPrompt:
      "竖画幅 9:16。回到当下白门楼之上。@陈宫 微仰首冷笑。中文字幕：『汝心术不正，吾故弃汝。』反打 @曹操，脸上挂不住，喉头滚动；他不愿在众人前低头，咬牙换了个话题。中文字幕：『公台之老母妻子，孤当如何处之？』陈宫微微一震，但仍仰首从容应答。中文字幕：『以孝治天下者不害人之亲，以仁治天下者不绝人之祀。存亡在明公耳。』陈宫说完，向曹操深深一揖。曹操向前半步，张口欲言又止；插入特写：他攥紧剑柄的手，指节发白。冷灰蓝调，肃杀风雪持续。无音乐配乐，仅风声、衣袖声、铁甲细响。"
  },
  {
    title: "4 · 落刀·雪中独留",
    durationSec: 15,
    usePreviousShotClip: true,
    previousShotClipSec: 3,
    assetNames: ["陈宫", "曹操", "白门楼"],
    rawPrompt:
      "竖画幅 9:16。@陈宫 转身从容步向白门楼刑台台阶，背影笔直如松，雪覆其肩。@曹操 背向镜头立于楼台，肩膀微微颤动一下，又被强自压下。远处刀光一闪，无任何打斗音，只有突如其来的肃静。雪势加大，长镜头不切。曹操仍未回头，肩膀再一颤后归于死寂。镜头缓缓推近他的侧脸——一滴泪沿下颌滑落，融入雪。镜头随即缓缓拉远拉高，他独立于空旷台基，雪覆其肩。中文标题字幕浮现：『建安三年冬，白门楼。』画面渐黑。极简电影感收尾，仅留风声与雪落声。"
  }
];

async function ensureSession() {
  // Wipe stale 白门楼 sessions so we start clean each run.
  const state = await jfetch("GET", "/api/state");
  for (const s of state.sessions) {
    if (s.title === "白门楼" || s.title?.startsWith("白门楼")) {
      log(`removing stale session ${s.id} (${s.title})`);
      await jfetch("DELETE", `/api/sessions/${s.id}`);
    }
  }
  log("creating session 白门楼...");
  const session = await jfetch("POST", "/api/sessions", {
    title: "白门楼",
    logline: LOGLINE,
    style: STYLE,
    targetDurationSec: 60,
    shotCount: 4
  });
  log(`session ${session.id} created with ${session.shots.length} shots`);
  return session;
}

async function ensureAssets() {
  log("creating + expanding + generating 4 reference assets...");
  const state = await jfetch("GET", "/api/state");
  const existingByName = new Map(state.assets.map((a) => [a.name, a]));
  const created = [];
  for (const asset of ASSETS) {
    const existing = existingByName.get(asset.name);
    if (existing && (existing.mediaUrl || existing.imageUrl)) {
      log(`  reusing existing asset: ${asset.name} (${existing.id})`);
      created.push(existing);
      continue;
    }
    log(`  upsert asset: ${asset.name} (${asset.type})`);
    const saved = await jfetch("POST", "/api/assets", {
      name: asset.name,
      type: asset.type,
      mediaKind: "image",
      description: asset.description,
      prompt: ""
    });
    created.push(saved);
  }
  // Expand description -> production-ready prompt for newly-created assets only.
  for (const asset of created) {
    if (asset.prompt && asset.prompt.length > 40) continue;
    log(`  expanding prompt for ${asset.name}`);
    try {
      const { prompt } = await jfetch("POST", "/api/assets/expand-prompt", { asset });
      if (prompt) {
        const patched = await jfetch("PATCH", `/api/assets/${asset.id}`, { prompt });
        Object.assign(asset, patched);
      }
    } catch (err) {
      errlog(`    !! expand failed for ${asset.name}: ${err.message}`);
    }
  }
  // Generate reference images for assets that don't yet have a media URL.
  for (const asset of created) {
    if (asset.mediaUrl || asset.imageUrl) {
      log(`  asset ${asset.name} already has reference image, skip`);
      continue;
    }
    log(`  generating reference image for ${asset.name} via seedream-4`);
    try {
      const updated = await jfetch("POST", `/api/assets/${asset.id}/generate`, { model: "seedream-4" });
      const url = updated.mediaUrl || updated.imageUrl;
      log(`    -> ${url ? "ok" : "no media url"}`);
      Object.assign(asset, updated);
    } catch (err) {
      errlog(`    !! asset generation failed for ${asset.name}: ${err.message}`);
    }
  }
  return created;
}

async function patchShots(session, assets) {
  log("patching 4 shots with prompts/durations/continuity flags...");
  const result = [];
  for (let index = 0; index < session.shots.length; index += 1) {
    const shot = session.shots[index];
    const template = SHOT_TEMPLATES[index];
    if (!template) continue;
    const assetIds = template.assetNames
      .map((name) => assets.find((asset) => asset.name === name)?.id)
      .filter(Boolean);
    const patch = {
      title: template.title,
      durationSec: template.durationSec,
      seedanceVariant: "standard",
      usePreviousShotClip: template.usePreviousShotClip,
      previousShotClipSec: template.previousShotClipSec || 2,
      rawPrompt: template.rawPrompt,
      prompt: "", // let /plan fill the expanded prompt
      assetIds,
      status: "scripted"
    };
    log(`  shot ${index + 1}: ${template.title}`);
    const updated = await jfetch("PATCH", `/api/shots/${shot.id}`, patch);
    result.push(updated);
  }
  return result;
}

async function planAndGenerateSerial(shots) {
  log("generating each shot serially (continuity requires order)...");
  const finals = [];
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i];
    log(`>>> shot ${i + 1}/${shots.length}: ${shot.title}`);
    // plan endpoint is gone in current server build; the rawPrompt is already a complete shot prompt,
    // so we just submit straight to /generate which will treat rawPrompt as the prompt.
    log(`    generate...`);
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

    const finalShot = await pollUntilReady(shot.id);
    log(`    DONE: videoUrl=${finalShot.videoUrl}`);
    finals.push(finalShot);
  }
  return finals;
}

async function pollUntilReady(shotId) {
  const deadline = Date.now() + 18 * 60 * 1000; // 18 min per shot
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
    // unlikely for stitched output, but handle it
    localPath = path.resolve(os.tmpdir(), `${session.id}-final.mp4`);
    const res = await fetch(session.finalVideoUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(path.dirname(localPath), { recursive: true });
    await writeFile(localPath, buf);
  }
  if (!localPath) throw new Error(`Cannot resolve final video path from ${session.finalVideoUrl}`);
  const downloads = path.join(os.homedir(), "Downloads");
  await mkdir(downloads, { recursive: true });
  const target = path.join(downloads, `白门楼-cinema_agent-${session.id}.mp4`);
  await copyFile(localPath, target);
  log(`delivered: ${target}`);
  return target;
}

async function main() {
  const session = await ensureSession();
  const assets = await ensureAssets();
  const shots = await patchShots(session, assets);
  await planAndGenerateSerial(shots);
  const stitched = await stitchSession(session.id);
  const target = await deliver(stitched);
  log(`ALL DONE -> ${target}`);
}

main().catch((err) => {
  errlog(`FATAL: ${err.message}`);
  process.exit(1);
});
