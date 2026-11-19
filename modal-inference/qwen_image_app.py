"""
Qwen-Image generation, served as a Modal app.

Deploy:
    pip install modal
    modal setup
    modal deploy modal-inference/qwen_image_app.py

After deploy, Modal prints an HTTPS URL for the `generate` web endpoint.
Put it in the bot's .env as MODAL_QWEN_IMAGE_URL.

Qwen-Image is a larger model than Z-Image-Turbo, so this uses an L40S
(48GB) GPU by default. If you hit out-of-memory errors, that's the knob
to raise (H100); if you want it cheaper and are fine with slower/lower
quality, you can try swapping gpu="L4" instead.
"""

import io

import modal

app = modal.App("ai-media-bot-qwen-image")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "diffusers",
        "torch",
        "transformers",
        "accelerate",
        "fastapi[standard]",
        "pillow",
    )
)


@app.cls(gpu="L40S", image=image, scaledown_window=120)
class QwenImageModel:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import QwenImagePipeline

        self.pipe = QwenImagePipeline.from_pretrained(
            "Qwen/Qwen-Image",
            torch_dtype=torch.bfloat16,
        ).to("cuda")

    @modal.fastapi_endpoint(method="POST")
    def generate(self, data: dict):
        from fastapi import Response

        prompt = data.get("prompt", "")
        negative_prompt = data.get("negative_prompt") or " "
        width = int(data.get("width", 1024))
        height = int(data.get("height", 1024))

        result = self.pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            num_inference_steps=int(data.get("num_inference_steps", 30)),
            true_cfg_scale=float(data.get("true_cfg_scale", 4.0)),
        ).images[0]

        buf = io.BytesIO()
        result.save(buf, format="PNG")
        return Response(content=buf.getvalue(), media_type="image/png")
