// Centralized prompt composers for Seedream (image gen) and Seedance (video gen).
//
// Every "generate" route in the project calls one of these — both for dry-run preview (return
// the prompt without submitting to the upstream model) and for the final submission. Composers
// switch between Chinese (default) and English output based on the session's `language` field.
//
// Design notes:
//   - composers ARE pure: same inputs + lang → same output. No env reads, no clock, no I/O.
//   - The `parts` map in the return value lets the UI show the audit trail segmented (e.g.
//     "raw / 资产参考 / 无字幕约束 / 时长") so the user can see which segment came from where.
//   - For the Seedance composer, mode resolution (first-frame vs first/last vs sub-shot vs plain)
//     stays in `buildBytePlusSeedancePayload` (generators.ts); we just take a resolved context.

import type { Asset, PromptComposition, SessionLanguage, Shot } from "../shared/types";

export type Lang = SessionLanguage;

export const DEFAULT_LANG: Lang = "zh";

export function resolveLang(value: unknown): Lang {
  return value === "en" ? "en" : "zh";
}

// ============================================================================
// Seedance — video text content
// ============================================================================

export interface SeedanceTextContext {
  shot: Pick<Shot, "rawPrompt" | "prompt" | "durationSec">;
  /** Assets that should appear in the @-mention reference table inside the prompt. */
  referencedAssets: Asset[];
  firstFrameAsset?: Asset;
  lastFrameAsset?: Asset;
  subShotAsset?: Asset;
  subShotPanelCount?: number;
  hasContinuityVideo?: boolean;
  hasContinuityAudio?: boolean;
  /** Aspect ratio fed to Seedance. Currently SEEDANCE_RATIO env, "16:9" / "9:16" etc. */
  resolution: string;
}

export function composeSeedanceVideoText(ctx: SeedanceTextContext, lang: Lang = DEFAULT_LANG): PromptComposition {
  const duration = clampDuration(ctx.shot.durationSec);
  const resolution = ctx.resolution || "16:9";
  const raw = (ctx.shot.rawPrompt || ctx.shot.prompt || "").trim();
  const parts: Record<string, string> = {};

  if (raw) parts.raw = raw;

  const refText = composeAssetReferenceTable(
    ctx.referencedAssets,
    {
      firstFrameAsset: ctx.firstFrameAsset,
      continuityVideoFirst: Boolean(ctx.hasContinuityVideo)
    },
    lang
  );
  if (refText) parts.assetReferences = refText;

  const globalContinuity = composeGlobalContinuityInstruction(ctx.referencedAssets, lang);
  if (globalContinuity) parts.globalContinuity = globalContinuity;

  parts.noTextOverlay = NO_TEXT_OVERLAY_INSTRUCTION[lang];

  parts.duration = lang === "zh" ? `生成时长：${duration} 秒。` : `Generation duration: ${duration}s.`;
  parts.resolution = lang === "zh" ? `分辨率 / 画幅比：${resolution}。` : `Resolution / aspect ratio: ${resolution}.`;
  parts.systemAuthority = lang === "zh"
    ? "以上时长与画幅比来自系统设置，是权威值。如果前文出现冲突的时长或画幅比，请忽略前文。"
    : "The duration and resolution values above come from the UI/system settings and are authoritative. If any earlier text mentions conflicting duration or resolution, ignore it.";

  if (ctx.hasContinuityVideo || ctx.hasContinuityAudio) {
    parts.continuity = composeContinuityInstruction(lang);
  }

  if (ctx.subShotAsset && ctx.subShotPanelCount && ctx.subShotPanelCount > 1) {
    parts.subShotSequence = composeSubShotSequenceInstruction(ctx.subShotPanelCount, lang);
  } else if (ctx.firstFrameAsset && ctx.lastFrameAsset) {
    parts.firstLastFrame = composeFirstLastFrameInstruction(ctx.firstFrameAsset, ctx.lastFrameAsset, lang);
  } else if (ctx.firstFrameAsset) {
    parts.firstFrame = composeFirstFrameInstruction(ctx.firstFrameAsset, lang);
  }

  // Final assembly order matches the legacy buildVideoPrompt + per-mode appendix.
  const order: Array<keyof typeof parts> = [
    "raw",
    "assetReferences",
    "globalContinuity",
    "noTextOverlay",
    "duration",
    "resolution",
    "systemAuthority",
    "continuity",
    "subShotSequence",
    "firstLastFrame",
    "firstFrame"
  ];
  const composedPrompt = order
    .map((key) => parts[key as string])
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n");

  return { composedPrompt, parts, lang };
}

function clampDuration(value?: number) {
  return Math.min(Math.max(Number(value) || 1, 1), 15);
}

function composeAssetReferenceTable(
  assets: Asset[],
  options: { firstFrameAsset?: Asset; continuityVideoFirst?: boolean },
  lang: Lang
): string {
  if (!assets.length) return "";
  const lines: string[] = [];
  lines.push(
    lang === "zh"
      ? "@提及的参考资产清单。仅在它们各自的角色范围内使用，不要凭空引申出额外剧情："
      : "Referenced assets from @ mentions. Use these references only for the named asset roles; do not invent extra story beats from them."
  );
  let imageIndex = options.firstFrameAsset ? 2 : 1;
  let videoIndex = options.continuityVideoFirst ? 2 : 1;
  let otherIndex = 1;

  for (const asset of assets) {
    const safeName = asset.name.replace(/\s*\/\s*/g, "/");
    const description = (asset.description || asset.prompt || "").trim();
    const usage = composeAssetUsage(asset, lang);
    const isFirstFrame = options.firstFrameAsset && asset.id === options.firstFrameAsset.id;
    if (isFirstFrame) {
      lines.push(
        lang === "zh"
          ? `图 1（first_frame）：@${safeName} = ${asset.type} 资产「${asset.name}」。这是生成视频的真实首帧，请从此精确构图开始向前推进。${description}`.trim()
          : `Image 1 (first_frame): @${safeName} = ${asset.type} asset "${asset.name}". This is the literal first frame of the generated video; animate forward from this exact composition. ${description}`.trim()
      );
      continue;
    }
    if (asset.mediaKind === "image") {
      lines.push(
        lang === "zh"
          ? `图 ${imageIndex}：@${safeName} = ${asset.type} 资产「${asset.name}」。${usage} ${description}`.trim()
          : `Image ${imageIndex}: @${safeName} = ${asset.type} asset "${asset.name}". ${usage} ${description}`.trim()
      );
      imageIndex += 1;
    } else if (asset.mediaKind === "video") {
      lines.push(
        lang === "zh"
          ? `视频 ${videoIndex}：@${safeName} = ${asset.type} 资产「${asset.name}」。仅按此资产被命名的运动 / 布局 / 视觉行为来用，不要混淆为视频 1 的上一镜头连贯。${description}`.trim()
          : `Video ${videoIndex}: @${safeName} = ${asset.type} asset "${asset.name}". Use this asset video only for its named motion, layout, or visual behavior; do not confuse it with Video 1 previous-shot continuity. ${description}`.trim()
      );
      videoIndex += 1;
    } else {
      lines.push(
        lang === "zh"
          ? `资产 ${otherIndex}：@${safeName} = ${asset.type} 资产「${asset.name}」。${usage} ${description}`.trim()
          : `Asset ${otherIndex}: @${safeName} = ${asset.type} asset "${asset.name}". ${usage} ${description}`.trim()
      );
      otherIndex += 1;
    }
  }

  return lines.join("\n");
}

