#!/usr/bin/env python3
"""Build the Archon Memory demo video — deterministic, headless, one command.

Pipeline (no browser, no live infra needed at render time):
  demo/narration.json  ->  per-beat terminal frames (Pillow)
                       ->  per-beat narration audio (edge-tts, free MS voice)
                       ->  per-beat mp4 (ffmpeg: still image + audio)
                       ->  concat  ->  demo/archon-cockroach-memory-demo.mp4

Every frame's text is REAL output: the memory:demo beat is a verbatim excerpt of a
live-CockroachDB run captured in demo/assets/fixtures/memory-demo.txt; the Bedrock,
fan-out, distribution and live-Cloud beats are verbatim from docs/BEDROCK_SMOKE.md,
docs/BENCHMARK.md (Result 3 / 3b) and docs/CLOUD_SMOKE.md.

Requirements (all already available in this repo's dev env):
  - Python 3.11+  ·  Pillow  ·  edge-tts  (pip install pillow edge-tts)
  - ffmpeg + ffprobe on PATH
  - network access for edge-tts (Microsoft's free online neural voice)

Usage:
  python scripts/build_video.py            # full build
  python scripts/build_video.py --frames   # render frames only (no TTS/ffmpeg)
"""
from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
DEMO = ROOT / "demo"
ASSETS = DEMO / "assets"
FRAMES = ASSETS / "frames"
AUDIO = ASSETS / "audio"
CLIPS = ASSETS / "clips"
OUT = DEMO / "archon-cockroach-memory-demo.mp4"

W, H = 1280, 720

# Colours (GitHub-dark-ish, high contrast for a screen recording).
BG = (13, 17, 23)
TITLEBAR = (22, 27, 34)
ACCENT = (0, 184, 212)      # cockroach cyan
FG = (201, 209, 217)
DIM = (110, 118, 129)
GREEN = (63, 185, 80)       # prompt lines
BLUE = (88, 166, 255)       # quoted model output
AMBER = (210, 153, 34)      # highlighted results
FOOTER = (88, 96, 105)

# Windows fonts (fall back to Pillow's bundled DejaVu if absent).
def _font(paths: list[str], size: int) -> ImageFont.FreeTypeFont:
    for p in paths:
        fp = Path(p)
        if fp.exists():
            return ImageFont.truetype(str(fp), size)
    try:
        return ImageFont.truetype("DejaVuSansMono.ttf", size)
    except Exception:
        return ImageFont.load_default()

WIN = "C:/Windows/Fonts"
MONO = _font([f"{WIN}/consola.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"], 22)
MONO_B = _font([f"{WIN}/consolab.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"], 22)
SANS_B = _font([f"{WIN}/arialbd.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"], 30)
SANS = _font([f"{WIN}/arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"], 18)

MARGIN_X = 60
BODY_TOP = 140
LINE_H = 34
WRAP = 92  # chars per wrapped line at Consolas 22px within the usable width


def line_colour(s: str) -> tuple[int, int, int]:
    t = s.strip()
    if t.startswith("$ "):
        return GREEN
    if t.startswith(">"):
        return BLUE
    if not t or set(t) <= set("=-+ "):
        return DIM
    if any(k in s for k in ("vector search", "STILL served", "trust 18400",
                            "recall@10", "RF=3", "replicas [", "1.000000", "-> ")):
        return AMBER
    return FG


def wrap_line(s: str) -> list[str]:
    if len(s) <= WRAP:
        return [s]
    indent = " " * (len(s) - len(s.lstrip(" ")))
    wrapped = textwrap.wrap(s, width=WRAP, subsequent_indent=indent + "  ",
                            break_long_words=False, break_on_hyphens=False)
    return wrapped or [s]


def render_frame(beat: dict, idx: int, total: int) -> Path:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # title bar
    d.rectangle([0, 0, W, 96], fill=TITLEBAR)
    d.rectangle([0, 0, 8, 96], fill=ACCENT)
    d.text((MARGIN_X, 30), beat["title"], font=SANS_B, fill=(255, 255, 255))
    tag = f"{idx}/{total}"
    tw = d.textlength(tag, font=SANS)
    d.text((W - MARGIN_X - tw, 40), tag, font=SANS, fill=ACCENT)

    # body
    y = BODY_TOP
    for raw in beat["frame"]:
        for ln in wrap_line(raw):
            d.text((MARGIN_X, y), ln, font=MONO, fill=line_colour(raw))
            y += LINE_H

    # footer
    d.text((MARGIN_X, H - 42),
           "Archon Memory  ·  CockroachDB distributed vector index  ×  AWS Bedrock",
           font=SANS, fill=FOOTER)

    FRAMES.mkdir(parents=True, exist_ok=True)
    out = FRAMES / f"{beat['id']}.png"
    img.save(out)
    return out


def tts(beat: dict, voice: str, rate: str) -> Path:
    AUDIO.mkdir(parents=True, exist_ok=True)
    out = AUDIO / f"{beat['id']}.mp3"
    cmd = [sys.executable, "-m", "edge_tts", "--voice", voice,
           "--rate", rate, "--text", beat["narration"], "--write-media", str(out)]
    subprocess.run(cmd, check=True)
    return out


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nk=1:nw=1", str(path)],
        capture_output=True, text=True, check=True).stdout.strip()
    return float(out)


def build_clip(frame: Path, audio: Path, beat_id: str, pad: float = 0.6) -> Path:
    CLIPS.mkdir(parents=True, exist_ok=True)
    dur = probe_duration(audio) + pad
    out = CLIPS / f"{beat_id}.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-loop", "1", "-i", str(frame),
        "-i", str(audio),
        "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p",
        "-r", "30", "-vf", f"scale={W}:{H}",
        "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
        "-t", f"{dur:.3f}", str(out),
    ], check=True)
    return out


def concat(clips: list[Path]) -> Path:
    listfile = CLIPS / "concat.txt"
    listfile.write_text("".join(f"file '{c.as_posix()}'\n" for c in clips), encoding="utf-8")
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(listfile),
        "-c", "copy", str(OUT),
    ], check=True)
    return OUT


def main() -> None:
    frames_only = "--frames" in sys.argv
    spec = json.loads((DEMO / "narration.json").read_text(encoding="utf-8"))
    beats = spec["beats"]
    voice = spec.get("voice", "en-US-GuyNeural")
    rate = spec.get("rate", "+0%")
    total = len(beats)

    clips: list[Path] = []
    for i, beat in enumerate(beats, 1):
        print(f"[{i}/{total}] {beat['id']}: frame", flush=True)
        frame = render_frame(beat, i, total)
        if frames_only:
            continue
        print(f"[{i}/{total}] {beat['id']}: tts", flush=True)
        audio = tts(beat, voice, rate)
        print(f"[{i}/{total}] {beat['id']}: clip", flush=True)
        clips.append(build_clip(frame, audio, beat["id"]))

    if frames_only:
        print(f"frames -> {FRAMES}")
        return

    total_dur = sum(probe_duration(c) for c in clips)
    concat(clips)
    print(f"\n[done] {OUT}  ({total_dur:.1f}s, {total} beats)")


if __name__ == "__main__":
    main()
