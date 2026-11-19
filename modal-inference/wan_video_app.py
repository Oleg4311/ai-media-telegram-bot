"""
Wan2.2 image-to-video, served as a Modal app.

Deploy:
    pip install modal
    modal setup
    modal deploy modal-inference/wan_video_app.py

After deploy, Modal prints an HTTPS URL for the `generate` web endpoint.
Put it in the bot's .env as MODAL_WAN_VIDEO_URL.

Wan2.2-I2V-A14B is a large MoE video model (two 14B transformers), so this
needs a big GPU - defaults to an 80GB A100. Video generation is also much
slower than a still image: expect a few minutes per clip on top of the
cold-start model load, which is why the request body caps out at ~10s clips
(the bot stitches longer videos from multiple clips with FFmpeg, same as it
already does for Runway/Kling).
"""

import base64
import io

import modal

app = modal.App("ai-media-bot-wan-video")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg")
    .pip_install(
        "diffusers",
        "torch",
        "transformers",
        "accelerate",
        "ftfy",
        "imageio",
        "imageio-ffmpeg",
        "fastapi[standard]",
        "pillow",
    )
)


@app.cls(gpu="A100-80GB", image=image, scaledown_window=120, timeout=1200)
class WanVideoModel:
    @modal.enter()
    def load(self):
        import torch
        from diffusers import WanImageToVideoPipeline

        self.pipe = WanImageToVideoPipeline.from_pretrained(
            "Wan-AI/Wan2.2-I2V-A14B-Diffusers",
            torch_dtype=torch.bfloat16,
        ).to("cuda")

    @modal.fastapi_endpoint(method="POST")
    def generate(self, data: dict):
        from fastapi import Response
        from PIL import Image
        from diffusers.utils import export_to_video

        image_bytes = base64.b64decode(data["image_base64"])
        init_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        # Resize to Wan's preferred area while preserving aspect ratio,
        # snapped to the model's patch/VAE stride (see Wan docs example).
        max_area = 480 * 832
        aspect_ratio = init_image.height / init_image.width
        mod_value = self.pipe.vae_scale_factor_spatial * self.pipe.transformer.config.patch_size[1]
        height = round((max_area * aspect_ratio) ** 0.5) // mod_value * mod_value
        width = round((max_area / aspect_ratio) ** 0.5) // mod_value * mod_value
        init_image = init_image.resize((width, height))

        fps = 16
        duration_sec = min(10, max(1, float(data.get("duration_sec", 5))))
        # Wan requires num_frames = 4k + 1.
        k = max(1, round((duration_sec * fps - 1) / 4))
        num_frames = 4 * k + 1

        output = self.pipe(
            image=init_image,
            prompt=data.get("prompt", ""),
            negative_prompt=data.get("negative_prompt") or None,
            height=height,
            width=width,
            num_frames=num_frames,
            guidance_scale=float(data.get("guidance_scale", 5.0)),
        ).frames[0]

        out_path = "/tmp/output.mp4"
        export_to_video(output, out_path, fps=fps)
        with open(out_path, "rb") as f:
            video_bytes = f.read()
        return Response(content=video_bytes, media_type="video/mp4")
