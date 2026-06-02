import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type UiLanguage = "zh" | "en";

const STORAGE_KEY = "uiLanguage";

const enPlural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

const zh = {
  app: {
    brandSubtitle: "短剧 Agent 工坊",
    newSession: "新建 Session",
    unnamed: "未命名",
    shotCount: (count: number) => `${count} 镜`,
    archiveSessions: "历史 session",
    emptySession: "点上方「新建 Session」开工",
    deleteSessionTitle: "删除 session（不可撤销）",
    promoteSessionTitle: "置顶到当前",
    delete: "删除",
    sessionNameAria: "Session 名称",
    shareTitle: "复制本 session 的可分享链接",
    copiedLink: (url: string) => `已复制链接：${url}`,
    copyPrompt: "复制下面的链接：",
    copyLink: "🔗 复制链接",
    createProjectTitle: "创建一个短片项目",
    languageToggleTitle: "切换界面语言",
    zhLabel: "中文",
    enLabel: "EN",
    visionReview: "自审重试",
    visionReviewTitle: "开启后：每张资产/分镜图、每条分镜视频生成完会用 vision 模型自审，违背 prompt/参考图就重生，最多 5 次。会消耗额外 token。",
    refresh: "刷新",
    usage: "查看用量",
    usageTitle: "查看各 session 的 Seedream / Seedance token 用量",
    serverDownTitle: "⚠ 服务端不可达",
    serverDownBody: "后端 dev server 没响应。检查终端是否还在跑 npm run dev，必要时重启。这条会在后端恢复时自动消失。",
    deleteSessionConfirm: (title: string) => `删除 session「${title}」？此操作不可撤销。`,
    clearTokenUsageConfirm: (title: string) => `清空 session「${title}」的所有节点 token 统计？`,
    createShotUndo: "新建分镜",
    deleteUndo: (label: string) => `删除${label}`,
    pendingVideoName: "上传中视频",
    pendingUpload: "上传中…",
    uploadFailed: "上传失败",
    uploadFailedWithMessage: (message: string) => `上传失败：${message}`
  },
  token: {
    summary: (input: string, output: string, calls: number) => `输入 ${input} · 输出 ${output} · ${calls} 次调用`,
    clear: "清空统计",
    clearTitle: "清空本 session 的所有节点 token 统计",
    calls: (count: number) => `${count} 次`,
    total: "合计",
    noTrackedFamilies: "还没有 session 记录到这四类模型的 token usage。",
    noUsage: "还没有记录到模型 token usage；生成图片/视频后会自动出现。",
    recentOp: (count: number, op: string) => `${count} 次 · 最近 ${op}`
  },
  flow: {
    emptyTitle: "这里是节点画布",
    emptyHint: "← 左侧侧栏点「新建 Session」或选一个已有 session",
    summary: (shots: number, duration: number | undefined, language: UiLanguage) => `${shots} 个分镜 · 目标 ${duration ?? 0}s · 语言 ${language} · `,
    createNodeHint: "右键空白处可新建节点",
    undo: "↶ 撤销",
    redo: "↷ 恢复",
    undoTitle: (description?: string) => description ? `撤销「${description}」(⌘Z)` : "没有可撤销的操作",
    redoTitle: (description?: string) => description ? `恢复「${description}」(⇧⌘Z)` : "没有可恢复的操作",
    createCharacter: "+ 角色",
    createScene: "+ 场景",
    createShot: "+ 分镜",
    uploadVideo: "+ 上传视频",
    createCharacterTitle: "新建一个角色资产做跨分镜的身份锚",
    createSceneTitle: "新建一个场景资产做跨分镜的环境锚",
    createShotTitle: "新增一个分镜（同时派生分镜板 + 视频节点）",
    uploadVideoTitle: "上传一段视频文件作为参考。会自动 AI 拆分镜表；也可拖到 Shot 上做 Seedance reference_video。",
    executeFast: "加速执行",
    executing: "执行中...",
    executeFastTitle: "先生成执行计划；无依赖的镜头并发跑，有尾帧/参考上游依赖的镜头按拓扑顺序等待。默认只补齐缺失/失败/正在生成的节点。",
    stitchByConnections: "按连接顺序拼接",
    stitchAll: "拼接全片",
    zoomControlsAria: "画布缩放控制",
    minimapTitle: "画布缩略图",
    legendAssets: "角色/场景",
    legendStoryboard: "分镜板",
    legendVideo: "视频",
    legendFinal: "成片",
    minimapHint: "= 你看到的范围 · 拖动它移动画布",
    zoom: "缩放",
    zoomHint: "＋ 放大 · − 缩小 · ⤢ 全景",
    canvasHint: "双击空白 = 回到全景 · 右键空白 = 新建节点 · 滚轮缩放 0.1–4×"
  },
  menu: {
    aria: "新建节点",
    title: "新建节点",
    hint: "右键空白处呼出",
    character: "角色锚",
    characterHint: "跨分镜复用同一张脸，C",
    scene: "场景锚",
    sceneHint: "跨分镜复用同一个场景，S",
    shot: "分镜镜头",
    shotHint: "新增一镜，自动派生分镜板 + 视频，N",
    stitch: "拼接节点",
    stitchHint: "手动放置完整视频拼接入口，J",
    uploadCharacter: "上传图 → 角色",
    uploadCharacterHint: "本地图片作为角色锚，U",
    uploadScene: "上传图 → 场景",
    uploadSceneHint: "本地图片作为场景锚，V",
    uploadVideo: "上传参考视频",
    uploadVideoHint: "本地视频，拖到 shot 上做参考视频，R"
  },
  nodes: {
    modelPickerTitle: "选择模型版本",
    download: "下载",
    assetTypes: { character: "角色", scene: "场景", prop: "道具", style: "风格", other: "其它" },
    statusDraft: "草稿",
    statusScripted: "已写脚本",
    statusQueued: "Seedance 排队中",
    statusRunning: "Seedance 渲染中",
    statusGenerating: "生成中",
    statusReady: "已完成",
    statusError: "出错",
    statusCancelled: "已取消",
    reviewStale: "VLM 已过期",
    reviewRunning: "VLM 审核中",
    reviewError: "VLM 失败",
    reviewNeedsFix: (score: number) => `VLM ${Math.round(score)} 需修`,
    reviewPass: (score: number) => `VLM ${Math.round(score)} ✓`,
    reviewNotRun: "VLM 未审",
    generating: "生成中",
    pendingAssetTitle: "自审重试 + Seedream 单轮 ≈ 30-40s，最多 5 轮",
    reviewImageTitle: "对当前图片做 VLM 评分",
    downloadOriginalImage: (name: string) => `下载 ${name} 原图`,
    notGenerated: "未生成",
    seedreamReviewHint: "Seedream + 自审重试，最长 ~3 分钟",
    nextAssetModelTitle: "该资产下次「重新出图」使用的模型",
    reviewAttempts: (count: number) => `自审重试 ${count}`,
    storyboard: "分镜板",
    storyboardPendingTitle: "Seedream 生成分镜板 + 自审，可能 30s-2min",
    downloadStoryboard: "下载分镜板原图",
    storyboardEmpty: "未生成 · 点开右侧编辑",
    storyboardHint: "Seedream 分镜板，最长 ~2 分钟",
    nextStoryboardModelTitle: "该分镜板下次「重新出图」使用的 Seedream 版本",
    panelCount: (count: number) => `${count} 面板`,
    refImageCount: (count: number) => `参考图 ${count}`,
    video: "视频",
    reviewShotTitle: "用多帧 VLM 标准审核这一镜",
    downloadShot: "下载这一镜的 mp4",
    tailframe: "尾帧",
    tailframeTitle: "从当前视频抽取尾帧，在画布上生成可连接的尾帧节点",
    elapsed: (value: string) => `已用时 ${value}`,
    nextSeedanceModelTitle: "该镜头下次「生成视频」使用的 Seedance 版本",
    stitch: "拼接",
    stitched: "已拼接",
    stitching: "拼接中",
    stitchError: "出错",
    notStitched: "未拼接",
    connectedSegmentsHint: (count: number) => `已连接 ${count} 段，点开按顺序拼接`,
    stitchEmptyHint: "连接视频到这里，或点开按分镜顺序拼接",
    fullVideo: "完整视频",
    finalReview: "终审",
    finalReviewTitle: "用多帧 VLM 标准审核完整片",
    downloadFinal: "下载完整片",
    targetDuration: (seconds: number | undefined) => `${seconds ?? 0}s 目标`,
    referenceVideo: "参考视频",
    parsing: "解析中",
    parsedShots: (count: number) => `已解析 ${count} 镜`,
    parseFailed: "解析失败",
    parsePending: "待解析",
    downloadReferenceVideo: "下载参考视频",
    notUploaded: "未上传",
    applyParsedHint: "从这里把镜头分析\"应用到\"右侧某条 shot",
    videoProcessor: "视频处理",
    trim15: "截前 15s",
    speedup: "整体加速",
    sampleConcat: "多段拼接",
    unclipped: "未裁剪",
    downloadClip: "下载裁剪结果",
    source: (name: string) => `源：${name}`,
    notExtracted: "未抽取",
    frameAnchor: "帧锚点",
    fromShot: (title: string) => `来自 ${title}`,
    usedBy: (titles: string) => `用于 ${titles}`,
    dragToVideo: "拖到视频节点作为首帧"
  },
  toast: {
    downloadStarted: "已开始下载",
    undone: "已撤销",
    redone: "已恢复",
    undoFailed: (message: string) => `撤销失败：${message}`,
    redoFailed: (message: string) => `恢复失败：${message}`
  },
  lightbox: {
    preview: "预览",
    downloadOriginal: "下载原文件",
    download: "下载",
    close: "关闭",
    videoFailed: "视频在浏览器内无法直接播放。",
    openNewTab: "在新标签页打开",
    downloadLocal: "下载到本地"
  },
  mention: {
    aria: "@-mention suggestions",
    wired: "已连",
    empty: "没有匹配的资产 — 按 Esc 关闭，或先连一个进来"
  },
  errors: {
    operationFailed: "操作失败",
    unknown: "未知错误",
    networkDown: "网络中断 / 服务端可能挂了 — 检查终端是否还在跑 dev server，必要时重启后重试"
  }
};

