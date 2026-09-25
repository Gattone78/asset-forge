# syntax=docker/dockerfile:1.7
# Asset Forge — comfyui service image.
# Pinned: ComfyUI v0.36.0 (commit below), torch 2.14.0+cu130 (Blackwell sm_120, driver 580.x / CUDA 13.0).
# TRELLIS.2 is native in ComfyUI core since PR #14718 (2026-08-22): pure PyTorch, no CUDA extensions to build.
# Custom nodes are pinned to commits here; there is no ComfyUI-Manager and no auto-update.
ARG CUDA_BASE=nvidia/cuda:13.0.3-base-ubuntu24.04
FROM ${CUDA_BASE}

ARG COMFYUI_COMMIT=ee71d5c4993f29086b27fde1629a945ae48425bf
ARG TORCH_VERSION=2.14.0
ARG TORCH_INDEX=https://download.pytorch.org/whl/cu130
ARG UNIRIG_COMMIT=69ee59dc459d2da7cb0291930c1f944886c31d7c
ARG MMAUDIO_COMMIT=8eaeb72edc3a

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev git ca-certificates curl \
      libgl1 libglib2.0-0 libegl1 libgomp1 \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# The CUDA base image ships an "ubuntu" user at uid 1000; rename it so the container user matches hqadmin (uid 1000) on the host bind mounts.
RUN usermod -l comfy -d /home/comfy -m ubuntu && groupmod -n comfy ubuntu
RUN python3 -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

# torch first so ComfyUI's unpinned "torch" requirement is already satisfied by the CUDA wheel.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install --upgrade pip wheel setuptools && \
    pip install "torch==${TORCH_VERSION}" torchvision torchaudio --index-url "${TORCH_INDEX}"

RUN git init -q /opt/ComfyUI && cd /opt/ComfyUI && \
    git remote add origin https://github.com/Comfy-Org/ComfyUI.git && \
    git fetch -q --depth 1 origin "${COMFYUI_COMMIT}" && \
    git checkout -q FETCH_HEAD && \
    git rev-parse HEAD > /opt/ComfyUI/.forge-commit

RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r /opt/ComfyUI/requirements.txt && \
    pip install trimesh   # for mesh assertions in Phase 1 test scripts

# UniRig auto-rig node, pinned. Its heavy deps (bpy, spconv, flash-attn, torch-scatter) live in a
# comfy-env / pixi isolated environment created at first run under $COMFY_ENV_ROOT, which is a
# /srv/forge bind mount so the multi-GB env is persistent and off the root disk. See docs/phase-1.md.
RUN git clone -q https://github.com/PozzettiAndrea/ComfyUI-UniRig.git /opt/ComfyUI/custom_nodes/ComfyUI-UniRig && \
    cd /opt/ComfyUI/custom_nodes/ComfyUI-UniRig && git checkout -q "${UNIRIG_COMMIT}" && \
    git rev-parse HEAD > .forge-commit
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r /opt/ComfyUI/custom_nodes/ComfyUI-UniRig/requirements.txt

# MMAudio video/text-to-audio node (Phase 7 foley), MIT, pinned. Pure-Python deps; BigVGAN and the model
# weights are read from models/mmaudio (models/mmaudio/nvidia/bigvgan_v2_44khz_128band_512x is pre-downloaded,
# so the node's snapshot_download never runs).
RUN git clone -q https://github.com/kijai/ComfyUI-MMAudio.git /opt/ComfyUI/custom_nodes/ComfyUI-MMAudio && \
    cd /opt/ComfyUI/custom_nodes/ComfyUI-MMAudio && git checkout -q "${MMAUDIO_COMMIT}" && \
    git rev-parse HEAD > .forge-commit
RUN --mount=type=cache,target=/root/.cache/pip \
    pip install -r /opt/ComfyUI/custom_nodes/ComfyUI-MMAudio/requirements.txt && \
    python -c "import torch, torchaudio, timm, open_clip, torchdiffeq, librosa; print('torch', torch.__version__, 'torchaudio', torchaudio.__version__, 'timm', timm.__version__)"

# Record resolved versions for docs/phase-1.md
RUN pip freeze | grep -iE "^(torch|torchvision|torchaudio|comfyui-frontend-package|comfyui-workflow-templates|numpy|transformers|safetensors|trimesh|comfy-env|comfy-3d-viewers|timm|open-clip-torch|torchdiffeq|librosa)=" > /opt/ComfyUI/.forge-versions

RUN mkdir -p /opt/ComfyUI/models /opt/ComfyUI/output /opt/ComfyUI/input /opt/ComfyUI/temp /opt/ComfyUI/user /opt/ComfyUI/ce && \
    chown -R comfy:comfy /opt/ComfyUI
USER comfy
WORKDIR /opt/ComfyUI

# HF cache lives on the models bind mount (/srv/forge/models/hf on the host); comfy-env root likewise.
ENV HF_HOME=/opt/ComfyUI/models/hf \
    HF_HUB_DISABLE_TELEMETRY=1 \
    COMFY_ENV_ROOT=/opt/ComfyUI/ce

EXPOSE 8188
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188", "--disable-auto-launch"]
