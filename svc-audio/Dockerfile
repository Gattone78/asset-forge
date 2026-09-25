# syntax=docker/dockerfile:1.7
# Asset Forge — svc-audio: CPU-only narration (Kokoro-82M, Apache-2.0) + ffmpeg. No GPU, never touches comfyui.
# Run per job as uid 1000 with /srv/forge bind-mounted:
#   sudo nerdctl run --rm --user 1000:1000 -v /srv/forge:/srv/forge forge/svc-audio:0.1.0 --text "…" --voice af_heart --out-dir … --name …
FROM python:3.12-slim-bookworm

ARG KOKORO_VERSION=0.9.4
ARG TORCH_VERSION=2.8.0
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HUB_OFFLINE=1 HF_HOME=/tmp/hf HOME=/tmp \
    KOKORO_MODEL_DIR=/srv/forge/models/kokoro

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg espeak-ng libsndfile1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# CPU torch wheel first (the default index would pull the multi-GB CUDA build), then kokoro + misaki (English G2P).
RUN pip install "torch==${TORCH_VERSION}" --index-url https://download.pytorch.org/whl/cpu && \
    pip install "kokoro==${KOKORO_VERSION}" "misaki[en]>=0.9.4" soundfile && \
    pip freeze | grep -iE "^(torch|kokoro|misaki|transformers|soundfile|numpy)=" > /opt/versions.txt

COPY tts.py /opt/tts.py
ENTRYPOINT ["python", "/opt/tts.py"]
