# syntax=docker/dockerfile:1.7
# Asset Forge — svc-post: CPU-only post stage. Node 22 + @gltf-transform/cli + Blender 4.5 LTS headless.
# Runs per job and exits:  nerdctl compose run --rm svc-post node post.mjs --in ... --out ...
FROM node:22-bookworm-slim

ARG BLENDER_VERSION=4.5.14
ARG BLENDER_URL=https://download.blender.org/release/Blender4.5/blender-${BLENDER_VERSION}-linux-x64.tar.xz
ARG GLTF_TRANSFORM_VERSION=4.5.0

ENV DEBIAN_FRONTEND=noninteractive
# Blender's headless runtime needs these even with no display (Cycles CPU, no EGL required for -b).
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils python3 ffmpeg fonts-dejavu-core \
      libx11-6 libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 libsm6 libice6 \
      libgl1 libegl1 libgomp1 libxcb1 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "${BLENDER_URL}" -o /tmp/blender.tar.xz && \
    mkdir -p /opt/blender && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 && \
    rm /tmp/blender.tar.xz && /opt/blender/blender --version
ENV PATH=/opt/blender:$PATH

WORKDIR /app
RUN --mount=type=cache,target=/root/.npm \
    npm install -g "@gltf-transform/cli@${GLTF_TRANSFORM_VERSION}" && gltf-transform --version
COPY package.json post.mjs ./
COPY blender ./blender

# Run as the host's hqadmin uid/gid (compose sets user: "1000:1000") so job folders stay hqadmin-owned.
# Blender needs writable config/cache dirs for any uid, hence /tmp.
ENV HOME=/tmp BLENDER_USER_CONFIG=/tmp/blender-config BLENDER_USER_SCRIPTS=/tmp/blender-scripts XDG_CONFIG_HOME=/tmp/xdg XDG_CACHE_HOME=/tmp/xdg-cache
ENTRYPOINT ["node", "/app/post.mjs"]
