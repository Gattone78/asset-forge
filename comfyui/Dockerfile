# syntax=docker/dockerfile:1.7
# Asset Forge — comfyui service image.
# Pinned: ComfyUI v0.36.0 (commit below), torch 2.14.0+cu130 (Blackwell sm_120, driver 580.x / CUDA 13.0).
# TRELLIS.2 is native in ComfyUI core since PR #14718 (2026-08-22): pure PyTorch, no CUDA extensions to build.
# Custom nodes (if any) are pinned to commits here; there is no ComfyUI-Manager and no auto-update.
ARG CUDA_BASE=nvidia/cuda:13.0.3-base-ubuntu24.04
FROM ${CUDA_BASE}

ARG COMFYUI_COMMIT=ee71d5c4993f29086b27fde1629a945ae48425bf
ARG TORCH_VERSION=2.14.0
ARG TORCH_INDEX=https://download.pytorch.org/whl/cu130

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev git ca-certificates curl \
      libgl1 libglib2.0-0 libegl1 libgomp1 \
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

# Record resolved versions for docs/phase-1.md
RUN pip freeze | grep -iE "^(torch|torchvision|torchaudio|comfyui-frontend-package|comfyui-workflow-templates|numpy|transformers|safetensors|trimesh)=" > /opt/ComfyUI/.forge-versions

RUN mkdir -p /opt/ComfyUI/models /opt/ComfyUI/output /opt/ComfyUI/input /opt/ComfyUI/temp /opt/ComfyUI/user && \
    chown -R comfy:comfy /opt/ComfyUI
USER comfy
WORKDIR /opt/ComfyUI

# HF cache lives on the models bind mount (/srv/forge/models/hf on the host).
ENV HF_HOME=/opt/ComfyUI/models/hf \
    HF_HUB_DISABLE_TELEMETRY=1

EXPOSE 8188
CMD ["python", "main.py", "--listen", "0.0.0.0", "--port", "8188", "--disable-auto-launch"]
