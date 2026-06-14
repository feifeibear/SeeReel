import type { Asset, SessionWithShots, Shot, StoreSnapshot, StitchJob } from "../../shared/types";
import type { FlowNodeData } from "./buildGraph";

function findAsset(snapshot: StoreSnapshot, asset: Asset): Asset;
function findAsset(snapshot: StoreSnapshot, asset: Asset | undefined): Asset | undefined;
function findAsset(snapshot: StoreSnapshot, asset: Asset | undefined) {
  if (!asset) return undefined;
  return snapshot.assets.find((item) => item.id === asset.id) || asset;
}

function findShot(snapshot: StoreSnapshot, session: SessionWithShots | undefined, shot: Shot): Shot;
function findShot(snapshot: StoreSnapshot, session: SessionWithShots | undefined, shot: Shot | undefined): Shot | undefined;
function findShot(snapshot: StoreSnapshot, session: SessionWithShots | undefined, shot: Shot | undefined) {
  if (!shot) return undefined;
  return session?.shots.find((item) => item.id === shot.id)
    || snapshot.shots.find((item) => item.id === shot.id)
    || shot;
}

function findJob(session: SessionWithShots | undefined, job: StitchJob) {
  if (!session || job.id === "legacy") return job;
  return (session.stitchJobs || []).find((item) => item.id === job.id) || job;
}

export function resolveFreshSelectedData(
  data: FlowNodeData | undefined,
  snapshot: StoreSnapshot,
  session: SessionWithShots | undefined
): FlowNodeData | undefined {
  if (!data) return undefined;
  switch (data.kind) {
    case "image":
    case "asset":
      return {
        ...data,
        asset: findAsset(snapshot, data.asset),
        referenceAssets: (data.referenceAssets || []).map((asset) => findAsset(snapshot, asset)).filter(Boolean) as Asset[]
      };
    case "storyboard":
      return {
        ...data,
        shot: findShot(snapshot, session, data.shot),
        asset: findAsset(snapshot, data.asset)
      };
    case "shot":
      return {
        ...data,
        shot: findShot(snapshot, session, data.shot)
      };
    case "stitch":
    case "audioTrack":
      return {
        ...data,
        session: session || data.session,
        job: findJob(session, data.job)
      };
    case "voice":
    case "music":
    case "referenceVideo":
    case "videoAsset":
      return {
        ...data,
        asset: findAsset(snapshot, data.asset)
      };
    case "videoProcessor":
      return {
        ...data,
        asset: findAsset(snapshot, data.asset),
        sourceAsset: findAsset(snapshot, data.sourceAsset)
      };
    case "tailframe":
      return {
        ...data,
        asset: findAsset(snapshot, data.asset),
        sourceShot: findShot(snapshot, session, data.sourceShot),
        targetShots: data.targetShots.map((shot) => findShot(snapshot, session, shot)).filter(Boolean) as Shot[]
      };
    default:
      return data;
  }
}
