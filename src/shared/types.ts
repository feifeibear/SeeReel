export type AssetType = "character" | "scene" | "prop" | "style" | "other";
export type AssetMediaKind = "image" | "video" | "none";
export type AssetImageModel = "gpt-image-2" | "seedream-4" | "seedream-4-5" | "seedream-5-lite";
export type StandardApiKeyRoute = "byteplus" | "volcengine-cn";
/** Seedream-only subset of AssetImageModel that the sub-storyboard endpoint supports (no gpt-image-2). */
export type SubStoryboardModel = "seedream-4" | "seedream-4-5" | "seedream-5-lite";

export type SessionLanguage = "zh" | "en";

export type ShotStatus = "draft" | "scripted" | "generating" | "ready" | "error" | "cancelled";
export type SeedanceVariant = "fast" | "standard";
/**
 * Sub-phase of a `generating` shot/render so the UI can distinguish "still queued at Seedance"
 * (the task is accepted but no GPU has picked it up yet — common during peak hours, can sit for
 * many minutes) from "actively rendering" (a worker is producing frames now). Derived from the
 * raw Seedance task status on each poll tick:
 *   - `queued` ← Seedance "queued" / "in_queue" / "pending" / "submitted"
 *   - `running` ← Seedance "running" / "processing" / "generating"
 * Cleared (undefined) when the shot/render reaches a terminal state.
 */
export type SeedancePhase = "queued" | "running";

export type VideoReviewStatus = "idle" | "running" | "ready" | "error";
export type VideoReviewScope = "asset" | "shot" | "session_final";
export type ImageReviewScope = "asset" | "sketch";

export interface VideoReviewCriterionScore {
  key: string;
  label: string;
  score: number;
  weight?: number;
  reason: string;
  evidenceFrames?: number[];
}

export interface VideoReviewFix {
  shot?: number;
  frame?: number;
  action: string;
}

export interface VideoReviewVerdict {
  scope: VideoReviewScope;
  ok: boolean;
  score: number;
  summary: string;
  criteria: VideoReviewCriterionScore[];
  fatalIssues: string[];
  reasons: string[];
  fixes: VideoReviewFix[];
  hookRetention?: string;
  audio?: "not_evaluated" | "present_ok" | "problem" | string;
  frameEvidence?: string[];
  model: string;
  rawText?: string;
  reviewedAt: string;
  frameCount: number;
  durationSec?: number;
  videoSignature?: string;
  tokenUsage?: TokenUsageBreakdown;
}

export interface ImageReviewVerdict {
  scope: ImageReviewScope;
  ok: boolean;
  score: number;
  summary: string;
  criteria: VideoReviewCriterionScore[];
  fatalIssues: string[];
  reasons: string[];
  fixes: VideoReviewFix[];
  model: string;
  rawText?: string;
  reviewedAt: string;
  imageSignature?: string;
  tokenUsage?: TokenUsageBreakdown;
}

export interface TokenUsageBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
}

export type TokenUsageNodeType = "session" | "asset" | "shot" | "stitch" | "review" | "other";
export type TokenUsageModelFamily = "seedream-4" | "seedream-4-5" | "seedream-5-lite" | "seedance-2-0" | "seedance-2-0-fast" | "other";

export interface TokenUsageEvent extends TokenUsageBreakdown {
  id: string;
  sessionId: string;
  nodeId: string;
  nodeType: TokenUsageNodeType;
  nodeLabel?: string;
  operation: string;
  provider?: string;
  model?: string;
  modelFamily?: TokenUsageModelFamily;
  note?: string;
  rawUsage?: unknown;
  createdAt: string;
}

export interface VideoReviewRepairTarget {
  kind: "asset" | "shot" | "storyboard";
  id: string;
  reason: string;
  promptPatch: string;
}

export interface VideoReviewRepairPlan {
  createdAt: string;
  sourceReviewScope: VideoReviewScope;
  sourceNodeId: string;
  targets: VideoReviewRepairTarget[];
  appliedAt?: string;
}

