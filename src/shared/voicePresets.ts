export interface VoicePreset {
  id: string;
  labelZh: string;
  labelEn: string;
  voiceId: string;
  descriptionZh: string;
  descriptionEn: string;
  tagsZh: string[];
  tagsEn: string[];
}

export const VOICE_PRESETS: VoicePreset[] = [
  {
    id: "young-female",
    labelZh: "少女音色",
    labelEn: "Young Female",
    voiceId: "BV001_streaming",
    descriptionZh: "清亮、年轻、自然，适合少女/年轻女性旁白。",
    descriptionEn: "Bright, young, natural voice for young female narration.",
    tagsZh: ["女声", "年轻", "普通话"],
    tagsEn: ["female", "young", "Mandarin"]
  },
  {
    id: "dongbei-female",
    labelZh: "东北丫头",
    labelEn: "Northeast Female",
    voiceId: "BV020_streaming",
    descriptionZh: "东北话女声，外向、直爽，适合喜剧和生活化对白。",
    descriptionEn: "Northeastern Chinese female voice, direct and lively.",
    tagsZh: ["女声", "东北话", "喜剧"],
    tagsEn: ["female", "Dongbei", "comedy"]
  },
  {
    id: "dongbei-male",
    labelZh: "东北老铁",
    labelEn: "Northeast Male",
    voiceId: "BV021_streaming",
    descriptionZh: "东北话男声，粗粝热情，适合市井人物和讽刺段落。",
    descriptionEn: "Northeastern Chinese male voice, earthy and energetic.",
    tagsZh: ["男声", "东北话", "市井"],
    tagsEn: ["male", "Dongbei", "street"]
  },
  {
    id: "mandarin-male",
    labelZh: "青年男声",
    labelEn: "Young Male",
    voiceId: "zh_male_M392_conversation_wvae_bigtts",
    descriptionZh: "自然青年男声，适合普通旁白和对话。",
    descriptionEn: "Natural young male voice for general narration and dialogue.",
    tagsZh: ["男声", "普通话", "自然"],
    tagsEn: ["male", "Mandarin", "natural"]
  },
  {
    id: "english-male",
    labelZh: "英文男声",
    labelEn: "English Male",
    voiceId: "en_male_jason_conversation_wvae_bigtts",
    descriptionZh: "英文男声，适合英文旁白和国际化介绍。",
    descriptionEn: "English male voice for English narration.",
    tagsZh: ["男声", "英语"],
    tagsEn: ["male", "English"]
  }
];

export function voicePresetForId(value: string | undefined) {
  if (!value) return undefined;
  return VOICE_PRESETS.find((preset) => preset.id === value || preset.voiceId === value);
}