function composeAssetUsage(asset: Asset, lang: Lang): string {
  if (asset.type === "character") {
    return lang === "zh"
      ? "保持该参考的角色身份、面部、体型、服装与典型表情细节。"
      : "Maintain the character identity, face, body type, costume, and recognizable expression details from this reference.";
  }
  if (asset.type === "scene") {
    return lang === "zh"
      ? "保持该参考的场景布局、关键物体、灯光逻辑、配色、天气与空间方位。"
      : "Maintain the scene layout, key objects, lighting logic, palette, weather, and spatial geography from this reference.";
  }
  if (asset.type === "prop") {
    return lang === "zh"
      ? "保持该参考的道具形状、材质、尺寸、状态以及被持握 / 使用的方式。"
      : "Maintain the prop shape, material, scale, state, and how it is held or used from this reference.";
  }
  if (asset.type === "style") {
    return lang === "zh"
      ? "仅在不覆盖角色身份、场景连贯与用户 prompt 的前提下采用此视觉风格。"
      : "Maintain the visual style only when it does not override character identity, scene continuity, or the user's prompt.";
  }
  return lang === "zh"
    ? "按此参考被显式命名的视觉细节使用，用户 prompt 仍是最高权威。"
    : "Use this reference for its explicitly named visual details while keeping the user's prompt authoritative.";
}

function composeGlobalContinuityInstruction(assets: Asset[], lang: Lang): string {
  const cast = assets.filter((asset) => asset.type === "character");
  const scenes = assets.filter((asset) => asset.type === "scene");
  if (!cast.length && !scenes.length) return "";
  const castNames = cast.map((asset) => `@${asset.name.replace(/\s*\/\s*/g, "/")}`).join("、");
  const sceneNames = scenes.map((asset) => `@${asset.name.replace(/\s*\/\s*/g, "/")}`).join("、");
  if (lang === "en") {
    return [
      "Long-form continuity lock:",
      castNames ? `Across the entire film, keep these cast identities locked: ${castNames}. The same named character must keep the same face geometry, body type, hair, costume palette, age, and recognizable expression pattern in every shot.` : "",
      sceneNames ? `Keep these scene identities locked when they appear: ${sceneNames}. Preserve geography, practical light direction, palette, weather, and object placement across cuts.` : "",
      "Do not treat later shots as a reboot. This shot is one beat inside the same one-minute story; keep visual rhythm, emotional intensity, camera language, and pacing compatible with adjacent shots."
    ].filter(Boolean).join("\n");
  }
  return [
    "长视频一致性锁定：",
    castNames ? `整条片中锁定这些演员身份：${castNames}。同名角色在每个镜头都必须保持相同脸型、五官比例、体型、发型、服装主色、年龄感与可识别表情习惯。` : "",
    sceneNames ? `这些场景出现时必须锁定：${sceneNames}。保持空间方位、实景光源方向、色彩、天气与关键物件位置跨镜头一致。` : "",
    "不要把后续镜头当成重新开场。本镜是同一条 1 分钟故事里的一个节拍；视觉节奏、情绪强度、镜头语言和剪辑速度都要能和相邻镜头自然接上。"
  ].filter(Boolean).join("\n");
}

const NO_TEXT_OVERLAY_INSTRUCTION: Record<Lang, string> = {
  zh:
    "严格禁止屏幕内文字：不要渲染任何屏幕字幕、台词条、低三分屏、标题卡、片头片尾字幕、屏幕内排版、歌词条、动态文字、" +
    "水印、台标、标识、版权说明，也不要插入任何 UI 元素。仅当文字属于被拍摄的物理世界时允许（例如商店招牌、海报、" +
    "角色正在展示的笔记本电脑屏幕里的内容）。",
  en:
    "STRICT NO-TEXT-OVERLAY RULE: do NOT render any on-screen subtitles, captions, lower-thirds, " +
    "title cards, opening/closing credits, on-screen typography, lyric lines, kinetic text, " +
    "watermarks, channel logos, brand logos, copyright notices, or UI elements. Allowed: text that is naturally " +
    "part of the physical world being filmed (e.g. a store sign, a poster, content on a laptop screen the character is showing)."
};

