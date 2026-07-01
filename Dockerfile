FROM python:3.14-slim@sha256:b877e50bd90de10af8d82c57a022fc2e0dc731c5320d762a27986facfc3355c1 AS builder

ARG VERSION=0.0.0

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /build

COPY pyproject.toml README.md /build/
COPY src /build/src

RUN python -m pip install --upgrade pip==26.1.2 build==1.5.0 \
    && SETUPTOOLS_SCM_PRETEND_VERSION="$VERSION" python -m build --wheel --outdir /dist

FROM python:3.14-slim@sha256:b877e50bd90de10af8d82c57a022fc2e0dc731c5320d762a27986facfc3355c1 AS runtime

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
