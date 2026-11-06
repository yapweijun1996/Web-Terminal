/* Standalone macOS mechanism experiment. Never used as an authorization service. */
#ifndef __APPLE__
#error This probe requires macOS
#endif
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/ucred.h>
#include <sys/stat.h>
#include <poll.h>
#include <time.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>
#include <limits.h>
#include <stdint.h>

static int directory_fd = -1, socket_owned = 0;
static pid_t owner_pid;
static char directory_path[PATH_MAX];
static struct stat directory_identity, socket_identity;
static int same_identity(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
static int directory_valid(void) {
    struct stat path, opened;
    return directory_fd >= 0 && !lstat(directory_path, &path) && !fstat(directory_fd, &opened) &&
        S_ISDIR(path.st_mode) && S_ISDIR(opened.st_mode) && path.st_uid == geteuid() &&
        opened.st_uid == geteuid() && (opened.st_mode & 07777) == 0700 &&
        (path.st_mode & 07777) == 0700 && same_identity(&path, &directory_identity) &&
        same_identity(&opened, &directory_identity);
}
static int socket_valid(void) {
    struct stat st;
    return directory_valid() && !fstatat(directory_fd, "socket", &st, AT_SYMLINK_NOFOLLOW) &&
        S_ISSOCK(st.st_mode) && st.st_uid == geteuid() && st.st_nlink == socket_identity.st_nlink &&
        same_identity(&st, &socket_identity);
}
static int cleanup_socket(void) {
    if (getpid() != owner_pid || !socket_owned) return 0;
    if (!socket_valid() || unlinkat(directory_fd, "socket", 0)) {
        fprintf(stderr, "socket identity changed; cleanup refused\n"); return -1;
    }
    socket_owned = 0;
    return 0;
}
/* Drift checks for a disposable probe, not a same-UID security boundary. */
static int safe_ancestors(const char *temp) {
    char path[PATH_MAX];
    if (strlen(temp) >= sizeof(path)) return 0;
    strcpy(path, temp);
    for (;;) {
        struct stat st;
        if (lstat(path, &st) || !S_ISDIR(st.st_mode)) return 0;
        int sticky_tmp = !strcmp(path, "/private/tmp") && st.st_uid == 0 &&
            (st.st_mode & S_ISVTX);
        if (!sticky_tmp && ((st.st_uid != 0 && st.st_uid != geteuid()) ||
            (st.st_mode & 0022))) return 0;
        if (!strcmp(path, "/")) break;
        char *slash = strrchr(path, '/');
        if (!slash) return 0;
        if (slash == path) path[1] = '\0'; else *slash = '\0';
    }
    return 1;
}
static void cleanup_at_exit(void) { (void)cleanup_socket(); }
static void die(const char *s) { perror(s); exit(1); }
static void setupfd(int fd) {
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) == -1) die("FD_CLOEXEC");
}
static long long now_ms(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) die("clock_gettime");
    return (long long)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