/**
 * One row of the reference-video shot-table analysis. The vision LLM breaks the source video
 * into discrete shots and emits, per shot, a
 * structured prompt-bundle that any downstream Seedance / Storyboard call can reuse.
 */
export interface ParsedShotEntry {
  index: number;
  /** Start of this shot inside the source video, seconds. */
  timeStart: number;
  /** End of this shot inside the source video, seconds. */
  timeEnd: number;
  /** Human label like "远景 / 全景 / 中景 / 中近景 / 特写 / 极特写". */
  shotType: string;
  /** Plain-language description of what's on screen (画面内容). */
  sceneContent: string;
  /** Drop-in image prompt for re-generating this shot's first frame. */
  imagePrompt: string;
  /** Drop-in camera prompt for animating it (推/拉/摇/移/跟/旋转/手持/固定 + speed). */
  cameraPrompt: string;
  /** Reusable style notes (光影 / 色调 / 胶片质感) — usually shared across shots. */
  styleNotes?: string;
}

export interface StoryCharacter {
  name: string;
  role: string;
  arc: string;
  assetId?: string;
  assetMention?: string;
}

export interface StoryBeat {
  index: number;
  title: string;
  purpose: string;
  plot: string;
  emotion: string;
  visual: string;
  assetMentions: string[];
  durationSec: number;
}

export interface StoryPlan {
  premise: string;
  synopsis: string;
  theme: string;
  tone: string;
  characters: StoryCharacter[];
  beats: StoryBeat[];
  locked: boolean;
  updatedAt?: string;
  model?: string;
}

