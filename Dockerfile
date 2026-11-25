FROM node:22-alpine
WORKDIR /app
COPY index.html server.mjs ./
COPY fonts ./fonts
# Named volume mounted here keeps RSVPs across redeploys; image seeds correct ownership.
RUN mkdir data && chown node:node data
USER node
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "server.mjs"]
