# There are no dependencies, so there is no npm install, no lockfile to drift,
# no supply chain and nothing fetched at build time. That is worth more here
# than any convenience a package would buy.
#
# TODO: pin by digest once the first build on the Pi records one. Written on a
# machine with no Docker, so no digest could be verified rather than guessed.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY index.js ./
COPY lib ./lib

ENV NODE_ENV=production

# PID 1 is Docker's init (config.yaml keeps init: true), which forwards SIGTERM
# to node. The daemon's own handler flushes the capture buffer and exits.
CMD ["node", "index.js"]