export interface Asset {
  id: string;
  /** Anonymous demo owner. Used by public deployments to keep visitors' canvases isolated. */
  ownerUserId?: string;
  name: string;
  type: AssetType;
  mediaKind: AssetMediaKind;
  description: string;
  prompt: string;
  mediaUrl?: string;
  imageUrl?: string;
  referenceImageUrl?: string;
  tosObjectKey?: string;
  tosPublishedAt?: string;
  tags: string[];
  /**
   * Optional parent asset id. When set, image generation will pass the parent's reference image as
   * a conditioning input to the generator, so derived variants (e.g. younger / older / different
   * outfit versions of the same character) keep the parent's facial identity.
   */
  parentAssetId?: string;
  /**
   * Optional owning shot id. When set, this asset is a private "shot-scoped sketch" that:
   *   - is NOT shown in the global Asset Library UI
   *   - is NOT picked up by other shots' @mention scanning
   *   - is automatically deleted when the owning shot (or its session) is deleted
   * Typical usage: per-shot storyboard sketches generated by Seedream that act as reference_image
   * input to the Seedance video generator for that one shot only.
   */
  ownerShotId?: string;
  /**
   * Optional owning session id. When set, this asset is "session-scoped":
   *   - it IS visible in the Asset Library UI, but only while that session is open
   *   - other sessions' shots cannot @mention it
   *   - it is cascade-deleted when the owning session is deleted
   *   - it can be promoted to a global asset (POST /api/assets/:id/promote), which clears this
   *     field — afterwards it behaves like any other global asset and survives session deletion.
   * If both ownerShotId and ownerSessionId are set, ownerShotId wins (it's the more specific
   * private-sketch scope) and ownerSessionId is informational.
  */
  ownerSessionId?: string;
  /** Debug metadata for generated images/storyboards: which asset ids were used as visual refs. */
  referenceAssetIds?: string[];
  /** Debug metadata for generated images/storyboards: exact image URLs sent as visual refs. */
  referenceImageUrls?: string[];
  /** Debug metadata for generated images/storyboards: image model selected by the caller. */
  generationModel?: AssetImageModel;
  /** Debug metadata for generated images/storyboards: concrete provider model id that actually ran. */
  generationModelActual?: string;
  /** Debug metadata for generated images/storyboards: credential route used for the last generation. */
  generationCredentialSource?: "standard" | "agent-plan" | "missing";
  /**
   * Reference-video analysis result. When this asset is a video the user uploaded as a reference,
   * the server runs ffmpeg + vision LLM to break it down
   * into a shot-by-shot table. Each entry can be applied to any shot in the current session as a
   * starting prompt draft. Asset is recognized as a reference video when `tags` contains
   * `"reference-video"`.
   */
  parsedShots?: ParsedShotEntry[];
  /**
   * Status of the reference-video parse pipeline. Set to `"parsing"` while ffmpeg + vision LLM are
   * running; `"ready"` when `parsedShots` is populated; `"error"` when the LLM call failed (the
   * server still saves the raw response to `parsedShotsError` for debugging).
   */
  parseStatus?: "idle" | "parsing" | "ready" | "error";
  parseError?: string;
  /**
   * Reference-video clip metadata: which condensing strategy is currently applied to make the
   * source fit Seedance r2v's 15.2s ceiling, plus the source vs. clipped durations for UI
   * display. `clipStrategy="none"` means the source already fit (no clipping ran). Absent on
   * non-video assets.
   */
  clipStrategy?: "sample-concat" | "trim" | "speedup" | "none";
  originalDurationSec?: number;
  clipDurationSec?: number;
  /**
   * When set, this asset is a derivative of another asset — typically a clipped / processed
   * version of a reference video. The source asset id lives here; the canvas renders this asset
   * as a `videoProcessor` node downstream of the source instead of as a top-level reference.
   * Created by `POST /api/assets/:sourceId/derive-clip`. Multiple derivatives of the same source
   * coexist: each gets its own asset id, its own clipStrategy, and may be bound to different
   * shots independently of the source.
   */
  derivedFromAssetId?: string;
  /**
   * Vision-review trail. `reviewAttempts` is the number of *additional* generations triggered by
   * the self-review loop (0 = first product passed or review was disabled). `reviewNote` is the
   * concatenated reasons recorded when at least one attempt failed; absence of `reviewNote` means
   * the run either passed first try or review was off. `reviewModel` records which vision model
   * issued the verdict (for debugging / cost tracing).
   */
  reviewNote?: string;
  reviewAttempts?: number;
  reviewModel?: string;
  vlmReviewEnabled?: boolean;
  imageReviewStatus?: VideoReviewStatus;
  imageReview?: ImageReviewVerdict;
  imageReviewError?: string;
  imageReviewUpdatedAt?: string;
  /** Prompt snapshot the latest image VLM review evaluated against. */
  imageReviewBuiltForPrompt?: string;
  videoReviewRepairPlan?: VideoReviewRepairPlan;
  /** ISO time when the current generated image media was produced. Uploads/imports may leave it unset. */
  generatedAt?: string;
  /** The exact Seedream prompt that produced the most-recent media on this asset (audit trail). */
  composedPrompt?: string;
  /**
   * Editable Seedream prompt draft. When the user previews via dryRun and tweaks the textarea,
   * we persist their edit here so a refresh / reopen still shows the manual edit. The next
   * non-dryRun generate call uses this verbatim if present; otherwise the server re-composes.
   */
  composedPromptDraft?: string;
  updatedAt: string;
  createdAt: string;
}

