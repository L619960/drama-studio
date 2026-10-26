// ===== 题材模板（M4：预置提示词配方，渲染时作为风格前缀拼到提示词前）=====
export interface GenreTemplate {
  key: string
  label: string
  promptStyle: string
}

export const GENRE_TEMPLATES: GenreTemplate[] = [
  {
    key: '霸总',
    label: '霸总都市',
    promptStyle: 'city-night practical lights, cool-teal key with warm fill accents, shallow DOF, restrained contrast, vertical short-drama look development'
  },
  {
    key: '重生',
    label: '重生逆袭',
    promptStyle: 'heightened emotional contrast, desaturated day / saturated night, punchy midtones, cinematic color timing for revenge drama'
  },
  {
    key: '悬疑',
    label: '悬疑惊悚',
    promptStyle: 'low-key chiaroscuro, negative fill, cool practical spill, noir grain, tense static frames with micro push-ins'
  },
  {
    key: '甜宠',
    label: '甜宠言情',
    promptStyle: 'airy high-key lighting, soft pastel palette, gentle bokeh, bright skin tones, warm romantic glow, light dreamy haze'
  },
  {
    key: '虐恋',
    label: '虐恋催泪',
    promptStyle: 'moody desaturated grade, rain-washed atmosphere, lonely negative space, soft window light, tearful emotional close-ups'
  },
  {
    key: '战神',
    label: '战神归来',
    promptStyle: 'high-contrast heroic grade, dramatic rim light, gritty urban textures, wide establishing power shots, bold shadow play'
  },
  {
    key: '穿越',
    label: '时空穿越',
    promptStyle: 'anachronism blend, warm historical interiors with modern cool accents, dust-mote light shafts, period-correct costumes'
  },
  {
    key: '古装',
    label: '古装仙侠',
    promptStyle: 'wuxia cinematic look, flowing silk highlights, misty mountains, jade-and-gold palette, ethereal god rays, wire-work motion feel'
  },
  {
    key: '玄幻',
    label: '玄幻修仙',
    promptStyle: 'epic fantasy grade, luminous energy glows, dramatic scale contrast, mythical beast silhouettes, volumetric atmosphere'
  },
  {
    key: '都市',
    label: '都市职场',
    promptStyle: 'clean corporate realism, glass-and-steel reflections, neutral daylight grade, sharp modern geometry, professional pace'
  },
  {
    key: '民国',
    label: '民国传奇',
    promptStyle: 'vintage sepia-teal grade, art-deco interiors, opium-lamp warmth, period wardrobe, film-grain nostalgia'
  },
  {
    key: '校园',
    label: '青春校园',
    promptStyle: 'fresh daylight, youthful brightness, soft-focus lens flare, pastel uniforms, energetic handheld moments'
  },
  {
    key: '喜剧',
    label: '爆笑喜剧',
    promptStyle: 'vibrant saturated grade, lively fast pacing feel, broad dynamic poses, colorful practicals, upbeat bright look'
  },
  {
    key: '科幻',
    label: '科幻未来',
    promptStyle: 'neon-noir sci-fi grade, holographic UI accents, cool cyan-magenta palette, clean futuristic geometry, lens refraction glints'
  },
  {
    key: '宫廷',
    label: '古风宫斗',
    promptStyle: 'imperial gold-crimson palette, ornate palace interiors, silk embroidery detail, candle-lit warmth, regal static compositions'
  },
  {
    key: '家庭',
    label: '家庭伦理',
    promptStyle: 'naturalistic kitchen-sink realism, soft window daylight, intimate domestic close-ups, muted honest color grade'
  }
]

