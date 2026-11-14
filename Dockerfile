# Kinmesh hub: the compiled server and the built workspace, nothing else.
# Configuration comes from the environment; the database is PostgreSQL at
# KINMESH_DATABASE_URL, and the hub's own files live in /data.

FROM node:24-bookworm-slim AS toolchain
WORKDIR /src
COPY package.json package-lock.json ./

FROM toolchain AS build
RUN npm ci
COPY . .
RUN npm run build

FROM toolchain AS dependencies
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=dependencies /src/node_modules ./node_modules
# Only what runs: compiled JavaScript, migrations and the workspace assets.
COPY --from=build /src/dist ./dist
RUN find dist -name '*.d.ts' -delete \
  && mkdir -p /data && chown node:node /data
USER node
ENV KINMESH_HOST=0.0.0.0 \
    KINMESH_PORT=3000 \
    KINMESH_STATE=/data
VOLUME ["/data"]
EXPOSE 3000
# Ready, not merely alive: the database answers and any worker is connected.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+process.env.KINMESH_PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/src/server/main.js"]
