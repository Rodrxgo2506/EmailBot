#!/usr/bin/env bash
# IMAP E2 - local, THROWAWAY Dovecot (dovecot/dovecot:2.4.5) for apps/worker/src/test/imap-integration.test.ts.
# Never remote, never real mailboxes. See docs/imap.md ("Integration tests").
#
#   certs            test CA + server certificate (imap.emailbot-e2-integration.com) + an UNTRUSTED
#                    self-signed certificate + a random test password, in $WORK (outside the repository;
#                    the CA private key is discarded right away)
#   start <A|B|C>    one scenario at a time, published on 127.0.0.1 only (993 and 143):
#                      A  valid certificate (test CA): TLS on 993, STARTTLS on 143
#                      B  untrusted self-signed certificate on 993 / 143
#                      C  NO TLS at all (ssl = no): 143 offers no STARTTLS but would accept a plaintext login
#   uidvalidity <n> [user]   doveadm: set the INBOX UIDVALIDITY of a test user
#   flags [user] | logs [n] | status
#   stop             removes ONLY containers labelled emailbot-imap-e2=1
#   clean            deletes $WORK (certificates, keys, test password)
#   paths            prints the script and $WORK paths (no Docker, creates nothing)
#
# $WORK = $IMAP_E2_WORK, default ${TMPDIR:-/tmp}/emailbot-imap-e2. On Windows + WSL point it at a
# Windows drive (e.g. /mnt/c/...) so the test process can read $WORK/ca.pem (NODE_EXTRA_CA_CERTS).
set -uo pipefail
WORK="${IMAP_E2_WORK:-${TMPDIR:-/tmp}/emailbot-imap-e2}"
IMAGE=dovecot/dovecot:2.4.5
NAME=emailbot-imap-e2
HOSTNAME_TLS=imap.emailbot-e2-integration.com
enter_work() {
  mkdir -p "$WORK" && cd "$WORK" || exit 2
}

case "${1:-}" in
  paths)
    echo "script: $(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
    echo "work:   $WORK"
    echo "image:  $IMAGE"
    ;;
  certs)
    enter_work
    rm -f ./*.pem ./*.srl ./*.cnf
    openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key.pem -out ca.pem -days 2 -subj "/CN=EmailBot E2 test CA" >/dev/null 2>&1 || exit 2
    printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$HOSTNAME_TLS" > server.cnf
    openssl req -newkey rsa:2048 -nodes -keyout server.key.pem -out server.csr.pem -subj "/CN=$HOSTNAME_TLS" >/dev/null 2>&1 || exit 2
    openssl x509 -req -in server.csr.pem -CA ca.pem -CAkey ca.key.pem -CAcreateserial -out server.pem -days 2 -extfile server.cnf >/dev/null 2>&1 || exit 2
    openssl req -x509 -newkey rsa:2048 -nodes -keyout untrusted.key.pem -out untrusted.pem -days 2 -subj "/CN=$HOSTNAME_TLS" -addext "subjectAltName=DNS:$HOSTNAME_TLS" >/dev/null 2>&1 || exit 2
    rm -f server.csr.pem ca.key.pem ca.srl
    chmod 644 ./*.pem
    # Test-only login (random, never printed, never in Git).
    head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' > password.txt
    echo "certs ready in $WORK (CA key discarded)"
    ;;
  start)
    scenario="${2:-A}"
    enter_work
    docker rm -f -v "$NAME" >/dev/null 2>&1
    case "$scenario" in
      A) cert=server.pem; key=server.key.pem; extra="" ;;
      B) cert=untrusted.pem; key=untrusted.key.pem; extra="" ;;
      C) cert=server.pem; key=server.key.pem; extra=$'ssl = no\nauth_allow_cleartext = yes\n' ;;
      *) echo "unknown scenario"; exit 2 ;;
    esac
    printf '%s' "$extra" > zz-test.conf
    docker run -d --name "$NAME" --label emailbot-imap-e2=1 \
      -e USER_PASSWORD="$(cat password.txt)" \
      -p 127.0.0.1:993:31993 -p 127.0.0.1:143:31143 \
      -v "$WORK/$cert:/etc/dovecot/ssl/tls.crt:ro" -v "$WORK/$key:/etc/dovecot/ssl/tls.key:ro" \
      -v "$WORK/zz-test.conf:/etc/dovecot/conf.d/zz-test.conf:ro" \
      "$IMAGE" >/dev/null || exit 2
    for _ in $(seq 1 30); do
      docker logs "$NAME" 2>&1 | grep -q "starting up" && break
      sleep 1
    done
    sleep 1
    docker ps --filter "name=^${NAME}$" --format '{{.Names}} {{.Status}} {{.Ports}}'
    ;;
  uidvalidity)
    docker exec "$NAME" doveadm mailbox update -u "${3:-tester@emailbot-e2-integration.com}" --uid-validity "${2:?uidvalidity}" INBOX && echo "uidvalidity set"
    ;;
  flags)
    docker exec "$NAME" doveadm fetch -u "${2:-tester@emailbot-e2-integration.com}" "uid flags" mailbox INBOX all
    ;;
  logs)
    docker logs "$NAME" 2>&1 | tail -n "${2:-40}"
    ;;
  status)
    docker ps -a --filter "label=emailbot-imap-e2=1" --format '{{.Names}} {{.Status}} {{.Ports}}'
    ;;
  stop)
    ids=$(docker ps -aq --filter "label=emailbot-imap-e2=1")
    [ -n "$ids" ] && docker rm -f -v $ids >/dev/null
    echo "removed: ${ids:-none}"
    ;;
  clean)
    rm -rf "$WORK" && echo "removed $WORK"
    ;;
  *) echo "usage: certs | start A|B|C | uidvalidity <n> [user] | flags [user] | logs [n] | status | stop | clean | paths"; exit 2 ;;
esac
