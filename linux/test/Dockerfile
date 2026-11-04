# Isolated ARM64 test environment; it is not a production image.
FROM node@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914

# Pin every package added to the base image; fail if the reviewed binaries differ.
RUN test "$(uname -m)" = aarch64 \
    && apk add --no-cache \
    json-c=0.18-r1 \
    libevent=2.1.13-r0 \
    libncursesw=6.6_p20260516-r0 \
    libuv=1.52.1-r0 \
    libwebsockets=4.3.5-r2 \
    libwebsockets-evlib_uv=4.3.5-r2 \
    ncurses-terminfo-base=6.6_p20260516-r0 \
    tmux=3.7c-r0 \
    ttyd=1.7.7-r0 \
    && echo 'b676aa136782b513866867ce896cf66a1ee7edbb7dac211fda045b39487bf03b  /usr/bin/tmux' | sha256sum -c - \
    && echo '9596def3bf6a67cbce65080767ddd286dff1585fd83eea216ebd854a8a3cd93a  /usr/bin/ttyd' | sha256sum -c -

WORKDIR /workspace/linux
COPY ui ./ui
COPY test/integration.test.js test/connection-ui.test.js test/clipboard-bridge.test.js test/image-ui.test.js test/navigation-ui.test.js test/mobile-keys.test.js test/display-controls.test.js test/runtime-guard.test.js ./test/
USER node
CMD ["node", "--test", "test/integration.test.js", "test/connection-ui.test.js", "test/clipboard-bridge.test.js", "test/image-ui.test.js", "test/navigation-ui.test.js", "test/mobile-keys.test.js", "test/display-controls.test.js", "test/runtime-guard.test.js"]