export interface Shot {
  id: string;
  sessionId: string;
  index: number;
  title: string;
  script: string;
  camera: string;
  durationSec: number;
  storyBeatIndex?: number;
  assetIds: string[];
  rawPrompt?: string;
  prompt: string;
  debugNote?: string;
  seedanceVariant?: SeedanceVariant;
  /**
   * Optional model variant to use when (re)generating this shot's sub-storyboard grid. Persisted
   * so the in-canvas picker has a stable source of truth and Inspector "重新出图" honors it.
   * Defaults to "seedream-4-5" on the server when unset.
   */
  subStoryboardModel?: SubStoryboardModel;
  usePreviousShotClip?: boolean;
  previousShotClipSec?: number;
  previousShotClipSecOverride?: boolean;
  referenceClipUrl?: string | null;
  referenceAudioUrl?: string | null;
  referenceClipPreviewUrl?: string | null;
  referenceAudioPreviewUrl?: string | null;
  /**
   * Optional asset id that should be used as the first frame of this shot. When set, the shot enters
   * Seedance "first-frame" mode and reference_image / reference_video / reference_audio are dropped
   * from the payload (per BytePlus ModelArk docs - first/last frame mode cannot be combined with
   * other reference media). Primarily intended for shot 1 of a session, but allowed on any shot;
   * when present it takes precedence over `usePreviousShotClip`.
   */
  firstFrameAssetId?: string;
  /**
   * Optional asset id used as the LAST frame of this shot. Combined with `firstFrameAssetId` it
   * activates Seedance "first-and-last frame" I2V: the model interpolates motion from frame N to
   * frame N+1. Like first-frame mode it is mutually exclusive with reference_image/video/audio.
   * Used by the storyboard-grid workflow where N+1 consistent frames drive N transitions.
   */
  lastFrameAssetId?: string;
  /**
   * Sub-shot storyboard mode (EvoLink GPT-Image-2 / Seedance 2.0 community technique). When set
   * to a positive integer, this single Seedance call is told to read the attached storyboard grid
   * image as a TIMELINE of N sub-panels (left→right, top→bottom) and produce ONE video that
   * internally cuts between those N moments. Not first-frame mode — the grid is passed as a
   * normal reference_image, and the prompt builder appends the magic sequencing instruction
   * "Follow the storyboard sequence of the N reference frames in image1, edited as a fast-cut..."
   * which Seedance recognizes as a request for an internal multi-shot edit. Mutually exclusive
   * with first/last-frame I2V.
   */
  subShotPanelCount?: number;
  /**
   * Asset id of the *primary* sub-storyboard grid image — the one this shot's own /sub-storyboard
   * call produced. Treated as the lead reference for sub-shot mode. Kept as a single field for
   * back-compat with renders / snapshots / older shots; new wiring should also populate the plural
   * `subShotStoryboardAssetIds` below.
   */
  subShotStoryboardAssetId?: string;
  /**
   * Full set of sub-storyboard grid asset ids that drive this shot's video. Allows N-to-1 wiring:
   * the user (or AI) can drag an edge from another shot's storyboard node onto this Shot to use
   * it as an additional reference. The first id is normally `subShotStoryboardAssetId` (the
   * shot's own grid), with extras appended in connection order. Empty / unset = legacy 1:1 path.
   */
  subShotStoryboardAssetIds?: string[];
  /**
   * Reference-video remake mode: when set, points at a `reference-video` tagged Asset whose
   * remote (TOS) `mediaUrl` is sent to Seedance as a `reference_video` content. Seedance uses
   * the reference video's motion / shot language / pacing as the structural baseline and
   * rewrites the subject according to the text prompt (e.g. "main character is a rabbit").
   * Mutually exclusive with first/last-frame and sub-shot modes — those use the same content
   * slot and would conflict. Cleared automatically when the user enters those other modes.
   */
  referenceVideoAssetId?: string;
  /**
   * Cross-shot reference: another shot in the same session whose rendered video is used as this
   * shot's `reference_video`. Lets the user wire a generated shot directly into a downstream
   * shot's reference-video slot without first materializing an Asset row. Resolved at submit time
   * by reading `sourceShot.videoUrl` / `sourceShot.remoteVideoUrl`. Mutually exclusive with first
   * /last-frame, sub-shot grid, and `referenceVideoAssetId` — same content slot.
   */
  referenceVideoFromShotId?: string;
  /** User-edited draft of the Seedance prompt (full assembled text content). Submit uses this verbatim if present. */
  composedSeedancePromptDraft?: string;
  /** User-edited draft of the Seedream prompt for sub-storyboard / sketches. */
  composedSeedreamPromptDraft?: string;
  videoUrl?: string;
  renders?: ShotRender[];
  generationTaskId?: string | null;
  generationModel?: string;
  generationStartedAt?: string | null;
  /** ISO time when the current selected shot video finished generating. */
  videoGeneratedAt?: string;
  /**
   * Sub-phase of `status === "generating"` derived from the latest Seedance poll. The shot stays
   * in `generating` while the task is queued OR running; this field tells the UI which one. See
   * `SeedancePhase`. Cleared on terminal transition.
   */
  seedancePhase?: SeedancePhase;
  status: ShotStatus;
  error?: string | null;
  videoReviewStatus?: VideoReviewStatus;
  videoReview?: VideoReviewVerdict;
  videoReviewError?: string;
  videoReviewUpdatedAt?: string;
  /** Prompt snapshot the latest top-level video VLM review evaluated against. */
  videoReviewBuiltForPrompt?: string;
  vlmReviewEnabled?: boolean;
  videoReviewRepairPlan?: VideoReviewRepairPlan;
  updatedAt: string;
  createdAt: string;
}