function composeContinuityInstruction(lang: Lang): string {
  if (lang === "en") {
    return [
      "Shot-to-shot continuity reference:",
      "Video 1 is the immediate previous shot, especially its final seconds. Use it as temporal continuity context, not as a generic style sample.",
      "The user's original prompt defines what happens next. Add only the missing connective tissue needed to make the new shot feel like the next beat after Video 1.",
      "Begin after the final moment of Video 1. Do not replay the same frames, do not restart the same action, and do not make the character return to an earlier pose unless the user explicitly asks for it.",
      "Carry forward concrete continuity cues from Video 1: character emotion, eyeline, body direction, blocking, spatial relationship, prop state, scene geography, weather, practical light sources, color temperature, exposure, texture, lens feel, framing center, camera height, camera movement direction, movement speed, rhythm, and pacing.",
      "For audio continuity, keep the ambience, room tone, music energy, rhythm, BPM feel, instrumentation, and sound texture consistent with Video 1. Let sound evolve naturally with the new action instead of abruptly switching style.",
      "If @ asset images are present, they control identity, costume, props, and scene design. Video 1 controls the handoff, motion, camera continuity, and audio/tempo continuity. If these references conflict, prioritize the user's prompt first, then @ asset identity/design, then Video 1 continuity.",
      "If the user's prompt explicitly asks for a jump cut, scene change, time skip, silence, or new music, follow the user's prompt over this continuity instruction."
    ].join("\n");
  }
  return [
    "镜头到镜头的连贯参考：",
    "视频 1 是紧邻的上一镜头，尤其是它的末几秒。把它当作时间上的连贯上下文，而不是一个通用的风格样本。",
    "用户的原始 prompt 定义「接下来发生什么」。你只补必要的过渡，让本镜看起来是视频 1 之后的下一个节拍。",
    "从视频 1 的最后一刻之后开始。不要重播同样的画面，不要重启同样的动作，也不要让角色回到更早的姿势——除非用户的 prompt 明确这样要求。",
    "需要从视频 1 继承的连贯线索：角色情绪、视线、身体朝向、走位、空间关系、道具状态、场景地理、天气、实景光源、色温、曝光、质感、镜头味道、构图重心、机位高度、运镜方向、运动速度、节奏与韵律。",
    "音频上保持视频 1 的环境音、房间噪声、音乐能量、节奏、BPM 感、配器与音色一致。让声音随新动作自然演化,而不是突然切换风格。",
    "如果有 @ 资产图，它们决定角色身份、服装、道具与场景设计;视频 1 决定接续点、运动、运镜连贯与音乐 / 节奏连贯。三者冲突时:优先用户 prompt,其次 @ 资产身份与设计,最后才是视频 1 连贯。",
    "如果用户 prompt 明确要硬切、换场、时间跳跃、静音或新音乐,以用户 prompt 为准,忽略本连贯指令。"
  ].join("\n");
}

function composeFirstFrameInstruction(asset: Asset, lang: Lang): string {
  const label = `@${asset.name.replace(/\s*\/\s*/g, "/").replace(/\s+/g, "")}`;
  if (lang === "en") {
    return [
      `First-frame mode: the attached image is the literal first frame of the video.`,
      `Animate FROM that exact frame (composition, character, lighting, framing match ${label}).`,
      `Do not treat it as a generic style reference; do not cut away from it at t=0.`
    ].join(" ");
  }
  return [
    `首帧模式：附图就是本段视频的真实第一帧。`,
    `请从这一帧的确切构图开始向前演化（构图、角色、光线、画面边界都对齐 ${label}）。`,
    `不要把它当作泛风格参考，不要在 t=0 就剪走。`
  ].join(" ");
}

function composeFirstLastFrameInstruction(firstAsset: Asset, lastAsset: Asset, lang: Lang): string {
  const firstLabel = `@${firstAsset.name.replace(/\s+/g, "")}`;
  const lastLabel = `@${lastAsset.name.replace(/\s+/g, "")}`;
  if (lang === "en") {
    return [
      `First-and-last frame mode: the two attached images are the literal start and end frames of the video.`,
      `Frame 1 (${firstLabel}) is the very first frame; Frame 2 (${lastLabel}) is the very last frame.`,
      `Interpolate motion smoothly between the two: composition, character identity, lighting and framing must match the start and resolve onto the end.`,
      `Do not cut, do not reset, do not introduce content that contradicts either anchor frame.`
    ].join(" ");
  }
  return [
    `首尾帧模式：两张附图分别是视频的首帧和尾帧。`,
    `第 1 张（${firstLabel}）是视频的真实第一帧；第 2 张（${lastLabel}）是视频的真实最后一帧。`,
    `请在两者之间平滑插值：构图、角色身份、光线、边界要从起点过渡到终点。`,
    `不要剪辑、不要重启、不要插入与任一锚定帧冲突的内容。`
  ].join(" ");
}

function composeSubShotSequenceInstruction(panelCount: number, lang: Lang): string {
  if (lang === "en") {
    return [
      `Storyboard-sequence mode: the attached image1 is a single composite of ${panelCount} reference panels arranged as a storyboard grid (read left-to-right, top-to-bottom).`,
      `Follow the storyboard sequence of the ${panelCount} reference frames in image1, edited as a fast-cut cinematic sequence.`,
      `Each panel is one beat of the timeline; output a single continuous video that cuts through all ${panelCount} beats in order.`,
      `Distribute panel beats roughly evenly across the duration. Keep transitions smooth, preserve character identity, lighting and palette across cuts. Do NOT compose the output as a grid; do NOT show panel borders or labels in the output video.`
    ].join(" ");
  }
  return [
    `分镜序列模式：附图 image1 是 ${panelCount} 个参考面板拼合的单张故事板（按从左到右、从上到下的顺序阅读）。`,
    `请遵循 image1 中 ${panelCount} 个参考帧的故事板序列，作为一段快速剪辑的电影化镜头输出。`,
    `每个面板对应时间轴上的一个节拍；输出单段连贯视频,按顺序切过所有 ${panelCount} 个节拍。`,
    `将面板节拍大致均匀地分布在视频时长上。保持转场流畅、跨剪辑维持角色身份与光线、配色一致。**不要**把输出渲染成网格；**不要**在输出视频中出现面板边框或标号。`
  ].join(" ");
}

// ============================================================================
// Seedream — image gen prompts
// ============================================================================