/* One deadline covers the complete operation, including retries and partial I/O. */
static int ready(int fd, short events, long long deadline) {
    for (;;) {
        long long remaining = deadline - now_ms();
        if (remaining <= 0) { errno = ETIMEDOUT; return 0; }
        struct pollfd p = { fd, events, 0 };
        int n = poll(&p, 1, (int)remaining);
        if (n > 0) return 1; /* The I/O call reports EOF or errors. */
        if (n == 0) { errno = ETIMEDOUT; return 0; }
        if (errno != EINTR) die("poll");
    }
}
static void snapshot(int fd, const char *label, uid_t *uid, gid_t *gid) {
    struct xucred cr; socklen_t n = sizeof(cr);
    memset(&cr, 0, sizeof(cr));
    if (getpeereid(fd, uid, gid) == -1 || getsockopt(fd, SOL_LOCAL, LOCAL_PEERCRED, &cr, &n) == -1) die("peer credentials");
    if (n != sizeof(cr) || cr.cr_version != XUCRED_VERSION || cr.cr_ngroups < 1 || cr.cr_ngroups > NGROUPS || cr.cr_uid != *uid || cr.cr_groups[0] != *gid) {
        fprintf(stderr, "invalid or inconsistent peer credentials\n"); exit(1);
    }
    printf("%s uid=%u gid=%u groups=%d xucred_length=%u\n", label, (unsigned)*uid, (unsigned)*gid, cr.cr_ngroups, (unsigned)n);
}
static void send_all(int fd, const char *buf, size_t n) {
    long long deadline = now_ms() + 1000;
    while (n) {
        if (!ready(fd, POLLOUT, deadline)) die("send timeout");
        ssize_t w = send(fd, buf, n, MSG_DONTWAIT);
        if (w < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (w <= 0) die("send");
        buf += w; n -= (size_t)w;
    }
}
/* Test-only transfer. It deliberately does not implement an ancillary-data policy. */
static void send_fd(int sock, int fd) {
    char byte = 'F'; struct iovec iov = { &byte, 1 };
    union { struct cmsghdr align; char buf[CMSG_SPACE(sizeof(int))]; } c = {0};
    struct msghdr msg = {0}; msg.msg_iov = &iov; msg.msg_iovlen = 1; msg.msg_control = c.buf; msg.msg_controllen = sizeof(c.buf);
    struct cmsghdr *h = CMSG_FIRSTHDR(&msg); h->cmsg_level = SOL_SOCKET; h->cmsg_type = SCM_RIGHTS; h->cmsg_len = CMSG_LEN(sizeof(int)); memcpy(CMSG_DATA(h), &fd, sizeof(fd));
    long long deadline = now_ms() + 1000;
    for (;;) {
        if (!ready(sock, POLLOUT, deadline)) die("sendmsg timeout");
        ssize_t n = sendmsg(sock, &msg, MSG_DONTWAIT);
        if (n == 1) break;
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        die("sendmsg");
    }
}
static void send_many_fds(int sock, int fd, size_t count) {
    if (count < 1 || count > 32) { errno = EINVAL; die("rights count"); }
    char byte = 'F'; struct iovec iov = { &byte, 1 };
    union { struct cmsghdr align; char buf[CMSG_SPACE(sizeof(int) * 32)]; } c = {0};
    struct msghdr msg = {0}; msg.msg_iov = &iov; msg.msg_iovlen = 1;
    msg.msg_control = c.buf; msg.msg_controllen = CMSG_SPACE(count * sizeof(int));
    struct cmsghdr *h = CMSG_FIRSTHDR(&msg); h->cmsg_level = SOL_SOCKET;
    h->cmsg_type = SCM_RIGHTS; h->cmsg_len = CMSG_LEN(count * sizeof(int));
    for (size_t i = 0; i < count; i++) memcpy((char *)CMSG_DATA(h) + i * sizeof(int), &fd, sizeof(fd));
    long long deadline = now_ms() + 1000;
    for (;;) {
        if (!ready(sock, POLLOUT, deadline)) die("sendmsg timeout");
        ssize_t n = sendmsg(sock, &msg, MSG_DONTWAIT);
        if (n == 1) return;
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        die("sendmsg");
    }
}
static int recv_fd(int sock) {
    char byte; struct iovec iov = { &byte, 1 };
    union { struct cmsghdr align; char buf[CMSG_SPACE(sizeof(int))]; } c = {0};
    struct msghdr msg = {0}; msg.msg_iov = &iov; msg.msg_iovlen = 1; msg.msg_control = c.buf; msg.msg_controllen = sizeof(c.buf);
    long long deadline = now_ms() + 1000;
    for (;;) {
        if (!ready(sock, POLLIN, deadline)) die("recvmsg timeout");
        ssize_t n = recvmsg(sock, &msg, MSG_DONTWAIT);
        if (n == 1) break;
        if (n < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        die("recvmsg");
    }
    if (msg.msg_flags & (MSG_CTRUNC | MSG_TRUNC)) { fprintf(stderr, "truncated transfer\n"); exit(1); }
    struct cmsghdr *h = CMSG_FIRSTHDR(&msg); int fd;
    if (!h || h->cmsg_level != SOL_SOCKET || h->cmsg_type != SCM_RIGHTS || h->cmsg_len != CMSG_LEN(sizeof(fd)) || CMSG_NXTHDR(&msg, h)) { fprintf(stderr, "invalid transfer\n"); exit(1); }
    memcpy(&fd, CMSG_DATA(h), sizeof(fd)); setupfd(fd); return fd;
}
/* Uncertain control is never interpreted as a complete descriptor inventory.
 * Only disposable fixture processes call this parser. On rejection they exit. */
struct control_result { int rejected, malformed, closed, truncated; };
static struct control_result inspect_control(void *buffer, size_t length, size_t capacity, int flags) {
    struct control_result r = { length != 0 || flags != 0, 0, 0,
        !!(flags & MSG_CTRUNC) };
    if (flags || length > capacity || (length && (uintptr_t)buffer % _Alignof(struct cmsghdr))) {
        r.rejected = 1; r.malformed = length > capacity || !!(flags & MSG_TRUNC) ||
            (length && (uintptr_t)buffer % _Alignof(struct cmsghdr));
        return r; /* Exit closes invisible rights; do not guess from partial controls. */
    }
    size_t offset = 0;
    /* Validate the entire buffer before interpreting any descriptor values. */
    while (offset < length) {
        size_t available = length - offset;
        if (offset % _Alignof(struct cmsghdr) || available < CMSG_LEN(0)) goto malformed;
        struct cmsghdr *h = (struct cmsghdr *)((char *)buffer + offset);
        if (h->cmsg_len < CMSG_LEN(0) || h->cmsg_len > available) goto malformed;
        size_t payload = h->cmsg_len - CMSG_LEN(0);
        if (h->cmsg_level != SOL_SOCKET || h->cmsg_type != SCM_RIGHTS ||
            !payload || payload % sizeof(int)) goto malformed;
        size_t step = CMSG_SPACE(payload);
        if (step < h->cmsg_len) goto malformed;
        if (step > available) {
            if (h->cmsg_len != available) goto malformed;
            offset = length;
        } else offset += step;
    }
    offset = 0;
    while (offset < length) {
        struct cmsghdr *h = (struct cmsghdr *)((char *)buffer + offset);
        size_t payload = h->cmsg_len - CMSG_LEN(0);
        for (size_t i = 0; i < payload; i += sizeof(int)) {
            int fd; memcpy(&fd, (char *)CMSG_DATA(h) + i, sizeof(fd));
            /* Only explicitly visible, fully validated SCM_RIGHTS handles. No retry
             * of close: a retry could close a reused descriptor on some platforms. */
            if (fd < 0 || close(fd)) r.malformed = 1;
            else r.closed++;
        }
        size_t step = CMSG_SPACE(payload);
        if (step > length - offset) break;
        offset += step;
    }
    return r;
malformed:
    r.rejected = 1; r.malformed = 1; return r;
}
/* Synthetic parser fixtures supplement real kernel SCM_RIGHTS tests. They do
 * not claim the kernel emits malformed cmsghdr structures. Each is disposable. */
static int control_fixture(const char *mode) {
    union { struct cmsghdr align; char buf[CMSG_SPACE(sizeof(int)) * 2 + 8]; } c = {0};
    int fds[2]; if (pipe(fds)) die("control fixture pipe");
    setupfd(fds[0]); setupfd(fds[1]);
    struct cmsghdr *h = (struct cmsghdr *)(void *)c.buf;
    h->cmsg_len = CMSG_LEN(sizeof(int)); h->cmsg_level = SOL_SOCKET; h->cmsg_type = SCM_RIGHTS;
    memcpy(CMSG_DATA(h), &fds[0], sizeof(int));
    size_t length = CMSG_SPACE(sizeof(int)), capacity = sizeof(c.buf);
    int flags = 0, expected_closed = 0, expected_malformed = 1;
    void *buffer = c.buf;
    if (!strcmp(mode, "ctrunc")) { flags = MSG_CTRUNC; expected_malformed = 0; }
    else if (!strcmp(mode, "trunc")) flags = MSG_TRUNC;
    else if (!strcmp(mode, "short-header")) length = sizeof(struct cmsghdr) - 1;
    else if (!strcmp(mode, "short-length")) h->cmsg_len = CMSG_LEN(0) - 1;
    else if (!strcmp(mode, "oversized-header")) h->cmsg_len = (socklen_t)(capacity + 1);
    else if (!strcmp(mode, "oversized-buffer")) length = capacity + 1;
    else if (!strcmp(mode, "partial-int")) h->cmsg_len = CMSG_LEN(sizeof(int) - 1);
    else if (!strcmp(mode, "unknown")) h->cmsg_type = -1;
    else if (!strcmp(mode, "misaligned")) buffer = c.buf + 1;
    else if (!strcmp(mode, "trailing")) length++;
    else if (!strcmp(mode, "multiple")) {
        struct cmsghdr *second = (struct cmsghdr *)(void *)(c.buf + length);
        second->cmsg_len = CMSG_LEN(sizeof(int)); second->cmsg_level = SOL_SOCKET; second->cmsg_type = SCM_RIGHTS;
        memcpy(CMSG_DATA(second), &fds[1], sizeof(int));
        length *= 2; expected_closed = 2; expected_malformed = 0;
    } else return 2;
    struct control_result r = inspect_control(buffer, length, capacity, flags);
    int intact = expected_closed ? fcntl(fds[0], F_GETFD) == -1 && errno == EBADF &&
        fcntl(fds[1], F_GETFD) == -1 && errno == EBADF :
        fcntl(fds[0], F_GETFD) >= 0 && fcntl(fds[1], F_GETFD) >= 0;
    printf("control_fixture=%s rejected=%d malformed=%d explicit_closed=%d handles_as_expected=%d authorization=false\n",
        mode, r.rejected, r.malformed, r.closed, intact);
    /* Process exit, rather than a parser claim, owns uncertain cleanup. */
    return r.rejected && r.malformed == expected_malformed && r.closed == expected_closed && intact ? 0 : 1;
}
static long long now_ns(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) die("clock_gettime");
    return (long long)t.tv_sec * 1000000000 + t.tv_nsec;
}
struct receiver_result {
    struct control_result control;
    long long recv_start, recv_end;
    int complete, io_error, recv_calls;
};
static ssize_t recv_checked(int sock, char *byte, long long deadline,
                            size_t capacity, struct receiver_result *result) {
    union { struct cmsghdr align; char buf[CMSG_SPACE(sizeof(int) * 16)]; } c;
    struct iovec iov = { byte, 1 };
    if (capacity > sizeof(c.buf)) { errno = EINVAL; return -1; }
    for (;;) {
        if (!ready(sock, POLLIN, deadline)) return -1;
        memset(&c, 0, sizeof(c));
        struct msghdr msg = {0};
        msg.msg_iov = &iov; msg.msg_iovlen = 1;
        msg.msg_control = c.buf; msg.msg_controllen = (socklen_t)capacity;
        result->recv_start = now_ns();
        ssize_t n = recvmsg(sock, &msg, MSG_DONTWAIT);
        result->recv_end = now_ns();
        result->recv_calls++;
        /* No recvmsg retry after an uncertain outcome: exit this process. */
        if (n < 0) { result->io_error = 1; return n; }
        /* Darwin echoes the requested nonblocking input flag. All other flags deny. */
        result->control = inspect_control(c.buf, msg.msg_controllen, capacity, msg.msg_flags & ~MSG_DONTWAIT);
        return n;
    }
}
/* Single supervisor, no signal reaper, no wait(-1), no detached timers. An
 * unreaped own child pins its PID; after waitpid succeeds we never signal it. */
static int reap_child(pid_t child, int *status, int timeout_ms) {
    long long deadline = now_ms() + timeout_ms;
    int killed = 0;
    for (;;) {
        pid_t result = waitpid(child, status, WNOHANG);
        if (result == child) return killed ? -1 : 0;
        if (result < 0 && errno != EINTR) return -1;
        if (now_ms() >= deadline) {
            if (killed) return -1; /* No success without proven termination. */
            if (kill(child, SIGKILL) && errno != ESRCH) return -1;
            killed = 1; deadline = now_ms() + 1000;
        }
        struct timespec pause = {0, 1000000}; (void)nanosleep(&pause, NULL);
    }
}
static void receiver(int sock, int output, const char *mode, uid_t peer_uid) {
    struct receiver_result result = {0};
    if (!strcmp(mode, "receiver-hang")) { for (;;) pause(); }
    if (!strcmp(mode, "ancillary-high")) {
        /* Deliberately occupy owned slots so installed rights exceed 1023.
         * These known duplicates are left to OS teardown, never swept by number. */
        int owned[1200]; size_t used = 0;
        do {
            if (used == sizeof(owned) / sizeof(owned[0])) _exit(1);
            owned[used] = fcntl(sock, F_DUPFD_CLOEXEC, 0);
            if (owned[used] < 0) _exit(77);
        } while (owned[used++] < 1100);
        puts("receiver_allocation_floor_above_1023=true");
    }
    if (!strcmp(mode, "receiver-error")) close(sock);
    char buf[65]; size_t used = 0;
    long long deadline = now_ms() + 1000;
    size_t capacity = !strcmp(mode, "ancillary-trunc-one") ? CMSG_LEN(0) :
        !strcmp(mode, "ancillary-trunc-two") ? CMSG_SPACE(sizeof(int)) : CMSG_SPACE(16 * sizeof(int));
    while (used < sizeof(buf) - 1) {
        ssize_t n = recv_checked(sock, buf + used, deadline, capacity, &result);
        if (result.control.rejected || n <= 0) break;
        if (buf[used++] == '\n') { result.complete = 1; break; }
        /* Test-only barrier proves the prefix was consumed in earlier receives. */
        if (!strcmp(mode, "ancillary-late") && used == 12) send_all(sock, "R", 1);
    }
    if (!strcmp(mode, "ancillary-high")) {
        /* Targeted observation only, never a cleanup inventory. The owned
         * reservation left 1101 as the next free slot before recvmsg. */
        struct stat installed;
        int flags = fcntl(1101, F_GETFL);
        int observed = flags >= 0 && (flags & O_ACCMODE) == O_WRONLY &&
            !fstat(1101, &installed) && S_ISFIFO(installed.st_mode);
        printf("high_installed_fd_observed=%s\n", observed ? "1101" : "missing");
        if (!observed) _exit(1);
    }
    if (result.control.rejected) printf("ancillary_rejected=true received_fds_closed=%d control_truncated=%s malformed=%s\n",
        result.control.closed, result.control.truncated ? "true" : "false", result.control.malformed ? "true" : "false");
    printf("frame_bytes=%zu frame_complete=%s recv_calls=%d receive_error=%s\n",
        used, result.complete ? "true" : "false", result.recv_calls, result.io_error ? "true" : "false");
    buf[used] = '\0';
    unsigned long claim; char tail;
    int parsed = result.complete && sscanf(buf, "claimed_uid=%lu%c", &claim, &tail) == 2 &&
        tail == '\n' && strchr(buf, '\n') == buf + used - 1;
    if (parsed) printf("claimed_uid=%lu untrusted=true\n", claim); else puts("message=rejected");
    printf("policy=%s\n", parsed && peer_uid == geteuid() ? "reject_same_uid" : "reject_unverified");
    /* A fixed-size local diagnostic, never an authorization response. */
    if (write(output, &result, sizeof(result)) != sizeof(result)) _exit(1);
    fflush(stdout);
    _exit(0); /* Includes every uncertain/invisible descriptor, at any number. */
}
static int connection_fixture(int listener, const struct sockaddr_un *addr, const char *mode) {
    int connected[2] = {-1, -1};
    if (listener < 0 && socketpair(AF_UNIX, SOCK_STREAM, 0, connected)) die("connected socketpair");
    if (listener < 0) { setupfd(connected[0]); setupfd(connected[1]); }
    int pair[2], lifetime[2], gate[2], report[2], sentinel[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) || pipe(lifetime) || pipe(gate) || pipe(report) || pipe(sentinel)) die("fixture descriptors");
    int known[] = {pair[0],pair[1],lifetime[0],lifetime[1],gate[0],gate[1],report[0],report[1],sentinel[0],sentinel[1]};
    for (size_t i = 0; i < sizeof(known)/sizeof(known[0]); i++) setupfd(known[i]);
    int high = -1;
    if (!strcmp(mode, "ancillary-high")) {
        struct rlimit limit;
        if (getrlimit(RLIMIT_NOFILE, &limit)) die("getrlimit");
        if (limit.rlim_cur < 2048) {
            limit.rlim_cur = limit.rlim_max < 2048 ? limit.rlim_max : 2048;
            if (setrlimit(RLIMIT_NOFILE, &limit)) { puts("high_fd_unavailable=true"); return 77; }
        }
        high = fcntl(lifetime[1], F_DUPFD_CLOEXEC, 1101);
        if (high < 0) { puts("high_fd_unavailable=true"); return 77; }
        printf("sender_high_fd=%d\n", high);
    }
    fflush(stdout); pid_t child = fork(); if (child < 0) die("fork client");
    if (child == 0) {
        close(listener); close(pair[0]); close(directory_fd);
        close(lifetime[0]); close(gate[1]); close(report[0]); close(report[1]); close(sentinel[0]); close(sentinel[1]);
        int client = connected[1];
        if (listener >= 0) {
            client = socket(AF_UNIX, SOCK_STREAM, 0); if (client < 0) die("client socket"); setupfd(client);
            if (connect(client, (const struct sockaddr *)addr, sizeof(*addr))) die("connect");
        } else close(connected[0]);
        uid_t uid; gid_t gid; snapshot(client, "client_sees_server", &uid, &gid);
        char go;
        if (!ready(gate[0], POLLIN, now_ms() + 1500) || read(gate[0], &go, 1) != 1) _exit(1);
        close(gate[0]);
        if (!strncmp(mode,"ancillary",9)) {
            if (!strcmp(mode, "ancillary-late")) {
                send_all(client, "claimed_uid=", 12);
                struct receiver_result ack = {0}; char byte;
                if (recv_checked(client, &byte, now_ms() + 1000, CMSG_SPACE(16 * sizeof(int)), &ack) != 1 ||
                    ack.control.rejected || byte != 'R') _exit(1);
            }
            size_t count = !strcmp(mode,"ancillary") || !strcmp(mode,"ancillary-trunc-one") || !strcmp(mode,"ancillary-late") ? 1 :
                !strcmp(mode,"ancillary-multi") || !strcmp(mode,"ancillary-trunc-two") ? 2 : 32;
            send_many_fds(client, high >= 0 ? high : lifetime[1], count);
        }
        else if (!strcmp(mode,"timeout")) sleep(2);
        else if (!strcmp(mode,"malformed")) send_all(client, "bad\n", 4);
        else if (!strcmp(mode,"oversized-frame")) { char bytes[128]; memset(bytes, 'X', sizeof(bytes)); send_all(client, bytes, sizeof(bytes)); }
        else if (strcmp(mode,"eof") && strcmp(mode,"receiver-hang") && strcmp(mode,"receiver-error")) {
            char msg[64]; int n = snprintf(msg, sizeof(msg), "claimed_uid=%u\n", !strcmp(mode,"spoof") ? (unsigned)(geteuid() + 1) : (unsigned)geteuid());
            if (n < 0 || (size_t)n >= sizeof(msg)) _exit(1);
            send_all(client, msg, (size_t)n);
        }
        close(lifetime[1]); if (high >= 0) close(high);
        if (!strcmp(mode,"transfer")) { int received = recv_fd(pair[1]); snapshot(received, "transferred_accepted_fd_sees_client", &uid, &gid); close(received); }
        close(client); close(pair[1]); fflush(stdout); _exit(0);
    }
    close(pair[1]); close(lifetime[1]); close(gate[0]);
    if (high >= 0) close(high);
    if (listener >= 0 && !ready(listener, POLLIN, now_ms() + 1000)) {
        int status; (void)reap_child(child, &status, 0); die("accept timeout");
    }
    int accepted = connected[0];
    if (listener >= 0) {
        long long deadline = now_ms() + 1000;
        do {
            if (!ready(listener, POLLIN, deadline)) break;
            accepted = accept(listener, NULL, NULL);
        } while (accepted < 0 && (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK));
    } else close(connected[1]);
    if (accepted < 0) { int status; (void)reap_child(child, &status, 0); die("accept"); }
    setupfd(accepted);
    uid_t uid; gid_t gid; snapshot(accepted, "server_accepted_sees_client", &uid, &gid);
    if (!strcmp(mode,"transfer")) send_fd(pair[0], accepted);
    fflush(stdout);
    pid_t worker = fork();
    if (worker < 0) { int status; (void)reap_child(child, &status, 0); die("fork receiver"); }
    if (worker == 0) {
        /* Explicit ownership inventory. No fd range scans, no service embedding.
         * The test launcher supplies only stdio; no unrelated launcher FDs. */
        close(listener); close(directory_fd); close(pair[0]); close(lifetime[0]);
        close(gate[1]); close(report[0]); close(sentinel[0]); close(sentinel[1]);
        receiver(accepted, report[1], mode, uid);
    }
    close(accepted); close(report[1]);
    /* Created after fork: the receiver cannot inherit this unrelated descriptor. */
    int concurrent = open("/dev/null", O_RDWR | O_CLOEXEC);
    if (concurrent < 0) die("concurrent unrelated open");
    if (write(gate[1], "G", 1) != 1) die("release sender");
    close(gate[1]);
    struct { long long start, end; } opens[65536];
    size_t open_count = 0;
    if (!strcmp(mode, "ancillary-concurrent")) {
        /* Real opens in the supervisor while a distinct receiver executes recvmsg.
         * Record actual syscall intervals; no sleep substitutes for concurrency. */
        long long deadline = now_ms() + 100;
        do {
            long long start = now_ns();
            int unrelated = open("/dev/null", O_RDWR | O_CLOEXEC);
            long long end = now_ns();
            if (unrelated < 0 || write(unrelated, "x", 1) != 1 || close(unrelated)) die("concurrent descriptor");
            opens[open_count].start = start; opens[open_count++].end = end;
        } while (open_count < sizeof(opens)/sizeof(opens[0]) && now_ms() < deadline);
    }
    int worker_status = 0, child_status = 0;
    int worker_ok = reap_child(worker, &worker_status, !strcmp(mode,"receiver-hang") ? 100 : 2000);
    int child_ok = reap_child(child, &child_status, 2500);
    int terminated = worker_ok == 0 && WIFEXITED(worker_status) && WEXITSTATUS(worker_status) == 0;
    if (!strcmp(mode,"receiver-hang")) {
        int killed = worker_ok < 0 && WIFSIGNALED(worker_status) && WTERMSIG(worker_status) == SIGKILL;
        printf("receiver_timeout_killed_and_reaped=%s authorization=false\n", killed ? "true" : "false");
        close(report[0]); close(lifetime[0]); close(concurrent); close(sentinel[0]); close(sentinel[1]); close(pair[0]); close(listener);
        if (cleanup_socket()) return 1;
        close(directory_fd);
        return killed && child_ok == 0 && WIFEXITED(child_status) && WEXITSTATUS(child_status) == 0 ? 0 : 1;
    }
    struct receiver_result result = {0};
    ssize_t bytes = -1;
    if (ready(report[0], POLLIN, now_ms() + 500)) bytes = read(report[0], &result, sizeof(result));
    close(report[0]);
    int overlap = 0;
    for (size_t i = 0; i < open_count; i++)
        if (opens[i].start < result.recv_end && opens[i].end > result.recv_start) overlap++;
    if (open_count) printf("concurrent_opens=%zu open_syscalls_overlapping_recvmsg=%d\n", open_count, overlap);
    /* EOF cannot occur until all copies of the transferred write end close,
     * including rights the truncated cmsg did not describe and queued rights. */
    char byte;
    int eof = ready(lifetime[0], POLLIN, now_ms() + 500) && read(lifetime[0], &byte, 1) == 0;
    int intact = write(sentinel[1], "S", 1) == 1 && read(sentinel[0], &byte, 1) == 1 && byte == 'S';
    int concurrent_intact = fcntl(concurrent, F_GETFD) >= 0 && write(concurrent, "x", 1) == 1;
    printf("receiver_terminated=%s transferred_pipe_eof=%s parent_fds_intact=%s concurrent_fd_intact=%s\n",
        terminated ? "true" : "false", eof ? "true" : "false", intact ? "true" : "false", concurrent_intact ? "true" : "false");
    puts("local_peerpid=unsupported ancillary_policy=deny production_authority=none authorization=false");
    close(lifetime[0]); close(sentinel[0]); close(sentinel[1]); close(concurrent); close(listener); close(pair[0]);
    if (cleanup_socket()) return 1;
    close(directory_fd);
    if (worker_ok == 0 && WIFEXITED(worker_status) && WEXITSTATUS(worker_status) == 77) {
        puts("high_fd_unavailable=true"); return 77;
    }
    int ancillary = !strncmp(mode,"ancillary",9);
    return terminated && bytes == sizeof(result) && eof && intact && concurrent_intact && child_ok == 0 &&
        WIFEXITED(child_status) && WEXITSTATUS(child_status) == 0 &&
        (ancillary ? result.control.rejected : !result.control.rejected) ? 0 : 1;
}

