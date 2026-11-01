FROM node:22.15.0-slim
RUN apt-get update && apt-get install -y --no-install-recommends procps=2:4.0.2-3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && mkdir storage && chown node:node storage
COPY --chown=node:node .actor ./.actor
COPY --chown=node:node src ./src
USER node
CMD ["npm", "start"]