export type Dictionary = typeof zh;

const en: Dictionary = {
  app: {
    brandSubtitle: "Agent-native Drama Studio",
    newSession: "New Session",
    unnamed: "Untitled",
    shotCount: (count) => enPlural(count, "shot"),
    archiveSessions: "Past sessions",
    emptySession: "Click “New Session” above to start",
    deleteSessionTitle: "Delete session (cannot be undone)",
    promoteSessionTitle: "Pin as current",
    delete: "Delete",
    sessionNameAria: "Session name",
    shareTitle: "Copy shareable link for this session",
    copiedLink: (url) => `Link copied: ${url}`,
    copyPrompt: "Copy this link:",
    copyLink: "🔗 Copy link",
    createProjectTitle: "Create a short film project",
    languageToggleTitle: "Switch UI language",
    zhLabel: "中文",
    enLabel: "EN",
    visionReview: "Self-review retry",
    visionReviewTitle: "When enabled, generated assets/storyboards/videos are reviewed by a vision model and regenerated if they miss the prompt/reference, up to 5 times. Uses extra tokens.",
    refresh: "Refresh",
    usage: "Usage",
    usageTitle: "View Seedream / Seedance token usage by session",
    serverDownTitle: "⚠ Server unreachable",
    serverDownBody: "The backend dev server is not responding. Check whether npm run dev is still running and restart if needed. This banner disappears automatically when the backend recovers.",
    deleteSessionConfirm: (title) => `Delete session “${title}”? This cannot be undone.`,
    clearTokenUsageConfirm: (title) => `Clear token usage for all nodes in session “${title}”?`,
    createShotUndo: "Create shot",
    deleteUndo: (label) => `Delete ${label}`,
    pendingVideoName: "Uploading video",
    pendingUpload: "Uploading…",
    uploadFailed: "Upload failed",
    uploadFailedWithMessage: (message) => `Upload failed: ${message}`
  },
  token: {
    summary: (input, output, calls) => `Input ${input} · output ${output} · ${enPlural(calls, "call")}`,
    clear: "Clear stats",
    clearTitle: "Clear token stats for all nodes in this session",
    calls: (count) => enPlural(count, "call"),
    total: "Total",
    noTrackedFamilies: "No session has recorded token usage for these model families yet.",
    noUsage: "No model token usage recorded yet; it will appear after image/video generation.",
    recentOp: (count, op) => `${enPlural(count, "call")} · latest ${op}`
  },
  flow: {
    emptyTitle: "This is the node canvas",
    emptyHint: "← Click “New Session” in the sidebar or select an existing session",
    summary: (shots, duration, language) => `${enPlural(shots, "shot")} · target ${duration ?? 0}s · language ${language === "en" ? "English" : "Chinese"} · `,
    createNodeHint: "Right-click empty space to create nodes",
    undo: "↶ Undo",
    redo: "↷ Redo",
    undoTitle: (description?: string) => description ? `Undo “${description}” (⌘Z)` : "Nothing to undo",
    redoTitle: (description?: string) => description ? `Redo “${description}” (⇧⌘Z)` : "Nothing to redo",
    createCharacter: "+ Character",
    createScene: "+ Scene",
    createShot: "+ Shot",
    uploadVideo: "+ Upload video",
    createCharacterTitle: "Create a character asset as an identity anchor across shots",
    createSceneTitle: "Create a scene asset as an environment anchor across shots",
    createShotTitle: "Add a shot and derive storyboard + video nodes",
    uploadVideoTitle: "Upload a reference video. It will be analyzed into shots and can be dragged onto a Shot as Seedance reference_video.",
    executeFast: "Run workflow",
    executing: "Running...",
    executeFastTitle: "Plan execution first; independent shots run in parallel while tailframe/upstream dependencies wait topologically. By default only missing/failed/in-progress nodes are filled.",
    stitchByConnections: "Stitch connected order",
    stitchAll: "Stitch full film",
    zoomControlsAria: "Canvas zoom controls",
    minimapTitle: "Canvas minimap",
    legendAssets: "Characters/scenes",
    legendStoryboard: "Storyboard",
    legendVideo: "Video",
    legendFinal: "Final",
    minimapHint: "= current viewport · drag it to pan",
    zoom: "Zoom",
    zoomHint: "+ zoom in · − zoom out · ⤢ fit view",
    canvasHint: "Double-click empty space = fit view · right-click empty space = create node · wheel zoom 0.1–4×"
  },
  menu: {
    aria: "Create node",
    title: "Create node",
    hint: "Open by right-clicking empty space",
    character: "Character anchor",
    characterHint: "Reuse one face across shots, C",
    scene: "Scene anchor",
    sceneHint: "Reuse one environment across shots, S",
    shot: "Shot",
    shotHint: "Add one shot and derive storyboard + video, N",
    stitch: "Stitch node",
    stitchHint: "Manually place a final-video stitch entry, J",
    uploadCharacter: "Upload image → Character",
    uploadCharacterHint: "Use a local image as character anchor, U",
    uploadScene: "Upload image → Scene",
    uploadSceneHint: "Use a local image as scene anchor, V",
    uploadVideo: "Upload reference video",
    uploadVideoHint: "Local video; drag to a shot as reference video, R"
  },
  nodes: {
    modelPickerTitle: "Choose model version",
    download: "Download",
    assetTypes: { character: "Character", scene: "Scene", prop: "Prop", style: "Style", other: "Other" },
    statusDraft: "Draft",
    statusScripted: "Scripted",
    statusQueued: "Seedance queued",
    statusRunning: "Seedance rendering",
    statusGenerating: "Generating",
    statusReady: "Ready",
    statusError: "Error",
    statusCancelled: "Cancelled",
    reviewStale: "VLM stale",
    reviewRunning: "VLM reviewing",
    reviewError: "VLM failed",
    reviewNeedsFix: (score) => `VLM ${Math.round(score)} needs fixes`,
    reviewPass: (score) => `VLM ${Math.round(score)} ✓`,
    reviewNotRun: "VLM not run",
    generating: "Generating",
    pendingAssetTitle: "Self-review + Seedream is ~30–40s per round, up to 5 rounds",
    reviewImageTitle: "Score this image with VLM",
    downloadOriginalImage: (name) => `Download original image for ${name}`,
    notGenerated: "Not generated",
    seedreamReviewHint: "Seedream + self-review retry, up to ~3 minutes",
    nextAssetModelTitle: "Model used next time this asset is regenerated",
    reviewAttempts: (count) => `Self-review retries ${count}`,
    storyboard: "Storyboard",
    storyboardPendingTitle: "Seedream storyboard + review, maybe 30s–2min",
    downloadStoryboard: "Download storyboard image",
    storyboardEmpty: "Not generated · open the Inspector to edit",
    storyboardHint: "Seedream storyboard, up to ~2 minutes",
    nextStoryboardModelTitle: "Seedream version used next time this storyboard is regenerated",
    panelCount: (count) => enPlural(count, "panel"),
    refImageCount: (count) => `${enPlural(count, "reference image")}`,
    video: "Video",
    reviewShotTitle: "Review this shot with multi-frame VLM standards",
    downloadShot: "Download this shot mp4",
    tailframe: "Tail frame",
    tailframeTitle: "Extract the current video's tail frame as a connectable canvas node",
    elapsed: (value) => `Elapsed ${value}`,
    nextSeedanceModelTitle: "Seedance version used next time this shot is generated",
    stitch: "Stitch",
    stitched: "Stitched",
    stitching: "Stitching",
    stitchError: "Error",
    notStitched: "Not stitched",
    connectedSegmentsHint: (count) => `${enPlural(count, "connected segment")} · open to stitch in order`,
    stitchEmptyHint: "Connect videos here, or open to stitch by shot order",
    fullVideo: "Full video",
    finalReview: "Final review",
    finalReviewTitle: "Review the full film with multi-frame VLM standards",
    downloadFinal: "Download full film",
    targetDuration: (seconds) => `${seconds ?? 0}s target`,
    referenceVideo: "Reference video",
    parsing: "Parsing",
    parsedShots: (count) => `Parsed ${enPlural(count, "shot")}`,
    parseFailed: "Parse failed",
    parsePending: "Pending parse",
    downloadReferenceVideo: "Download reference video",
    notUploaded: "Not uploaded",
    applyParsedHint: "Apply parsed shot analysis from here to a shot on the right",
    videoProcessor: "Video processor",
    trim15: "Trim first 15s",
    speedup: "Speed up full clip",
    sampleConcat: "Sample concat",
    unclipped: "Unclipped",
    downloadClip: "Download clip result",
    source: (name) => `Source: ${name}`,
    notExtracted: "Not extracted",
    frameAnchor: "Frame anchor",
    fromShot: (title) => `From ${title}`,
    usedBy: (titles) => `Used by ${titles}`,
    dragToVideo: "Drag to a video node as first frame"
  },
  toast: {
    downloadStarted: "Download started",
    undone: "Undone",
    redone: "Redone",
    undoFailed: (message) => `Undo failed: ${message}`,
    redoFailed: (message) => `Redo failed: ${message}`
  },
  lightbox: {
    preview: "Preview",
    downloadOriginal: "Download original file",
    download: "Download",
    close: "Close",
    videoFailed: "This video cannot be played directly in the browser.",
    openNewTab: "Open in new tab",
    downloadLocal: "Download locally"
  },
  mention: {
    aria: "@-mention suggestions",
    wired: "wired",
    empty: "No matching assets — press Esc to close, or connect one first"
  },
  errors: {
    operationFailed: "Operation failed",
    unknown: "Unknown error",
    networkDown: "Network interrupted / server may be down — check whether the dev server is still running and restart if needed"
  }
};

