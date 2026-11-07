# Caddy for the static site, as an unprivileged user. It listens on 8080, so it needs no capabilities. The stock
# binary carries a file capability that will not exec under no-new-privileges, and copying it drops that.
FROM caddy:2.11.4-alpine
RUN cp /usr/bin/caddy /tmp/caddy && mv /tmp/caddy /usr/bin/caddy
USER 65534:65534
