# syntax=docker/dockerfile:1.6

# Use Node.js 24 LTS slim image as base
FROM node:24-slim

# Set working directory
WORKDIR /src

# Environment
ENV NODE_ENV=production
ENV MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD=true

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install dependencies (cache npm)
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# bravio: copy AS the node user rather than copying and then chowning the world.
#
# `RUN chown -R node:node /src` walked every file in /src, node_modules and the compiled
# mediasoup worker included, and on overlayfs that copies the whole tree into a new layer.
# Measured on the dev box on 4-9-2026: thirteen minutes and still going, at under one percent
# CPU, because it is bound by disk rather than by work. `--chown` on the copies costs nothing
# and produces no duplicate layer.
#
# node_modules stays owned by root and readable, which is the usual arrangement: the app never
# writes there. The one directory it does write to, the recordings directory, is a bind mount
# owned by uid 1000 on the host.
COPY --chown=node:node app ./app
COPY --chown=node:node public ./public

# Copy config template → config
COPY --chown=node:node app/src/config.template.js app/src/config.js

# Run as the non-root "node" user (uid/gid 1000) shipped with the base image
USER node

# Default command
CMD ["npm", "start"]