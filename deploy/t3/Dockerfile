# The agents' runtime beside the hub: unmodified T3 Code, and the coding
# agents it runs (pi, Codex, Claude Code). Agents work in /space; T3's state
# lives in /opt/t3/userdata and the agents' in the home folder, both on
# volumes the deployment provides. T3 is the image's; the coding agents go
# into ~/.local at start (agents.ts), where upgrading them lasts.
FROM node:26-bookworm-slim
ARG T3CODE_VERSION=0.1.11
ARG PI_VERSION=1.5.2
ARG CODEX_VERSION=0.169.1
ARG CLAUDE_CODE_VERSION=2.1.327
# The second line is what T3's headless browser needs: the libraries and fonts
# `t3 browser setup` installs, Noto for the other scripts (Arabic, Hebrew,
# Indic, Thai, …) and colour emoji, and a CJK font so Chinese pages render.
# T3 downloads Chrome itself into /opt/t3/tools when a browser tab first opens.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client ripgrep fd-find tini \
    fontconfig fonts-liberation fonts-noto-color-emoji fonts-noto-core fonts-wqy-microhei libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libdbus-1-3 libgbm1 libglib2.0-0 libnss3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd
# The floor of each coding agent, put into the persistent prefix at start.
RUN npm install -g --prefix /opt/agents \
    "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    "@openai/codex@${CODEX_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force
ENV T3CODE_HOME=/opt/t3
RUN curl -fsSL https://t3.codes/install.sh \
  | T3CODE_VERSION="${T3CODE_VERSION}" T3CODE_INSTALL_BIN_DIR=/usr/local/bin sh \
  && t3 --version \
  && mkdir -p /opt/t3/userdata /space /home/node/.pi/agent \
  && chown -R node:node /opt/t3 /space /home/node
# The space provisioner (space.ts): makes a channel's folder a T3 project for
# the hub. The deployment runs it beside T3 with `node /opt/kinmesh/space.ts`.
COPY space.ts /opt/kinmesh/space.ts
COPY agents.ts /opt/kinmesh/agents.ts
USER node
# What T3, its agents and a person in its terminal install with npm lasts.
ENV NPM_CONFIG_PREFIX=/home/node/.local
ENV PATH=/home/node/.local/bin:$PATH
WORKDIR /space
EXPOSE 3773
ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "node /opt/kinmesh/agents.ts && exec t3 serve --mode web --host 0.0.0.0 --port 3773 --no-browser"]
