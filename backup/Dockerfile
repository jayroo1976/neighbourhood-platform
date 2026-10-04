FROM postgres:16-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -sSL https://aka.ms/downloadazcopy-v10-linux | tar -xz --strip-components=1 -C /usr/local/bin --wildcards '*/azcopy' \
 && rm -rf /var/lib/apt/lists/*
COPY backup.sh /backup.sh
ENTRYPOINT ["bash", "/backup.sh"]
