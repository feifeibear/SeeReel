import { strict as assert } from "node:assert";
import { buildSessionGraph } from "../src/client/flow/buildGraph";
import { buildPendingConnectEdge } from "../src/client/flow/pendingConnection";
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
assert.ok(defaultGraph.nodes.some((node) => node.id === "audio-ses_audio_smoke-stitch_main"), "audio track node should remain visible");
assert.equal(defaultGraph.edges.some((edge) => edge.id.startsWith("e-audio-")), false, "stitch should not auto-connect to audio track");

const connectedSession: SessionWithShots = {
  ...session,
  audioTrackStitchJobIds: ["stitch_main"],
  narrationStitchJobId: "stitch_main",
  narrationStatus: "running"
};
const connectedGraph = buildSessionGraph(snapshot, connectedSession);
const audioEdge = connectedGraph.edges.find((edge) => edge.id === "e-audio-stitch-ses_audio_smoke-stitch_main-audio-ses_audio_smoke-stitch_main");
assert.ok(audioEdge, "explicit audio-track wiring should render an edge");
assert.notEqual(audioEdge.deletable, false, "explicit audio-track wiring should be deletable");
assert.equal((audioEdge.data as { canDisconnectAudioTrack?: boolean }).canDisconnectAudioTrack, true, "audio edge should use disconnect metadata");
assert.equal(audioEdge.animated, true, "running narration should animate the matching audio edge");

const targetNode = defaultGraph.nodes.find((node) => node.id === "audio-ses_audio_smoke-stitch_main");
const pendingEdge = buildPendingConnectEdge({
  connection: { source: "stitch-ses_audio_smoke-stitch_main", target: "audio-ses_audio_smoke-stitch_main", sourceHandle: null, targetHandle: null },
  session,
  snapshot,
  targetNodeData: targetNode?.data
});
assert.ok(pendingEdge, "dragging stitch into audio should preview an audio edge");
assert.equal((pendingEdge.data as { canDisconnectAudioTrack?: boolean }).canDisconnectAudioTrack, true);

console.log("audio track wiring smoke passed");
