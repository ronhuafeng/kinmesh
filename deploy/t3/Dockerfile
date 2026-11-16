# The agents' runtime beside the hub: unmodified T3 Code, and the pi agent
# it runs. Agents work in /space; T3's state lives in /opt/t3/userdata and
# pi's in ~/.pi/agent, both on volumes the deployment provides.
FROM node:24-bookworm-slim
ARG T3CODE_VERSION=0.1.9
ARG PI_VERSION=1.5.2
# The second line is what T3's headless browser needs: the libraries and fonts
# `t3 browser setup` installs, and a CJK font so Chinese pages render. T3
# downloads Chrome itself when a browser tab first opens.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client ripgrep fd-find tini \
    fontconfig fonts-liberation fonts-wqy-microhei libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libdbus-1-3 libgbm1 libglib2.0-0 libnss3 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd
RUN npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}" && npm cache clean --force
ENV T3CODE_HOME=/opt/t3
RUN curl -fsSL https://t3.codes/install.sh \
  | T3CODE_VERSION="${T3CODE_VERSION}" T3CODE_INSTALL_BIN_DIR=/usr/local/bin sh \
  && t3 --version && pi --version \
  && mkdir -p /opt/t3/userdata /space /home/node/.pi/agent \
  && chown -R node:node /opt/t3 /space /home/node
USER node
WORKDIR /space
EXPOSE 3773
ENTRYPOINT ["tini", "--"]
CMD ["t3", "serve", "--mode", "web", "--host", "0.0.0.0", "--port", "3773", "--no-browser"]
