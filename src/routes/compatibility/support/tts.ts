import type { Context } from "hono";
import type { Bindings } from "../../../bindings";
import { getRequestApiKey } from "../../../domain/auth";
import { createCompatibilityStore } from "../../../domain/storage";

export const ttsVoices = {
  premium: [
    {
      id: "local-premium",
      locales: {
        "en-US": {
          default: ["local_en_us_premium"],
        },
      },
      name: "Local Premium",
    },
  ],
  standard: [
    {
      id: "local-standard",
      locales: {
        "en-US": {
          default: ["local_en_us_1", "local_en_us_2"],
        },
        "es-ES": {
          default: ["local_es_es_1"],
        },
        "fr-FR": {
          default: ["local_fr_fr_1"],
        },
        "ja-JP": {
          default: ["local_ja_jp_1"],
        },
        "zh-CN": {
          default: ["local_zh_cn_1"],
        },
      },
      name: "Local Standard",
    },
  ],
};

export const validTTSVoices = new Set(
  [...ttsVoices.standard, ...ttsVoices.premium].flatMap((provider) =>
    Object.values(provider.locales).flatMap((groups) => groups.default)
  )
);

export const requireTTSAccess = async (
  c: Context<{ Bindings: Bindings }>
): Promise<boolean> => {
  const apiKey = getRequestApiKey(c);
  if (!apiKey) {
    return false;
  }

  return (
    (await createCompatibilityStore(c.env).getUserIDForApiKey(apiKey)) !== null
  );
};

export const getTTSTestKey = (c: Context<{ Bindings: Bindings }>) =>
  c.env.TTS_TEST_KEY ??
  c.env.COMPATIBILITY_TEST_API_KEY ??
  "local-tts-test-key";

export const getTTSAudioID = (voice: string, text: string) => {
  let hash = 0x81_1c_9d_c5;
  for (const char of `${voice}\n${text}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01_00_01_93);
  }

  return Math.abs(hash).toString(16);
};

export const localSilentWav = Uint8Array.from([
  82,
  73,
  70,
  70,
  236,
  0,
  0,
  0,
  87,
  65,
  86,
  69,
  102,
  109,
  116,
  32,
  16,
  0,
  0,
  0,
  1,
  0,
  1,
  0,
  64,
  31,
  0,
  0,
  128,
  62,
  0,
  0,
  2,
  0,
  16,
  0,
  100,
  97,
  116,
  97,
  200,
  0,
  0,
  0,
  ...new Array(200).fill(0),
]);
