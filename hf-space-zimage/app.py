"""
Z-Image-Turbo as a free Hugging Face Space (ZeroGPU hardware).

Setup:
1. Create a free account at https://huggingface.co/join (email only, no card).
2. Create a new Space: https://huggingface.co/new-space
   - SDK: Gradio
   - Hardware: ZeroGPU (free tier)
3. Upload this app.py, requirements.txt and README.md to the Space
   (via the web UI "Files" tab, or `git push` / huggingface_hub).
4. Once the Space is running, its API is at:
   https://<your-username>-<space-name>.hf.space
   Put that URL in the bot's .env as HF_SPACE_ZIMAGE_URL, and a token
   from https://huggingface.co/settings/tokens as HF_TOKEN.

Free accounts get 5 minutes of ZeroGPU compute per day - genuinely $0,
no payment method required anywhere, but the daily quota is small
(roughly a handful of images), so treat this as a bonus low-volume
engine, not the bot's primary image provider.
"""

import spaces
import torch
import gradio as gr
from diffusers import ZImagePipeline

pipe = None


def load_pipe():
    global pipe
    if pipe is None:
        pipe = ZImagePipeline.from_pretrained(
            "Tongyi-MAI/Z-Image-Turbo",
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=False,
        ).to("cuda")
    return pipe


@spaces.GPU(duration=60)
def generate(prompt, negative_prompt, width, height):
    p = load_pipe()
    image = p(
        prompt=prompt,
        negative_prompt=negative_prompt or None,
        width=int(width),
        height=int(height),
        num_inference_steps=50,
        guidance_scale=4,
    ).images[0]
    return image


demo = gr.Interface(
    fn=generate,
    inputs=[
        gr.Textbox(label="prompt"),
        gr.Textbox(label="negative_prompt", value=""),
        gr.Number(label="width", value=1024),
        gr.Number(label="height", value=1024),
    ],
    outputs=gr.Image(type="pil"),
    api_name="predict",
)

demo.launch()
