# Sandboxed MDB extraction image. Run with --network none (see worker/ingest/extract.ts).
FROM debian:bookworm-20261020-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

RUN apt-get update \
 && apt-get install -y --no-install-recommends mdbtools=1.0.0+dfsg-1.1 \
 && rm -rf /var/lib/apt/lists/*

USER 65534:65534
WORKDIR /tmp