export interface ShotRender {
  id: string;
  model: string;
  prompt: string;
  status?: ShotStatus;
  title?: string;
  durationSec?: number;
  seedanceVariant?: SeedanceVariant;
  assetIds?: string[];
  rawPrompt?: string;
  usePreviousShotClip?: boolean;
  previousShotClipSec?: number;
  previousShotClipSecOverride?: boolean;
  referenceClipUrl?: string;
  referenceAudioUrl?: string;
  referenceClipPreviewUrl?: string;
  referenceAudioPreviewUrl?: string;
  /** Snapshot of `Shot.firstFrameAssetId` at the time the render was submitted. */
  firstFrameAssetId?: string;
  /** Snapshot of `Shot.lastFrameAssetId` at the time the render was submitted. */
  lastFrameAssetId?: string;
  /** Snapshot of `Shot.subShotPanelCount` at the time the render was submitted. */
  subShotPanelCount?: number;
  /** Snapshot of `Shot.subShotStoryboardAssetId` at the time the render was submitted. */
  subShotStoryboardAssetId?: string;
  /** Snapshot of `Shot.subShotStoryboardAssetIds` at the time the render was submitted. */
  subShotStoryboardAssetIds?: string[];
  /** Snapshot of `Shot.referenceVideoAssetId` at the time the render was submitted. */
  referenceVideoAssetId?: string;
  /** Snapshot of `Shot.referenceVideoFromShotId` at the time the render was submitted. */
  referenceVideoFromShotId?: string;
  videoUrl?: string;
  remoteVideoUrl?: string;
  generationTaskId?: string | null;
  generationStartedAt?: string | null;
  /** ISO time when this render finished generating successfully. */
  videoGeneratedAt?: string;
  /** Sub-phase of `status === "generating"` derived from the latest Seedance poll. */
  seedancePhase?: SeedancePhase;
  error?: string | null;
  note?: string;
  /** See `Asset.reviewNote/reviewAttempts/reviewModel`. */
  reviewNote?: string;
  reviewAttempts?: number;
  reviewModel?: string;
  videoReviewStatus?: VideoReviewStatus;
  videoReview?: VideoReviewVerdict;
  videoReviewError?: string;
  videoReviewUpdatedAt?: string;
  /** Prompt snapshot the latest video VLM review evaluated against. */
  videoReviewBuiltForPrompt?: string;
  /** The exact Seedance text content actually submitted for this render (audit trail). */
  composedPrompt?: string;
  /**
   * Prompt edits saved while this render is still in flight. The already-submitted Seedance task
   * cannot be mutated, but VLM review and auto-retry should follow the user's latest saved intent.
   */
  editedRawPrompt?: string;
  editedPrompt?: string;
  editedComposedPrompt?: string;
  /** Reference-image URLs actually submitted to Seedance for this render. */
  submittedReferenceImageUrls?: string[];
  /**
   * Whether vision-review + auto-retry is active for this render. Decided at submission time so
   * polling-driven retries inherit the original setting and the user can flip the global switch
   * mid-flight without affecting in-flight renders.
   */
  reviewEnabled?: boolean;
  /** Max total attempts (1-5). Already includes the first attempt. */
  reviewMaxAttempts?: number;
  /**
   * Snapshot of the per-shot `generateAudio` override at submission time. `true` forces audio on,
   * `false` forces audio off, `undefined` falls through to env default. Persisted so review-driven
   * retries on the same render inherit the original audio choice.
   */
  generateAudio?: boolean;
  createdAt: string;
}