/**
 * Cinema-quality prompt scaffold for Seedream 4.5 asset generation. Per-type templates use the
 * specific gear / lighting / grading vocabulary that production cinematographers use — Seedream
 * binds the look much more strongly to real ARRI/Cooke/Kodak token names than to generic
 * "cinematic" hand-waving.
 *
 * Each template:
 *   - opens with the user's raw text (highest prompt weight on the head)
 *   - states the output frame + aspect ratio explicitly
 *   - names a specific camera body + lens + film stock
 *   - decomposes lighting into key / fill / rim with degrees + Kelvin
 *   - calls out atmospherics (haze, light shaft, practical sources)
 *   - names a real color-grade convention (teal-orange / ENR / bleach bypass)
 *   - ends with a strict NEGATIVE block (Seedream weights end-of-prompt negatives best)
 *
 * Per-type intent:
 *   - **character**: 16:9 three-pose turnaround (front / 3/4 / back full body), studio softbox key,
 *     5500K daylight, neutral seamless backdrop, identity locked across views.
 *   - **scene**: 16:9 establishing plate, anamorphic deep focus, motivated practical lighting,
 *     atmospheric haze, no people unless prompted.
 *   - **prop**: 1:1 product hero, 90mm macro, soft top + rim, neutral backdrop.
 *   - **style**: 16:9 mood board still, color grade and composition that ARE the style.
 */
