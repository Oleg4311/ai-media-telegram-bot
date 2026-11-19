# Optional local AI video workflow

The bot works without this file: FREE photo animation falls back to FFmpeg.

For real local AI video generation, export a working ComfyUI workflow in API format and use placeholders in node input values:

- `{{PROMPT}}`
- `{{NEGATIVE_PROMPT}}`
- `{{SEED}}`
- `{{WIDTH}}`
- `{{HEIGHT}}`
- `{{DURATION}}`
- `{{FPS}}`
- `{{INPUT_IMAGE}}`
- `{{CHECKPOINT}}`

Save it under `assets/comfyui/`, for example `wan_video_api.json`, then set:

`COMFYUI_VIDEO_WORKFLOW=/app/assets/comfyui/wan_video_api.json`

The exact workflow depends on the installed Wan/video model and custom nodes, so the project intentionally does not hard-code one fragile graph.