export type StitchStatus = "idle" | "running" | "ready" | "error";

export interface StitchJob {
  id: string;
  name?: string;
  shotIds: string[];
  finalVideoUrl?: string;
  finalVideoGeneratedAt?: string;
  finalVideoSignature?: string;
  status?: StitchStatus;
  startedAt?: string;
  updatedAt?: string;
  error?: string;
  progress?: string;
  runningSignature?: string;
  finalVideoReviewStatus?: VideoReviewStatus;
  finalVideoReview?: VideoReviewVerdict;
  finalVideoReviewError?: string;
  finalVideoReviewUpdatedAt?: string;
  finalVideoReviewRunningSignature?: string;
  finalVideoReviewBuiltForSignature?: string;
  finalVideoReviewRepairPlan?: VideoReviewRepairPlan;
  createdAt: string;
}

export type WorkflowRunMode = "missing" | "all";
export type WorkflowShotAction = "skip" | "generate" | "poll";
export type WorkflowDependencyKind = "tailframe" | "reference_video" | "previous_clip";

export interface WorkflowShotDependency {
  kind: WorkflowDependencyKind;
  sourceShotId: string;
  targetShotId: string;
  label: string;
  reason: string;
}

export interface WorkflowShotPreflight {
  kind: "fresh_tailframe";
  sourceShotId: string;
  targetShotId: string;
  reason: string;
}

export interface WorkflowShotPlanItem {
  shotId: string;
  index: number;
  title: string;
  status: ShotStatus;
  hasVideo: boolean;
  action: WorkflowShotAction;
  dependencies: WorkflowShotDependency[];
  preflights: WorkflowShotPreflight[];
  estimatedDurationSec?: number;
}

export interface WorkflowStitchTarget {
  jobId?: string;
  name: string;
  shotIds: string[];
  ready: boolean;
}

export interface WorkflowExecutionPlan {
  sessionId: string;
  mode: WorkflowRunMode;
  maxParallelShots: number;
  layers: WorkflowShotPlanItem[][];
  skipped: WorkflowShotPlanItem[];
  stitchTargets: WorkflowStitchTarget[];
  warnings: string[];
  summary: string;
}

export interface SessionPackageMediaEntry {
  url: string;
  filename: string;
  contentType: string;
  base64: string;
}

export interface SessionPackage {
  format: "seereel-session";
  version: 1;
  exportedAt: string;
  sourceSessionId: string;
  title: string;
  appVersion?: string;
  session: Session;
  shots: Shot[];
  assets: Asset[];
  media: SessionPackageMediaEntry[];
}

export type NarrationStatus = "idle" | "running" | "ready" | "error";
export type NarrationStrategy = "natural";
export type NarrationSubtitleMode = "none" | "burn";
export type NarrationSubtitlePosition = "bottom" | "middle" | "top";