export function composeSeedreamAssetPrompt(
  asset: Pick<Asset, "prompt" | "description" | "name" | "type">,
  hasReference: boolean,
  lang: Lang = DEFAULT_LANG
): PromptComposition {
  const parts: Record<string, string> = {};
  const raw = (asset.prompt || asset.description || asset.name || "").trim();
  parts.raw = raw;

  if (lang === "zh") {
    if (asset.type === "character") {
      parts.intent = `电影角色设定参考表（character lookbook turnaround）：${asset.name || "电影角色"}。**输出一张** 16:9 横构图，**真实真人照片级 photoreal live-action** 角色参考图，画面内只能出现一个真实成年人角色；画面内**横向并排展示同一角色三个全身视图**——左：正面 / 中:三分之四侧面 / 右:背面。三个视图全身从头到脚完整入画，**不要裁切头顶或鞋底**。`;
      parts.purpose = "**用途声明**：这张图是**下游 Seedance 视频生成的角色参考底板**，不是单图作品。Seedance 会在不同分镜里反复读取这张图以保持角色身份。因此本图必须满足参考底板的硬约束：**中性表情**（嘴自然闭合，眼平视镜头，无笑无怒无嘟嘴无瞪眼无眨眼），**中性手势**（双手自然下垂或微贴大腿，不抱胸不插兜不指向不持物 except 提示词显式列出的随身道具），**中性身姿**（站直自然，无奔跑无下蹲无跳跃），**均匀中性光**（不要硬阴影、不要单方向强光、不要彩色 gel），便于 Seedance 在任何镜头光线下重新打光。";
      parts.identity = "三个视图必须是同一个角色：人物比例、五官、肤色、发型与发色、瞳色、表情、服装款式与配色、配饰、随身道具、鞋款必须**像素级一致**。";
      parts.pose = "自然克制 A-pose 站姿；正面视图直面镜头与观众平视；三分之四侧面视图微转身体露出侧脸轮廓与服装侧缝；背面视图展示后背结构、发型轮廓与服装背面细节。**三视图脚踝水平线对齐**。";
      parts.cinematography = "**ARRI Alexa Mini LF + Zeiss Supreme Prime 50mm T1.5 + Kodak Vision3 250D 数字模拟胶片质感**；f/5.6 中等景深，三个视图的面部、眼睛、头发边缘、服装轮廓全部清晰锐利；横构图；柔和电影感反差；禁止虚焦、散焦、motion blur、低清噪点。";
      parts.lighting = "影棚四点布光：**主光（key）**=右上 45° 大尺寸柔光箱（Diva-Lite/Skypanel 类型）；**辅光（fill）**=正面环形 LED 1/2 强度填阴；**轮廓光（rim/edge）**=后侧轻微钨丝勾边分离背景；**发光（hair light）**=顶部柔光勾发丝。色温 5500K 日光平衡，CRI 95+，无硬阴影、无单方向强光，整体接近均匀漫射以便后续 Seedance 自由打光。";
      parts.materials = "真实真人皮肤纹理：可见自然毛孔、法令纹、眼周细纹、胡茬或剃须痕迹、微小油光，subsurface scattering 自然；**避免塑料感**。布料纤维与编织清晰可辨；金属、皮革、丝绸等材质按物性如实表现。";
      parts.background = "纯净影棚背景：**light grey to mid grey seamless paper backdrop**（浅灰到中灰渐变 seamless 影棚纸），脚下 ~0.5m 极淡接触阴影；不要任何家具、装饰、地砖、纹理、道具。";
      parts.grading = "胶片级调色：低饱和、低对比、温和肤色，highlight 软卷曲，shadow 保留细节，**Kodak Vision3 颗粒感**；**调色保持中性**（不要 push 强情绪 grade，因为 Seedance 后续会按各分镜情绪重新调色）；不要数码 HDR、不要 ACES IDT 看上去像广告片。";
      parts.negative = "**STRICT NEGATIVE**：画面中**绝对不要**出现任何屏幕文字、字幕、对白气泡、品牌 LOGO、UI 元素、水印、签名、二维码；不要第二个人；不要 anime / cartoon / illustration / painting / game CG / 3D 渲染感 / 蜡像感；不要塑料皮肤；不要脸部模糊、低分辨率、虚焦、motion blur、眼睛糊；不要 deformed / extra fingers；不要饱和度过高；不要 HDR halo；不要现代乱入元素；**不要 motion blur**（参考图必须每个像素清晰锐利）；**不要任何夸张表情或动作**（哭、笑、大喊、跑、跳、踢均禁止——这些会干扰 Seedance 在所有分镜里保持稳定角色）。";
    } else if (asset.type === "scene") {
      parts.intent = `电影场景 establishing plate：${asset.name || "电影场景"}。16:9 横构图电影级**全景空镜**，**画面内不出现人物**（除非用户原文显式要求），强调环境、光线与氛围。`;
      parts.purpose = "**用途声明**：这张图是**下游 Seedance 视频生成的场景参考底板**。Seedance 会在不同分镜里把演员置入这个场景。因此本图必须满足底板硬约束：**画面绝对干净无人物**（包括玻璃倒影、远处剪影、镜面反射均不可有人；车辆和动物视场景需要保留）；**前景留出 1/3 空地**便于后期演员置入；**光线接近中性**（不要逆光剪影、不要彩色霓虹主导画面、不要极端 god ray），让 Seedance 后续在该底板上自由演员置入与打光。";
      parts.cinematography = "**ARRI Alexa 35 + Cooke S7/i 32mm T2.0**（或场景需要时改为 Master Anamorphic 40mm T1.9 加水平蓝色 lens flare）；f/5.6-8 大景深保证全景纵深；轻微 anamorphic 横向 oval bokeh + ovalised highlights；2.39:1 宽银幕电影感（在 16:9 内画幅内构图）。";
      parts.lighting = "**motivated practical lighting**：只用场景内合理光源驱动画面（窗光 / 街灯 / 霓虹 / 烛火 / god ray），主光方向明确，亮部与暗部之间有清晰过渡；空气中有薄雾或灰尘形成 atmospheric haze 让光束可见；时间设定与原文一致（golden hour / blue hour / night / overcast / 黎明）；但**避免极端逆光剪影**——前景空地区域要曝光合适以便置入演员。";
      parts.composition = "**foreground / mid-ground / background 三层景深**清晰可读；遵循三分法或对称中心；leading lines 与 vanishing point 明确；**画面下半部 1/3 区域留白**（仅地面 / 桌面 / 走廊地板，不要堆放杂物或主体）以便 Seedance 后期置入演员；上半部展示场景标志性元素。";
      parts.materials = "建筑表面老化：积尘、磨损、湿漉反光、油渍、霉斑等真实细节；地面、墙面、织物、金属等材质各有质感差别；**不要**所有表面都干净如新。";
      parts.grading = "电影调色：**teal-orange**（白天 / 室内 / 都市夜景）或场景情绪对应 grade（noir = ENR 银盐保留 / 战争片 = bleach bypass / 80s = 暖色 push）；低饱和；highlight 软卷曲；shadow 保留细节；35mm 胶片颗粒；**保持中性偏温和**（不要 push 极端情绪 grade，Seedance 后续会按各分镜重新调色）。";
      parts.negative = "**STRICT NEGATIVE**：画面中**绝对不要**出现任何屏幕文字、字幕、可读招牌字、UI 元素、水印；**画面绝对不要出现任何人物**（除非用户原文显式要求）——包括玻璃倒影、远处剪影、镜面反射、镜头中所有反射面、屏幕里的人物均必须无；不要变形物体；不要饱和度爆表；不要 HDR halo / 锐化过度；不要 anime / cartoon；**不要 motion blur**（参考底板每像素必须清晰）。";
    } else if (asset.type === "prop") {
      parts.intent = `电影道具参考图：${asset.name || "电影道具"}。1:1 方画幅产品级 hero shot，**单一主体居中**，全部入画。`;
      parts.cinematography = "**Phase One IQ4 + Schneider 90mm T/S Macro**（或 90mm-equivalent macro），f/8 全幅锐利，主体占画面 60-70%；干净三分构图；微距还原。";
      parts.lighting = "三点布光：**柔和顶部主光**（diffused top key）+ **后侧 rim light** 勾轮廓与背景分离 + **正面填充**轻减阴影。色温 5000K，无杂乱反射。";
      parts.materials = "材质刻画到位：金属（specular + 各向异性反射）、皮革（毛孔 + 磨损 + 染色不均）、玻璃（透射 + 折射 + 高光）、布料（weave + drape）、木材（年轮 + 抛光）按物性如实表现。";
      parts.background = "中性渐变背景纸（light-grey to dark-grey gradient seamless），脚下极淡接触阴影；**不要**桌面纹理、装饰、第二物体。";
      parts.negative = "**STRICT NEGATIVE**：画面中不要文字、品牌 LOGO（除非原文包含）、价格标签、水印；不要第二个物体抢戏；不要塑料合成感；不要 HDR halo；不要广角畸变。";
    } else if (asset.type === "style") {
      parts.intent = `电影风格 mood-board reference：${asset.name || "电影风格"}。16:9 横构图，用一张有代表性的电影画面承载该风格的所有视觉特征。`;
      parts.cinematography = "**ARRI Alexa Mini LF + Master Anamorphic 50mm T1.9**，f/2.8 浅景深，35mm 胶片质感，2.39:1 cinemascope。";
      parts.lighting = "光线遵循该风格核心特征：noir = 高对比硬光 + Venetian blind；impressionist = 柔光散射；cyberpunk = 霓虹 practicals + 雨夜湿地反光；Wes Anderson = 平面正面光 + 严格 hue keys。";
      parts.grading = "调色作为该风格的灵魂：色温倾向、饱和度、对比度、highlight rolloff、shadow detail、film grain 都需精准还原（noir = ENR / 50s = 高饱和泡沫粉 / 现代独立片 = teal-orange / 战争片 = bleach bypass）。";
      parts.composition = "镜头语言能代表该风格（noir = 低角度斜线; new wave = 中景跳切感; Wes Anderson = 严格中心对称; Tarkovsky = 缓慢推进对称）。";
      parts.negative = "**STRICT NEGATIVE**：不要文字、字幕、UI；不要风格混搭；不要漫画 / 3D 渲染（除非该风格本身要求）；不要 HDR halo。";
    } else {
      parts.intent = `电影资产参考图：${asset.name || "未命名资产"}。`;
      parts.cinematography = "ARRI Alexa Mini LF + 50mm prime，35mm 胶片质感；主体清晰，材质细节明确。";
      parts.negative = "**STRICT NEGATIVE**：不要文字、字幕、水印、UI；不要 HDR halo。";
    }

    if (hasReference) {
      parts.reference = "已附参考图：尽可能保留原参考的主体身份（同一动物 / 人物 / 物体），同样的轮廓、姿态、表情、视线方向、头部角度、配色与质感、构图都保留。如参考图分辨率低或模糊，请增强清晰度、还原细节、干净放大、消除压缩 artifact，但**不要改变主体身份**。";
    }
  } else {
    if (asset.type === "character") {
      parts.intent = `Cinematic character lookbook turnaround for "${asset.name || "film character"}". **Output a single 16:9 horizontal photoreal live-action image** containing only one real adult character shown as **three full-body views of the SAME character side by side**: left = front, center = three-quarter, right = back. Full body head-to-toe in frame for every view. **Do not crop the head or feet.**`;
      parts.identity = "All three views must depict the SAME character at **pixel-level identity**: identical proportions, facial features, skin tone, hairstyle, hair color, eye color, expression, wardrobe style and color, accessories, hand-held props, and footwear.";
      parts.pose = "Relaxed natural A-pose. Front view: facing the lens at eye level. Three-quarter view: body slightly turned to reveal side facial profile and the side seam of garments. Back view: showing back silhouette, hair shape from behind, and rear garment construction. **Ankle baseline aligned across all three views.**";
      parts.cinematography = "**ARRI Alexa Mini LF + Zeiss Supreme Prime 50mm T1.5 + Kodak Vision3 250D digital film emulation**, f/5.6 medium depth of field; face, eyes, hairline and wardrobe edges are tack sharp in all three views; no soft focus, no defocus, no motion blur, no low-resolution noise.";
      parts.lighting = "Studio four-point lighting: **key** = 45° high overhead softbox (Skypanel/Diva-Lite class); **fill** = frontal LED ring at 1/2 intensity to lift shadows; **rim/edge** = subtle tungsten kicker from rear separating subject from backdrop; **hair light** = top diffuse pulling out hair detail. 5500K daylight balance, CRI 95+, no harsh contrast.";
      parts.materials = "Photoreal human skin texture: visible natural pores, nasolabial folds, fine eye wrinkles, subtle shaving stubble or shave marks, gentle oil sheen and subsurface scattering, **no plastic look**. Fabric weave readable. Metal, leather, silk all rendered with material accuracy.";
      parts.background = "Clean studio backdrop: **light grey to mid grey seamless paper**, faint ~0.5m contact shadow at the feet. No props, furniture, floor texture, decorations.";
      parts.grading = "Film-grade color: low saturation, low contrast, gentle skin tones, soft highlight rolloff, retained shadow detail, **Kodak Vision3 grain texture**. No aggressive digital HDR or ad-grade ACES look.";
      parts.negative = "**STRICT NEGATIVE**: no on-screen text, subtitles, speech bubbles, brand logos, UI elements, watermarks, signatures, QR codes; no second person; no anime / cartoon / illustration / painting / game CG / 3D render / wax figure look; no plastic skin; no blurry face, low resolution, soft focus, motion blur, smeared eyes; no deformed or extra fingers; no oversaturation; no HDR halos; no anachronistic modern elements; **no exaggerated expression or action**.";
    } else if (asset.type === "scene") {
      parts.intent = `Cinematic scene establishing plate for "${asset.name || "film scene"}". 16:9 horizontal cinema-grade **wide shot empty plate**, **NO people in frame** unless the user prompt explicitly asks. Emphasize environment, light, atmosphere.`;
      parts.cinematography = "**ARRI Alexa 35 + Cooke S7/i 32mm T2.0** (or Master Anamorphic 40mm T1.9 with subtle horizontal blue lens flare when the scene calls for it), f/5.6–f/8 deep focus, slight anamorphic horizontal oval bokeh, 2.39:1 cinemascope feel composed within a 16:9 frame.";
      parts.lighting = "**motivated practical lighting** only: window light, streetlamps, neon, candles, god rays, etc. depending on the scene. Clear key direction; readable highlight-shadow falloff; **atmospheric haze** so light beams are visible. Time-of-day matches the user prompt (golden hour / blue hour / night / overcast / dawn).";
      parts.composition = "**Foreground / mid-ground / background depth layers** all clearly readable; rule-of-thirds or intentional symmetry; clear leading lines and vanishing points.";
      parts.materials = "Realistic surface aging: dust, wear, wet reflections, oil stains, mildew where appropriate. Floor / wall / fabric / metal materials all texturally distinct. Avoid the everything-clean-and-new look.";
      parts.grading = "Cinema color grade: **teal-orange** (daylight / interiors / urban night) or scene-emotion grade (noir = ENR silver retention; war = bleach bypass; 80s = warm push). Low saturation; soft highlight rolloff; retained shadow detail; 35mm film grain.";
      parts.negative = "**STRICT NEGATIVE**: no on-screen text, subtitles, readable billboard text, UI elements, watermarks; **no people in frame** unless prompt explicitly asks; no deformed objects; no oversaturation; no HDR halos / over-sharpening; no anime/cartoon style.";
    } else if (asset.type === "prop") {
      parts.intent = `Cinema prop reference for "${asset.name || "film prop"}". 1:1 square, product-style hero shot, single subject centered, fully in frame.`;
      parts.cinematography = "**Phase One IQ4 + Schneider 90mm T/S Macro** (or 90mm-equivalent macro), f/8 fully sharp, subject occupies ~60-70% of frame, clean rule-of-thirds.";
      parts.lighting = "Three-point: **diffused top key** + **rear rim light** for separation + **frontal fill**. 5000K neutral white, no cluttered reflections.";
      parts.materials = "Material accuracy: metals (specular + anisotropic), leather (pores + wear + dye unevenness), glass (transmission + refraction + speculars), fabric (weave + drape), wood (grain + polish) — render per the actual prop material.";
      parts.background = "Light-grey to dark-grey gradient seamless paper, faint contact shadow grounding the subject. No surface texture, no decorations, no second object.";
      parts.negative = "**STRICT NEGATIVE**: no text, no brand logos (unless prompt explicitly includes), no price tags, no watermarks; no second competing object; no plastic-feel synthetics; no HDR halos; no wide-angle distortion.";
    } else if (asset.type === "style") {
      parts.intent = `Style mood-board reference for "${asset.name || "film style"}". 16:9 horizontal frame, one representative cinematic still that carries every visual signature of the named style.`;
      parts.cinematography = "**ARRI Alexa Mini LF + Master Anamorphic 50mm T1.9**, f/2.8 shallow DOF, 35mm film stock look, 2.39:1 cinemascope.";
      parts.lighting = "Lighting matches the style's core signature: noir = high-contrast hard key + Venetian-blind shadows; impressionist = soft diffuse; cyberpunk = neon practicals + wet-ground reflections; Wes Anderson = flat frontal + strict hue keys.";
      parts.grading = "Color grade IS the style: temperature lean, saturation, contrast, highlight rolloff, shadow detail, grain — accurate (noir = ENR; 50s = saturated bubblegum pink; modern indie = teal-orange; war = bleach bypass).";
      parts.composition = "Composition / camera language representative of the style (noir = low-angle diagonals; new wave = mid-shot jump-cut feel; Wes Anderson = strict centered symmetry; Tarkovsky = slow centered push-in).";
      parts.negative = "**STRICT NEGATIVE**: no on-screen text, subtitles, UI; no style mix-up; no comic/3D-render unless the style requires it; no HDR halos.";
    } else {
      parts.intent = `Cinema asset reference for "${asset.name || "asset"}".`;
      parts.cinematography = "ARRI Alexa Mini LF + 50mm prime, 35mm film stock look, sharp subject, accurate material detail.";
      parts.negative = "**STRICT NEGATIVE**: no text, subtitles, watermarks, UI; no HDR halos.";
    }

    if (hasReference) {
      parts.reference = "Reference image attached: preserve the original subject's identity (same animal/person/object), silhouette, pose, expression, gaze direction, head angle, color pattern, texture, and composition. If the reference is low resolution or blurry, enhance clarity, recover detail, upscale cleanly, and remove compression artifacts **without changing the subject identity**.";
    }
  }

  // Order matters: user intent first (highest weight), then framing/cinematography, then
  // material/lighting/grading, then reference notes, then negatives at the end (Seedream weights
  // negative phrasing better when it's the last thing in the prompt).
  const order = [
    "raw",
    "intent",
    "purpose",
    "identity",
    "pose",
    "cinematography",
    "lighting",
    "composition",
    "materials",
    "background",
    "grading",
    "reference",
    "negative"
  ];
  const composedPrompt = order.map((k) => parts[k]).filter(Boolean).join("\n");
  return { composedPrompt, parts, lang };
}

