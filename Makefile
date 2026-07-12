# Archon Memory — convenience targets.
.PHONY: test typecheck video video-frames

test:
	npm test

typecheck:
	npm run typecheck

# Build the < 3-min demo video (demo/archon-cockroach-memory-demo.mp4).
# Needs: python3 + pillow + edge-tts, and ffmpeg/ffprobe on PATH (edge-tts needs network).
video:
	python scripts/build_video.py

# Render just the terminal frames (no TTS / ffmpeg) — fast layout check.
video-frames:
	python scripts/build_video.py --frames
