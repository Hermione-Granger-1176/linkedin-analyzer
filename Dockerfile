FROM python:3.12-slim@sha256:ccc7089399c8bb65dd1fb3ed6d55efa538a3f5e7fca3f5988ac3b5b87e593bf0 AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

COPY pyproject.toml README.md /build/
COPY src /build/src

RUN python -m pip install --upgrade pip build \
    && python -m build --wheel --outdir /dist

FROM python:3.12-slim@sha256:ccc7089399c8bb65dd1fb3ed6d55efa538a3f5e7fca3f5988ac3b5b87e593bf0 AS runtime

ARG VERSION=dev
ARG REVISION=unknown
ARG SOURCE_URL="https://github.com/Hermione-Granger-1176/linkedin-analyzer"

LABEL org.opencontainers.image.title="linkedin-analyzer" \
      org.opencontainers.image.description="LinkedIn analyzer CLI" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --create-home --home-dir /home/app app

WORKDIR /app

COPY --from=builder /dist/*.whl /tmp/

RUN python -m pip install --upgrade pip \
    && python -m pip install /tmp/*.whl \
    && rm -f /tmp/*.whl

USER app

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["linkedin-analyzer", "--version"]

ENTRYPOINT ["linkedin-analyzer"]
