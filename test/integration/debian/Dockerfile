# A Debian machine to install Loui on, for the integration tests
# (.github/workflows/integration.yml, the "debian" job): systemd as PID 1, so
# that the relay's and the headless browser's units are started for real; a
# virtual display and a window manager; polkit, for the update's request to
# install as root; an ordinary user to run Loui and the tests as (Chromium
# refuses to run as root), who may use sudo; and another for the headless
# Loui's service. Loui's own dependencies are not here: apt must bring them.
ARG RELEASE=12
FROM debian:${RELEASE}
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus sudo ca-certificates curl procps \
      xvfb xauth x11-utils xdotool xfwm4 xfconf imagemagick desktop-file-utils \
      polkitd pkexec \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash tester \
    && useradd -m -s /bin/bash headless \
    && echo 'tester ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/tester \
    && systemctl mask getty.target console-getty.service \
    # Debian's container image forbids packages to start their services (it is
    # made for building images); a machine does not.
    && rm -f /usr/sbin/policy-rc.d
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
