import { strict as assert } from "node:assert";
import { buildVolcMusicRequest, parseVolcMusicPollResult } from "../src/server/narration";

const signed = buildVolcMusicRequest({
  accessKeyId: "AKLTEXAMPLE",
  secretAccessKey: "SECRETEXAMPLE",
  action: "GenBGMForTime",
  body: {
    Text: "悬疑短剧片尾纯音乐，低频弦乐，冷色电子脉冲",
    Duration: 60,
    Version: "v5.0"
  },
  now: new Date("2026-06-09T03:04:05.000Z")
});

assert.equal(
  signed.url,
  "https://open.volcengineapi.com/?Action=GenBGMForTime&Version=2024-08-12",
  "music request should target Volcengine OpenAPI with stable query ordering"
);
assert.equal(signed.headers.Host, "open.volcengineapi.com");
assert.equal(signed.headers["X-Date"], "20260609T030405Z");
assert.match(signed.headers.Authorization, /^HMAC-SHA256 Credential=AKLTEXAMPLE\/20260609\/cn-beijing\/imagination\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[0-9a-f]{64}$/);
assert(!signed.headers.Authorization.includes("SECRETEXAMPLE"), "secret must not be embedded in Authorization");

const signedWithSessionToken = buildVolcMusicRequest({
  accessKeyId: "AKLTEXAMPLE",
  secretAccessKey: "SECRETEXAMPLE",
  sessionToken: "SESSIONTOKENEXAMPLE",
  action: "GenBGMForTime",
  body: {
    Text: "悬疑短剧片尾纯音乐，低频弦乐，冷色电子脉冲",
    Duration: 60,
    Version: "v5.0"
  },
  now: new Date("2026-06-09T03:04:05.000Z")
});
assert.equal(signedWithSessionToken.headers["X-Security-Token"], "SESSIONTOKENEXAMPLE");
assert.match(
  signedWithSessionToken.headers.Authorization,
  /^HMAC-SHA256 Credential=AKLTEXAMPLE\/20260609\/cn-beijing\/imagination\/request, SignedHeaders=content-type;host;x-content-sha256;x-date;x-security-token, Signature=[0-9a-f]{64}$/
);

const success = parseVolcMusicPollResult({
  Code: 0,
  Result: {
    TaskID: "202408308513817850019840",
    Status: 2,
    SongDetail: {
      AudioUrl: "https://v1-default.douyinvod.com/music.mp3",
      Lyrics: "啦啦啦",
      Duration: 46.5
    }
  }
});
assert.equal(success.status, "succeeded");
assert.equal(success.audioUrl, "https://v1-default.douyinvod.com/music.mp3");
assert.equal(success.durationSec, 46.5);

const running = parseVolcMusicPollResult({ Code: 0, Result: { TaskID: "task_running", Status: 1 } });
assert.equal(running.status, "running");

const failed = parseVolcMusicPollResult({
  Code: 0,
  Result: {
    TaskID: "task_failed",
    Status: 3,
    FailureReason: { Code: 100001, Msg: "quota exhausted" }
  }
});
assert.equal(failed.status, "failed");
assert.match(failed.failureReason || "", /quota exhausted/);

console.log("volc music smoke passed");