const dictionaries: Record<UiLanguage, Dictionary> = { zh, en };

let currentUiLanguage: UiLanguage = "zh";

function normalizeLanguage(value: unknown): UiLanguage | undefined {
  return value === "en" || value === "zh" ? value : undefined;
}

function readStoredLanguage(): UiLanguage {
  if (typeof window === "undefined") return "zh";
  return normalizeLanguage(window.localStorage.getItem(STORAGE_KEY)) || "zh";
}

export function getCurrentUiLanguage() {
  return currentUiLanguage;
}

export function getDictionary(lang: UiLanguage = currentUiLanguage) {
  return dictionaries[lang];
}

export function networkDownMessage() {
  return getDictionary().errors.networkDown;
}

interface I18nContextValue {
  lang: UiLanguage;
  setLang: (lang: UiLanguage) => void;
  toggleLang: () => void;
  t: Dictionary;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<UiLanguage>(() => readStoredLanguage());

  useEffect(() => {
    currentUiLanguage = lang;
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, lang);
    if (typeof document !== "undefined") document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  const value = useMemo<I18nContextValue>(() => ({
    lang,
    setLang: setLangState,
    toggleLang: () => setLangState((value) => (value === "zh" ? "en" : "zh")),
    t: dictionaries[lang]
  }), [lang]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}