export interface SubStoryboardReferenceLabel {
  /** 1-based image index as it appears in the Seedream `image` array (image_1, image_2, …). */
  imageNumber: number;
  /** Short human label, e.g. "老板（灰西装中年男）". Used inline in the composed prompt. */
  label: string;
}

/**
 * Compose a storyboard-grid prompt for Seedream that actually obeys the panel count.
 *
 * The previous version used poetic phrasing ("电影感故事板，包含 N 个时间节拍…") which Seedream
 * interpreted loosely — it produced 2 panels when asked for 4, fudged the layout, etc. The
 * rewrite leans hard on three disciplines that Seedream 4.x respects in practice:
 *
 *   1. **Repeat the count.** State `N panels` three times: in the lead, in the row×col layout, and
 *      in the per-panel listing.
 *   2. **Per-panel listing.** Enumerate "Panel 1: …, Panel 2: …, Panel 3: …, Panel 4: …" so the
 *      model has a slot for each. We auto-split the user's `0-Xs / X-Ys` timeline tokens into
 *      per-panel beats; if the user didn't structure the scene that way, we mirror the same
 *      description to all panels (better than silent fudging).
 *   3. **Inline image_N references.** When reference photos are attached, name them by index +
 *      label ("image_1 = 老板（灰西装）") so Seedream binds identity per character. This is the
 *      idiom the model picks up from training data of multi-image instructions.
 *
 * Negative phrasing lives at the end (Seedream weights end-of-prompt negatives most strongly).
 *
 * Aspect-ratio note: this composer doesn't pick the size — the route layer does that based on the
 * source aspect ratio. We just describe the grid shape.
 */
