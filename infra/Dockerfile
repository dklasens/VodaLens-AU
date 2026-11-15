# Pin the official multi-architecture runtime. Update the tag and digest together
# after reviewing official library/node registry metadata and running the tests.
FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
WORKDIR /app
COPY packages ./packages
COPY services/api/package.json ./services/api/package.json
COPY services/api/src ./services/api/src
COPY services/api/migrations ./services/api/migrations
RUN mkdir -p /var/lib/vodalens && chown node:node /var/lib/vodalens
USER node
ENV HOST=0.0.0.0 PORT=8766 DATABASE_PATH=/var/lib/vodalens/vodalens.sqlite
EXPOSE 8766
CMD ["node", "services/api/src/server.cjs"]
