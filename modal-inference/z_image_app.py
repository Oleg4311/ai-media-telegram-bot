"""
Z-Image-Turbo image generation, served as a Modal app.

Deploy:
    pip install modal
    modal setup
    modal deploy modal-inference/z_image_app.py

After deploy, Modal prints an HTTPS URL for the `generate` web endpoint.
Put it in the bot's .env as MODAL_ZIMAGE_URL.

Cost: Modal's Starter plan gives $30/month of compute for free, no card
required. The GPU only runs (and only bills) while a request is in flight;
`scaledown_window` keeps it warm for a couple of minutes after the last
request to avoid a cold start on every single message.
"""

import io

import modal

app = modal.App("ai-media-bot-z-image")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "git+https://github.com/huggingface/diffusers",
        "torch",
        "transformers",
        "accelerate",
        "sentencepiece",
        "fastapi[standard]",
        "pillow",
    )
)


@app.cls(gpu="L4", image=image, scaledown_window=120)
class ZImageModel:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import ZImagePipeline

        self.pipe = ZImagePipeline.from_pretrained(
            "Tongyi-MAI/Z-Image-Turbo",
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=False,
        ).to("cuda")

    @modal.fastapi_endpoint(method="POST")
    def generate(self, data: dict):
        from fastapi import Response

        prompt = data.get("prompt", "")
        negative_prompt = data.get("negative_prompt") or None
        width = int(data.get("width", 1024))
        height = int(data.get("height", 1024))

        result = self.pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            num_inference_steps=int(data.get("num_inference_steps", 50)),
            guidance_scale=float(data.get("guidance_scale", 4)),
        ).images[0]

        buf = io.BytesIO()
        result.save(buf, format="PNG")
        return Response(content=buf.getvalue(), media_type="image/png")