int main(int argc, char **argv) {
    if (argc != 3) { fprintf(stderr, "usage: peercred_probe DIR|--socketpair MODE; peercred_probe --control CASE\n"); return 2; }
    if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) die("signal");
    struct sigaction chld = {0}; chld.sa_handler = SIG_DFL;
    sigemptyset(&chld.sa_mask);
    if (sigaction(SIGCHLD, &chld, NULL)) die("SIGCHLD");
    setvbuf(stdout, NULL, _IOLBF, 0);
    const char *mode = argv[2];
    if (!strcmp(argv[1], "--control")) return control_fixture(mode);
    if (strcmp(mode,"normal") && strcmp(mode,"spoof") && strcmp(mode,"malformed") && strcmp(mode,"timeout") && strcmp(mode,"transfer") && strcmp(mode,"connect-fail") && strcmp(mode,"ancillary") && strcmp(mode,"ancillary-multi") && strcmp(mode,"ancillary-trunc") && strcmp(mode,"ancillary-trunc-one") && strcmp(mode,"ancillary-trunc-two") && strcmp(mode,"ancillary-high") && strcmp(mode,"ancillary-concurrent") && strcmp(mode,"ancillary-late") && strcmp(mode,"eof") && strcmp(mode,"receiver-hang") && strcmp(mode,"receiver-error") && strcmp(mode,"oversized-frame")) return 2;
    owner_pid = getpid();
    if (!strcmp(argv[1], "--socketpair")) return connection_fixture(-1, NULL, mode);
    struct stat st;
    char canonical[PATH_MAX], temp[PATH_MAX], parent[PATH_MAX];
    const char *tmp = getenv("TMPDIR");
    if (!tmp || !*tmp) tmp = "/tmp";
    if (!realpath(argv[1], canonical) || strcmp(canonical, argv[1]) ||
        !realpath(tmp, temp) || strlen(canonical) >= sizeof(directory_path)) {
        fprintf(stderr, "unsafe directory alias\n"); return 1;
    }
    strcpy(parent, canonical);
    char *slash = strrchr(parent, '/');
    if (!slash || slash == parent) { fprintf(stderr, "unsafe directory parent\n"); return 1; }
    *slash = '\0';
    if (strcmp(parent, temp) || !safe_ancestors(temp)) { fprintf(stderr, "unsafe directory parent or ancestor\n"); return 1; }
    strcpy(directory_path, canonical);
    if (lstat(canonical, &directory_identity) || !S_ISDIR(directory_identity.st_mode) ||
        directory_identity.st_uid != geteuid() || (directory_identity.st_mode & 07777) != 0700 ||
        directory_identity.st_nlink < 2) { fprintf(stderr,"unsafe directory\n"); return 1; }
    directory_fd = open(canonical, O_DIRECTORY | O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (directory_fd < 0 || !directory_valid()) { fprintf(stderr, "directory changed\n"); return 1; }
    if (atexit(cleanup_at_exit)) return 1;
    struct sockaddr_un addr = {0}; addr.sun_family = AF_UNIX;
    if (snprintf(addr.sun_path, sizeof(addr.sun_path), "%s/socket", argv[1]) >= (int)sizeof(addr.sun_path)) { fprintf(stderr,"socket path too long\n"); return 1; }
    int listener = socket(AF_UNIX, SOCK_STREAM, 0); if (listener < 0) die("socket"); setupfd(listener);
    if (!strcmp(mode,"connect-fail")) { if (connect(listener, (struct sockaddr *)&addr, sizeof(addr)) == 0) { fprintf(stderr,"unexpected connect\n"); return 1; } puts("connect_failure=observed"); close(listener); return 0; }
    if (!directory_valid() || !fstatat(directory_fd, "socket", &st, AT_SYMLINK_NOFOLLOW) || errno != ENOENT) { fprintf(stderr, "socket path unsafe\n"); return 1; }
    mode_t old = umask(077);
    int bound = bind(listener, (struct sockaddr *)&addr, sizeof(addr));
    umask(old);
    if (bound) die("bind");
    if (!directory_valid()) { fprintf(stderr, "directory changed after bind\n"); return 1; }
    if (fstatat(directory_fd, "socket", &socket_identity, AT_SYMLINK_NOFOLLOW)) die("socket stat after bind");
    if (!S_ISSOCK(socket_identity.st_mode) || socket_identity.st_uid != geteuid()) {
        fprintf(stderr, "socket identity unsafe after bind (mode=%o owner_matches=%s)\n",
            (unsigned)socket_identity.st_mode, socket_identity.st_uid == geteuid() ? "true" : "false"); return 1;
    }
    socket_owned = 1;
    /* Path-based mode changes have a same-UID replacement race; this is test-only. */
    if (!socket_valid() || fchmodat(directory_fd, "socket", 0600, 0) ||
        !socket_valid() || fstatat(directory_fd, "socket", &st, AT_SYMLINK_NOFOLLOW) ||
        !same_identity(&st, &socket_identity) || (st.st_mode & 07777) != 0600) {
        fprintf(stderr, "socket mode or identity unsafe\n"); return 1;
    }
    if (!socket_valid() || fstatat(directory_fd, "socket", &st, AT_SYMLINK_NOFOLLOW) ||
        (st.st_mode & 07777) != 0600 || listen(listener, 1) || !socket_valid()) die("listen/identity");
    if (fcntl(listener, F_SETFL, O_NONBLOCK)) die("nonblocking listener");
    printf("directory_mode=0700 socket_mode=%03o\n", (unsigned)(st.st_mode & 0777));
    return connection_fixture(listener, &addr, mode);
}
