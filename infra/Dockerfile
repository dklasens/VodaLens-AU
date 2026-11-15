FROM node:26-bookworm-slim
WORKDIR /app
COPY packages ./packages
COPY services/api ./services/api
RUN mkdir -p /var/lib/vodalens && chown node:node /var/lib/vodalens
USER node
ENV HOST=0.0.0.0 PORT=8766 DATABASE_PATH=/var/lib/vodalens/vodalens.sqlite
EXPOSE 8766
CMD ["node", "services/api/src/server.cjs"]
