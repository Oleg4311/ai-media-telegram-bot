import { Injectable } from '@nestjs/common';

export type DirectorScene = { prompt: string; durationSec: number; camera?: string };
export type DirectorPlan = {
  kind: 'image' | 'video' | 'animate' | 'edit';
  prompt: string;
  negativePrompt?: string;
  durationSec: number;
  aspectRatio: '1:1' | '16:9' | '9:16';
  scenes: DirectorScene[];
};

@Injectable()
export class DirectorService {
  async plan(text: string, hasImage = false): Promise<DirectorPlan> {
    if (!process.env.OPENAI_API_KEY) return this.heuristic(text, hasImage);
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: process.env.DIRECTOR_MODEL || 'gpt-5.6-luna',
          input: [
            {
              role: 'system',
              content: [{ type: 'input_text', text: 'You are an AI media director. Return ONLY compact valid JSON with keys kind,prompt,negativePrompt,durationSec,aspectRatio,scenes. kind is image|video|animate|edit. aspectRatio is 1:1|16:9|9:16. For videos split into coherent cinematic scenes of 5-10 seconds. Preserve identity, product design, wardrobe, lighting and environment continuity. If user supplied an image, prefer edit or animate when appropriate. Maximum total duration 180 seconds.' }],
            },
            { role: 'user', content: [{ type: 'input_text', text: `hasImage=${hasImage}\nrequest=${text}` }] },
          ],
          max_output_tokens: 1400,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const body = await response.json() as any;
      const raw = this.extractText(body).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(raw) as DirectorPlan;
      return this.normalize(parsed, text, hasImage);
    } catch {
      return this.heuristic(text, hasImage);
    }
  }

  private extractText(body: any): string {
    const chunks: string[] = [];
    for (const item of body?.output || []) {
      for (const content of item?.content || []) {
        if (typeof content?.text === 'string') chunks.push(content.text);
      }
    }
    return chunks.join('\n');
  }

  private normalize(plan: DirectorPlan, fallback: string, hasImage: boolean): DirectorPlan {
    const durationSec = Math.min(180, Math.max(5, Number(plan.durationSec) || 10));
    const ratio = ['1:1', '16:9', '9:16'].includes(plan.aspectRatio) ? plan.aspectRatio : '9:16';
    const kind = ['image', 'video', 'animate', 'edit'].includes(plan.kind) ? plan.kind : hasImage ? 'edit' : 'image';
    const scenes = Array.isArray(plan.scenes) && plan.scenes.length
      ? plan.scenes.map((s) => ({ prompt: String(s.prompt || fallback), durationSec: Math.min(15, Math.max(3, Number(s.durationSec) || 5)), camera: s.camera }))
      : this.makeScenes(plan.prompt || fallback, durationSec);
    return { kind, prompt: plan.prompt || fallback, negativePrompt: plan.negativePrompt, durationSec, aspectRatio: ratio as DirectorPlan['aspectRatio'], scenes };
  }

  private heuristic(text: string, hasImage: boolean): DirectorPlan {
    const lower = text.toLowerCase();
    const secMatch = lower.match(/(\d{1,3})\s*(?:сек(?:унд[а-я]*)?|s|seconds?)/i);
    const minMatch = lower.match(/(\d{1,2}(?:[.,]\d+)?)\s*(?:мин(?:ут[а-я]*)?|minutes?)/i);
    const requested = secMatch ? Number(secMatch[1]) : minMatch ? Math.round(Number(minMatch[1].replace(',', '.')) * 60) : 10;
    const duration = Math.min(180, Math.max(5, requested));
    const aspectRatio: DirectorPlan['aspectRatio'] = /горизонт|16:9|youtube/i.test(lower) ? '16:9' : /квадрат|1:1/i.test(lower) ? '1:1' : '9:16';
    let kind: DirectorPlan['kind'] = 'image';
    if (/видео|ролик|animate|анимир|ожив/i.test(lower)) kind = hasImage ? 'animate' : 'video';
    else if (hasImage) kind = 'edit';
    const scenes = ['video', 'animate'].includes(kind) ? this.makeScenes(text, duration) : [];
    return { kind, prompt: text, durationSec: duration, aspectRatio, scenes };
  }

  private makeScenes(prompt: string, duration: number): DirectorScene[] {
    const sceneLen = 5;
    const count = Math.max(1, Math.ceil(duration / sceneLen));
    return Array.from({ length: count }, (_, index) => {
      const remaining = duration - index * sceneLen;
      return {
        durationSec: Math.min(sceneLen, remaining > 0 ? remaining : sceneLen),
        prompt: `${prompt}. Scene ${index + 1}/${count}. Keep the same subject, identity, clothing, lighting style and environment. Cinematic coherent motion, natural physics, no sudden morphing.`,
        camera: index % 3 === 0 ? 'slow push-in' : index % 3 === 1 ? 'gentle orbit' : 'controlled tracking shot',
      };
    });
  }
}
