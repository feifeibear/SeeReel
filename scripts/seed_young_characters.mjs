#!/usr/bin/env node
// Create derived "青年曹操" and "青年陈宫" assets that are explicitly linked to their parent
// (曹操 / 陈宫) so Seedream uses the parent's reference image during generation. This gives
// the flashback shot facial continuity with the present-day characters.

const BASE = process.env.CINEMA_BASE_URL || "http://127.0.0.1:5173";
const log = (...args) => console.log("[young]", ...args);
const errlog = (...args) => console.error("[young]", ...args);

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

const DERIVED = [
  {
    parentName: "曹操",
    name: "青年曹操",
    description:
      "三国魏武帝曹操青年时代（约 20-25 岁）。同一张脸的更年轻版本：脸庞清癯英锐、肤色更明亮、无须或仅留极短少年须，眉眼形状、鼻型、唇线、下颌轮廓、耳形必须与父资产参考图严格一致；只去掉中年的法令纹、眼下倦色与鬓角白霜。汉末服饰：青色或玄色短襟劲装/直裾袍，束发玉冠，腰间革带，神情坚毅未染权柄。竖画幅 9:16 全身三视图，正面、侧面、背面对齐同一身高比例、同一服装、同一道具，背景为纯净哑光浅灰角色设定专用背景。"
  },
  {
    parentName: "陈宫",
    name: "青年陈宫",
    description:
      "三国陈宫青年时代（约 20-25 岁），任中牟县令前后。同一张脸的更年轻版本：眉眼形状、鼻型、唇线、下颌轮廓、耳形必须与父资产参考图严格一致；皮肤更明亮、目光更清亮温润，未染风霜。汉末文士装：玄色或藏青色直裾官袍，束发竹冠，无胡须，气质纯净温和又有读书人之傲。竖画幅 9:16 全身三视图，正面、侧面、背面同一身高比例、同一服装、同一道具，背景为纯净哑光浅灰角色设定专用背景。"
  }
];

async function main() {
  const state = await jfetch("GET", "/api/state");
  const byName = new Map(state.assets.map((a) => [a.name, a]));

  for (const def of DERIVED) {
    const parent = byName.get(def.parentName);
    if (!parent) {
      errlog(`!! parent asset "${def.parentName}" not found, skipping ${def.name}`);
      continue;
    }
    let asset = byName.get(def.name);
    if (asset) {
      log(`updating existing asset ${def.name} (${asset.id}) -> parent=${parent.id}`);
      asset = await jfetch("PATCH", `/api/assets/${asset.id}`, {
        description: def.description,
        parentAssetId: parent.id,
        type: "character",
        mediaKind: "image"
      });
    } else {
      log(`creating asset ${def.name} with parent ${def.parentName} (${parent.id})`);
      asset = await jfetch("POST", "/api/assets", {
        name: def.name,
        type: "character",
        mediaKind: "image",
        description: def.description,
        prompt: "",
        parentAssetId: parent.id
      });
    }

    // expand description -> production-ready prompt
    log(`  expanding prompt for ${def.name}`);
    try {
      const { prompt } = await jfetch("POST", "/api/assets/expand-prompt", { asset });
      if (prompt) {
        asset = await jfetch("PATCH", `/api/assets/${asset.id}`, { prompt });
      }
    } catch (err) {
      errlog(`  !! expand failed for ${def.name}: ${err.message}`);
    }

    // generate image using parent's mediaUrl as reference
    log(`  generating reference image (with parent image as condition)`);
    try {
      const updated = await jfetch("POST", `/api/assets/${asset.id}/generate`, { model: "seedream-4" });
      log(`    -> ${updated.mediaUrl || updated.imageUrl || "no image"}`);
    } catch (err) {
      errlog(`  !! gen failed for ${def.name}: ${err.message}`);
    }
  }

  log("done.");
}

main().catch((err) => {
  errlog(`FATAL: ${err.message}`);
  process.exit(1);
});