export function composeSeedreamSubStoryboardGrid(
  scenePrompt: string,
  panelCount: number,
  layout: string,
  lang: Lang = DEFAULT_LANG,
  refLabels: SubStoryboardReferenceLabel[] = []
): PromptComposition {
  const parts: Record<string, string> = {};
  const [colsStr, rowsStr] = layout.toLowerCase().split("x");
  const cols = Math.max(1, Number(colsStr) || Math.ceil(Math.sqrt(panelCount)));
  const rows = Math.max(1, Number(rowsStr) || Math.ceil(panelCount / cols));
  const panelBeats = splitSceneIntoPanels(scenePrompt, panelCount);

  if (lang === "en") {
    parts.lead = `COMPOSITE STORYBOARD SHEET — exactly ${panelCount} cinematic film stills arranged in a ${rows}-row × ${cols}-column grid inside ONE single image.`;
    parts.layout = [
      `Sheet layout (strict):`,
      `- Total panels: exactly ${panelCount} (not more, not fewer)`,
      `- Rows: ${rows}; Columns: ${cols}`,
      `- Reading order: panel 1 = top-left, then left→right, top→bottom`,
      `- Thin black gutter (~6 px) between every panel; equal-sized panels; clean rectangular cells`,
      `- All ${panelCount} panels must be visible inside the single composite image`
    ].join("\n");
    parts.panels = [
      `Per-panel content (each panel = one moment in time of the SAME continuous scene):`,
      ...panelBeats.map((beat, i) => `  Panel ${i + 1}: ${beat}`)
    ].join("\n");
    parts.consistency = [
      `Visual consistency across ALL ${panelCount} panels:`,
      `- SAME character identity (face, hair, body proportions, wardrobe)`,
      `- SAME lighting direction and color palette`,
      `- SAME film grain and color grade`,
      `- SAME location / set unless the user prompt explicitly cuts location`
    ].join("\n");
    if (refLabels.length) {
      parts.references = [
        `Reference photographs attached:`,
        ...refLabels.map((r) => `- image_${r.imageNumber}: ${r.label}`),
        `Use the attached references as the ground-truth identity for the matching characters in EVERY panel. Do NOT drift across panels — the same face / wardrobe must appear consistently.`
      ].join("\n");
    }
    parts.negative = `STRICT NEGATIVE (do NOT do these): no captions, no panel numbers drawn on the image, no speech bubbles, no subtitles, no title cards, no on-screen text of any kind, no watermarks, no UI elements. Do NOT merge panels. Do NOT generate fewer or more than ${panelCount} panels.`;
  } else {
    parts.lead = `综合故事板单页 — 在一张图里放正好 ${panelCount} 个电影级影像帧，按 ${rows} 行 × ${cols} 列网格排布。`;
    parts.layout = [
      `网格规则（严格遵守）：`,
      `- 面板总数：正好 ${panelCount} 个（不多不少）`,
      `- 行数：${rows}；列数：${cols}`,
      `- 阅读顺序：第 1 格 = 左上，然后从左到右、从上到下`,
      `- 每个面板之间有约 6px 的黑色细间隔条；面板尺寸相等，矩形单元干净`,
      `- 全部 ${panelCount} 个面板必须都出现在这张合成图里`
    ].join("\n");
    parts.panels = [
      `每格内容（每格 = 同一连续场景里的一个时间瞬间）：`,
      ...panelBeats.map((beat, i) => `  第 ${i + 1} 格：${beat}`)
    ].join("\n");
    parts.consistency = [
      `全部 ${panelCount} 个面板视觉一致：`,
      `- 角色身份完全一致（脸、发、身材比例、服装）`,
      `- 光线方向与配色一致`,
      `- 胶片颗粒与调色一致`,
      `- 场景 / 布景一致，除非用户原文显式换景`
    ].join("\n");
    if (refLabels.length) {
      parts.references = [
        `已附参考照：`,
        ...refLabels.map((r) => `- image_${r.imageNumber}：${r.label}`),
        `请把参考照当作对应角色的身份准绳：每一格里出现的相同角色都必须严格按照参考照的脸、发型、服装、气质来画；不要在格与格之间漂移。`
      ].join("\n");
    }
    parts.negative = `STRICT NEGATIVE（绝对不要做的事）：不要任何字幕、不要在图上画面板编号、不要对白气泡、不要片头片尾、不要任何屏幕文字、不要水印、不要 UI 元素；不要合并面板；不要少画或多画——必须正好 ${panelCount} 个。`;
  }

  // Order: count-first, layout, per-panel listing, consistency rule, references, negatives at end.
  const order = ["lead", "layout", "panels", "consistency", "references", "negative"];
  const composedPrompt = order.map((k) => parts[k]).filter(Boolean).join("\n\n");
  return { composedPrompt, parts, lang };
}

