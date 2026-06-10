import { strict as assert } from "node:assert";
import { buildSessionGraph } from "../src/client/flow/buildGraph";
import type { SessionWithShots, StoreSnapshot } from "../src/shared/types";

const now = "2026-06-07T00:00:00.000Z";

const session: SessionWithShots = {
  id: "ses_audio_smoke",
  title: "Audio smoke",
  logline: "",
  style: "",
  targetDurationSec: 30,
  stitchJobs: [{
    id: "stitch_main",
    name: "Main stitch",
    shotIds: ["shot_1", "shot_2"],
    finalVideoUrl: "/media/final.mp4",
    finalVideoSignature: "sig-final",
    status: "ready",
    createdAt: now,
    updatedAt: now
  }],
  shots: [
    {
      id: "shot_1",
      sessionId: "ses_audio_smoke",
      index: 1,
      title: "Shot 1",
      script: "",
      camera: "",
      durationSec: 15,
      assetIds: [],
      rawPrompt: "",
      prompt: "",
      debugNote: "",
      seedanceVariant: "standard",
      usePreviousShotClip: false,
      renders: [],
      status: "ready",
      videoUrl: "/media/shot-1.mp4",
      createdAt: now,
      updatedAt: now
    },
    {
      id: "shot_2",
      sessionId: "ses_audio_smoke",
      index: 2,
      title: "Shot 2",
      script: "",
      camera: "",
      durationSec: 15,
      assetIds: [],
      rawPrompt: "",
      prompt: "",
      debugNote: "",
      seedanceVariant: "standard",
      usePreviousShotClip: false,
      renders: [],
      status: "ready",
      videoUrl: "/media/shot-2.mp4",
      createdAt: now,
      updatedAt: now
    }
  ],
  createdAt: now,
  updatedAt: now
};

const snapshot: StoreSnapshot = {
  sessions: [session],
  shots: session.shots,
  assets: []
};

const defaultGraph = buildSessionGraph(snapshot, session);
const defaultStitchNode = defaultGraph.nodes.find((node) => node.id === "stitch-ses_audio_smoke-stitch_main");
assert.ok(defaultStitchNode, "stitch nodes should render so videos can connect to them");
assert.equal(defaultStitchNode.type, "stitchNode");
assert.equal(defaultGraph.nodes.some((node) => node.id.startsWith("audio-")), false, "audio track should not auto-render from a hidden stitch node");
assert.equal(defaultGraph.edges.some((edge) => edge.id.startsWith("e-audio-")), false, "stitch should not auto-connect to audio track");

const connectedSession: SessionWithShots = {
  ...session,
  audioTrackStitchJobIds: ["stitch_main"],
  narrationStitchJobId: "stitch_main",
  narrationStatus: "running"
};
const connectedGraph = buildSessionGraph(snapshot, connectedSession);
assert.equal(connectedGraph.edges.some((edge) => edge.id.startsWith("e-audio-")), false, "legacy audio-track wiring should not resurrect stitch/audio canvas edges");

const visibleAudioSession: SessionWithShots = {
  ...session,
  audioTrackHidden: false
};
const visibleAudioGraph = buildSessionGraph(snapshot, visibleAudioSession);
const audioNode = visibleAudioGraph.nodes.find((node) => node.id === "audio-legacy");
assert.ok(audioNode, "explicitly created LibTV-style audio track node should render without a stitch node");
assert.equal(audioNode.type, "audioTrackNode");
assert.equal((audioNode.data as { kind?: string; job?: { id?: string } }).kind, "audioTrack");
assert.equal((audioNode.data as { job?: { id?: string } }).job?.id, "legacy");

console.log("audio track wiring smoke passed");