export interface Session {
  id: string;
  /** Anonymous demo owner. Used by public deployments to keep visitors' sessions isolated. */
  ownerUserId?: string;
  title: string;
  logline: string;
  style: string;
  /**
   * Preferred prompt language for this session. Drives the auto-composed Seedream / Seedance
   * prompts (raw user text inside dialogue quotes is left untouched). Default `"zh"`.
   */
  language?: SessionLanguage;
  targetDurationSec: number;
  story?: StoryPlan;
  finalVideoUrl?: string;
  /** ISO time when the current finalVideoUrl was generated by a stitch worker. */
  finalVideoGeneratedAt?: string;
  finalVideoSignature?: string;
  /** Multiple independent stitch outputs on the same canvas. Legacy single-output fields below stay as a compatibility fallback. */
  stitchJobs?: StitchJob[];
  /**
   * Explicit stitch playlist. When non-empty, only these shot ids are stitched in this order.
   * Empty/unset preserves the legacy default: all generated shots by `shot.index`.
   */
  stitchShotIds?: string[];
  /**
   * When true, the canvas hides the stitch node. Set by the canvas delete-node handler so that
   * after the user explicitly removes the stitch node it stays gone — without this flag the node
   * would re-derive on every state refresh whenever the session has ≥2 shots. Cleared by any
   * action that re-introduces stitching (right-click "+ 拼接节点" or wiring a shot into stitch).
   */
  stitchHidden?: boolean;
  /**
   * Stitch task lifecycle. `running` means a background worker is currently materializing the
   * inputs and running ffmpeg concat for this session. `ready` means `finalVideoUrl` is fresh and
   * matches the latest `finalVideoSignature`. `error` means the last run failed (see
   * `stitchError`); a subsequent /stitch call will retry. `idle` (or undefined) means no stitch
   * has been attempted, or the session is back to a clean slate.
   *
   * The HTTP route never blocks on stitch progress – it always returns immediately with the
   * current snapshot. Clients poll `POST /api/sessions/:id/stitch/poll` (or just `GET /api/state`)
   * to observe completion. This decouples long-running ffmpeg work from any single client
   * connection, so a dropped fetch / browser refresh / agent timeout cannot interrupt or partially
   * cancel the underlying work.
   */
  stitchStatus?: StitchStatus;
  /** ISO time the current running stitch job started. */
  stitchStartedAt?: string;
  /** ISO time the most recent stitch status update happened (ready/error transition). */
  stitchUpdatedAt?: string;
  /** Human-readable last error from the most recent failed stitch attempt. */
  stitchError?: string;
  /** Human-readable current phase, e.g. "downloading shot 4/5", "ffmpeg concat", "writing final". */
  stitchProgress?: string;
  /** Signature of the inputs of the currently running stitch job; used for singleflight. */
  stitchRunningSignature?: string;

  /**
   * Post-production audio track pipeline. Runs *after* a successful stitch and writes a second
   * mp4 with voiceover audio mixed in. Video generation still defaults to no subtitles; this
   * post-production node may optionally burn the narration script into the final mp4 only when
   * the user explicitly selects `narrationSubtitleMode: "burn"`.
   *   - `running`: background ffmpeg+TTS worker is processing
   *   - `ready`: `narrationVideoUrl` is fresh against the current `finalVideoSignature` (compare
   *     with `narrationSignature` to detect staleness when stitch was redone afterwards)
   *   - `error`: see `narrationError`
   *
   * `narrationSignature` is `sha1(script + voice + strategy + finalVideoSignature + audio/subtitle
   * options)` so that the UI can grey out the download buttons when stitch was rebuilt after the
   * narration was made.
   */
  audioTrackHidden?: boolean;
  narrationScript?: string;
  narrationVoice?: string;
  narrationStrategy?: NarrationStrategy;
  narrationStitchJobId?: string;
  narrationSubtitleMode?: NarrationSubtitleMode;
  narrationSubtitlePosition?: NarrationSubtitlePosition;
  narrationVolume?: number;
  narrationSourceVolume?: number;
  narrationStatus?: NarrationStatus;
  narrationStartedAt?: string;
  narrationUpdatedAt?: string;
  narrationError?: string;
  narrationProgress?: string;
  narrationVideoUrl?: string;
  narrationSubtitleUrl?: string;
  narrationSignature?: string;
  narrationRunningSignature?: string;
  /**
   * The `finalVideoSignature` value that was active when this narration was built. The UI
   * compares it against the current `finalVideoSignature` to detect a stale narration after a
   * re-stitch and grey out the "下载" buttons with a "请重新生成解说" hint.
   */
  narrationBuiltForFinalVideoSignature?: string;

  finalVideoReviewStatus?: VideoReviewStatus;
  finalVideoReview?: VideoReviewVerdict;
  finalVideoReviewError?: string;
  finalVideoReviewUpdatedAt?: string;
  finalVideoReviewRunningSignature?: string;
  finalVideoReviewBuiltForSignature?: string;
  vlmReviewEnabled?: boolean;
  finalVideoReviewRepairPlan?: VideoReviewRepairPlan;

  /** Per-session model token usage events, grouped by canvas/node id in the UI. */
  tokenUsageEvents?: TokenUsageEvent[];