/**
 * Split a free-text scene description into N panel-beat strings.
 *
 * Heuristic: the user often writes time-slot tokens like "0-4s ...", "4-9s ...", "9-15s ..." in
 * their scenePrompt — we parse those and round-robin them into panels. If the count of detected
 * beats doesn't match panelCount, we evenly distribute (interpolate / oversample) so every panel
 * gets a meaningful description. If no time tokens are detected, we mirror the whole scene to all
 * panels (better than empty slots — the consistency rule still anchors them to a continuous moment).
 */
function splitSceneIntoPanels(scenePrompt: string, panelCount: number): string[] {
  const beats = extractTimelineBeats(scenePrompt);
  if (beats.length === 0) {
    // No time markers — fall back to the same blob for every slot. The model still needs SOMETHING
    // per slot or it leaves slots blank.
    return Array.from({ length: panelCount }, () => scenePrompt.trim());
  }
  if (beats.length === panelCount) return beats;
  // Interpolate: pick beats[Math.floor(i / panelCount * beats.length)] so we cover the full arc.
  return Array.from({ length: panelCount }, (_, i) => {
    const idx = Math.min(beats.length - 1, Math.floor((i * beats.length) / panelCount));
    return beats[idx];
  });
}

/**
 * Pull `0-4s … 4-9s … 9-15s …` style time-slot blocks out of a scene description. Returns the
 * text after each time token, stopping at the next time token (or end of string). Empty array if
 * the user didn't structure the prompt this way.
 */
function extractTimelineBeats(scenePrompt: string): string[] {
  const text = scenePrompt.trim();
  // Match "0-4s", "4–9s", "9-15 s", "0~4s", etc. as anchor points.
  const tokenRegex = /(\d+(?:\.\d+)?)\s*[-–~至到]\s*(\d+(?:\.\d+)?)\s*s/g;
  const matches: Array<{ index: number; raw: string }> = [];
  let m;
  while ((m = tokenRegex.exec(text)) !== null) {
    matches.push({ index: m.index, raw: m[0] });
  }
  if (matches.length === 0) return [];
  return matches.map((m, i) => {
    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    return text.slice(start, end).trim().replace(/[；;，,]+$/g, "").trim();
  });
}

export function composeSeedreamMultiFrameGroup(
  scenePrompt: string,
  panelCount: number,
  lang: Lang = DEFAULT_LANG
): PromptComposition {
  // Used by /sessions/:id/storyboard-grid (the multi-frame anchor workflow). The user-provided
  // scenePrompt typically already enumerates the N panels — we just frame it with consistency
  // requirements and the language toggle.
  const parts: Record<string, string> = {};
  if (lang === "en") {
    parts.intro = `Generate ${panelCount} stylistically-consistent storyboard keyframes as a sequential set of separate images. Each frame is one beat in the same continuous story.`;
    parts.consistency = "All frames share identical visual style: identical character identity, identical wardrobe, identical color palette, identical lighting logic, identical film grain.";
    parts.noText = "No on-screen text on any frame. No panel numbers. No captions. No subtitles.";
    parts.scene = scenePrompt;
  } else {
    parts.intro = `请生成 ${panelCount} 张风格一致的故事板关键帧，作为一组互相独立但同源的连续画面。每张是同一故事中按时序排列的一个节拍。`;
    parts.consistency = "全部画面共享同一视觉风格：同一角色身份、同一服装、同一配色、同一光线逻辑、同一胶片颗粒。";
    parts.noText = "**任何画面**上都不要出现屏幕文字、面板编号、字幕。";
    parts.scene = scenePrompt;
  }
  const order = ["intro", "consistency", "noText", "scene"];
  const composedPrompt = order.map((k) => parts[k]).filter(Boolean).join("\n");
  return { composedPrompt, parts, lang };
}
