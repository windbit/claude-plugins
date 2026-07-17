# Integration-test image for the telegram-tmux-channels hub.
# Ubuntu + tmux + Claude Code (native installer) + bun (runs the hub) + the apt basics
# Claude Code reaches for. Meant to run the hub AND spawn `claude` sessions in tmux inside
# an ISOLATED container (own home volume, own bot) so changes are tested end-to-end before
# touching the live VM. Not a production image.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git tmux jq ripgrep fd-find less procps \
      python3 python3-venv python3-pip build-essential unzip zip nano vim \
      coreutils gnupg openssh-client locales sudo zsh \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

# Node 22 (some skills / npx tools — e.g. claude-mem — need it; the hub itself runs on bun)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# uid 1000 to match the host user (bind-mounted files keep sane ownership). Ubuntu 24.04 ships a
# default `ubuntu` user already on uid 1000 — drop it first.
RUN userdel -r ubuntu 2>/dev/null || true; \
    useradd -m -s /bin/bash -u 1000 user && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user
USER user
WORKDIR /home/user
ENV PATH=/home/user/.bun/bin:/home/user/.local/bin:$PATH

# bun (runs the hub) + Claude Code (native installer, same as the host)
RUN curl -fsSL https://bun.sh/install | bash
RUN curl -fsSL https://claude.ai/install.sh | bash

# The hub code is bind-mounted at run time (so host edits are testable live) — see
# docker-compose.yml. Auth + per-session state live in the persistent home volume.
CMD ["sleep", "infinity"]