  updatedAt: string;
  createdAt: string;
}

export interface StoreSnapshot {
  /** Normalized session rows as returned by /api/state; join with top-level `shots` by `sessionId`. */
  sessions: Session[];
  assets: Asset[];
  /** Top-level shot rows keyed by `sessionId`; sessions do not embed these in StoreSnapshot. */
  shots: Shot[];
  /** Public remixable creations shared by users. Visible across anonymous user scopes. */
  gallery?: GalleryItem[];
  runtime?: {
    seedreamCredentialSource?: "standard" | "agent-plan" | "missing";
    seedreamDefaultModel?: AssetImageModel;
    apiKeyCredential?: ApiKeyCredentialStatus;
    agentPlanCredential?: AgentPlanCredentialStatus;
    freeTrial?: FreeTrialStatus;
  };
}

export interface ApiKeyCredentialStatus {
  configured: boolean;
  fingerprint?: string;
  route?: StandardApiKeyRoute;
  updatedAt?: string;
  storage?: AgentPlanCredentialStorageStatus;
}

export interface AgentPlanCredentialStatus {
  configured: boolean;
  fingerprint?: string;
  updatedAt?: string;
  storage?: AgentPlanCredentialStorageStatus;
}

export interface AdminAgentPlanStatus {
  configured: boolean;
  fingerprint?: string;
  source: "ui" | "env" | "none";
  updatedAt?: string;
}

export interface AdminSecurityStatus {
  configured: boolean;
  source: "ui" | "env" | "none";
  updatedAt?: string;
}

export interface AgentPlanCredentialStorageStatus {
  mode: "database" | "memory";
  databaseConfigured: boolean;
  encryptionConfigured: boolean;
  error?: string;
}

export interface AdminUserAgentPlanCredential {
  userId: string;
  apiKey: string;
  fingerprint: string;
  createdAt?: string;
  updatedAt: string;
  ipHash?: string;
  userAgentHash?: string;
}

export interface AdminUserAgentPlanCredentialList {
  storage: AgentPlanCredentialStorageStatus;
  credentials: AdminUserAgentPlanCredential[];
}

export interface FreeTrialStatus {
  enabled: boolean;
  active: boolean;
  used: number;
  limit: number;
  remaining: number;
  day: string;
  ipDailyCap: number;
  globalDailyCap: number;
  globalUsed: number;
}

export interface GalleryPublishPayload {
  title?: string;
  description?: string;
  creatorName?: string;
  tags?: string[];
}

export interface GalleryItem {
  id: string;
  sourceSessionId: string;
  title: string;
  description: string;
  creatorName?: string;
  tags: string[];
  previewVideoUrl?: string;
  thumbnailUrl?: string;
  shotCount: number;
  targetDurationSec: number;
  language?: SessionLanguage;
  createdAt: string;
  updatedAt: string;
  session: Session;
  shots: Shot[];
  assets: Asset[];
}

/** Joined session shape returned by session-specific mutation/poll endpoints and built client-side for the canvas. */
export interface SessionWithShots extends Session {
  shots: Shot[];
}

export interface CreateSessionPayload {
  id?: string;
  title?: string;
  logline?: string;
  style?: string;
  targetDurationSec?: number;
  shotCount?: number;
  language?: SessionLanguage;
}

export interface GenerateAssetPayload {
  assetId: string;
  model?: AssetImageModel;
}

export interface ExpandAssetPromptPayload {
  asset: Partial<Asset>;
}

export interface ExpandAssetPromptResult {
  prompt: string;
  model: string;
}

export interface GenerateShotPayload {
  shotId: string;
}

/**
 * Returned by every "generate" route when called with `dryRun: true`. Carries the assembled
 * prompt the server would otherwise submit, plus a structured breakdown so the UI can show the
 * user which segment came from where (raw scene text vs. continuity instruction vs. first-frame
 * directive vs. ...).
 */
export interface PromptComposition {
  composedPrompt: string;
  parts: Record<string, string>;
  lang: SessionLanguage;
}
