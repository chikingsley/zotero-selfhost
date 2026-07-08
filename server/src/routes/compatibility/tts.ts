import { ttsVoices, validTTSVoices, requireTTSAccess, getTTSTestKey, getTTSAudioID, localSilentWav, isRecord } from "./shared";
import { compatibility } from "./router";


compatibility.get("/tts/voices", (c) => c.json(ttsVoices));


compatibility.get("/tts/credits", (c) =>
  c.json({
    premiumCreditsRemaining: 1_000_000,
    standardCreditsRemaining: 1_000_000,
  })
);


compatibility.post("/tts/speak", async (c) => {
  if (!(await requireTTSAccess(c))) {
    return c.text("Invalid key", 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!isRecord(body)) {
    return c.text("Invalid JSON", 400);
  }
  if (body.test !== getTTSTestKey(c)) {
    return c.text("Invalid test key", 403);
  }
  if (typeof body.voice !== "string") {
    return c.text("Voice not provided", 400);
  }
  if (typeof body.text !== "string") {
    return c.text("Text not provided", 400);
  }
  if (!validTTSVoices.has(body.voice)) {
    return c.text("Invalid voice", 400);
  }

  const url = new URL(c.req.url);
  const audioID = getTTSAudioID(body.voice, body.text);
  return c.redirect(`${url.origin}/tts/audio/${audioID}.wav`, 302);
});


compatibility.get("/tts/audio/:audioID", (c) =>
  c.body(localSilentWav.buffer.slice(0), 200, {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": "audio/wav",
  })
);
