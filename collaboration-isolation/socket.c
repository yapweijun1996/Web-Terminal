#include "socket.h"
#if defined(__APPLE__)
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/file.h>
#include <sys/acl.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static const char socket_name[] = "gateway.sock";
static volatile sig_atomic_t stopped;
static void stop_handler(int sig) { (void)sig; stopped = 1; }
static int error(const char *message, int code) { fprintf(stderr, "%s\n", message); return code; }

int candidate_signals(void) {
    struct sigaction action = {0};
    action.sa_handler = stop_handler;
    if (sigemptyset(&action.sa_mask) || sigaction(SIGTERM, &action, NULL) ||
        sigaction(SIGINT, &action, NULL)) return error("ERR_SIGNAL", 71);
    action.sa_handler = SIG_IGN;
    if (sigaction(SIGPIPE, &action, NULL)) return error("ERR_SIGNAL", 71);
    return 0;
}

int parse_uid(const char *text, uid_t *uid) {
    uint64_t n = 0;
    if (!text || !*text || strlen(text) > 10) return error("ERR_UID", 64);
    for (const char *p = text; *p; p++) {
        if (*p < '0' || *p > '9') return error("ERR_UID", 64);
        n = n * 10 + (unsigned)(*p - '0');
        if (n >= UINT32_MAX) return error("ERR_UID", 64);
    }
    if (!n || (uint64_t)(uid_t)n != n) return error("ERR_UID", 64);
    *uid = (uid_t)n;
    return 0;
}

/* A successful extended stat plus an absent ACL property proves absence.
 * A NULL acl_get_fd_np alone is ambiguous (ENOENT is also used for no ACL).
 * Never treat an ACL lookup error as permission to proceed. No ACLs are set.
 */
static int secure_stat(int fd, const char *name, struct stat *st) {
    filesec_t sec = filesec_init();
    if (!sec) return -1;
    int present = -1;
    int r = name ? lstatx_np(name, st, sec) : fstatx_np(fd, st, sec);
    if (!r) r = filesec_query_property(sec, FILESEC_ACL, &present);
    if (!r && present) {
        /* Even empty or deny-only ACLs are outside this candidate's contract. */
        r = -1;
    }
    filesec_free(sec);
    return r;
}

static int same_inode(const struct stat *a, const struct stat *b) {
    return a->st_dev == b->st_dev && a->st_ino == b->st_ino;
}
static int directory_ok(int fd, struct stat *st, int final) {
    if (secure_stat(fd, NULL, st) || !S_ISDIR(st->st_mode)) return -1;
    if (final) return st->st_uid == geteuid() && (st->st_mode & 07777) == 0700 ? 0 : -1;
    if (st->st_uid != 0 && st->st_uid != geteuid()) return -1;
    /* Writable ancestors must be root-owned and sticky (e.g. /private/tmp).
     * Child directories remain pinned by descriptors and cannot be replaced by C.
     */
    if (st->st_mode & 0022)
        return st->st_uid == 0 && (st->st_mode & S_ISVTX) ? 0 : -1;
    return 0;
}

static int open_directory(const char *path, struct stat *identity) {
    char copy[sizeof(((struct sockaddr_un *)0)->sun_path)];
    size_t n = strlen(path);
    if (n < 2 || n + sizeof(socket_name) + 1 >= sizeof(copy) || path[0] != '/' ||
        path[n - 1] == '/') return error("ERR_PATH", -1);
    memcpy(copy, path, n + 1);
    /* Reject normalization rather than resolving symlinks or traversal. */
    for (size_t i = 1; i <= n; i++) {
        if (copy[i] == '/' && copy[i - 1] == '/') return error("ERR_PATH", -1);
    }
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return error("ERR_PATH", -1);
    if (directory_ok(fd, identity, 0)) { close(fd); return error("ERR_DIRECTORY", -1); }
    char *part = copy + 1;
    for (;;) {
        char *slash = strchr(part, '/');
        if (slash) *slash = '\0';
        if (!strcmp(part, ".") || !strcmp(part, "..") || !*part) {
            close(fd); return error("ERR_PATH", -1);
        }
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        close(fd);
        if (next < 0) return error("ERR_PATH", -1);
        fd = next;
        if (directory_ok(fd, identity, !slash)) {
            close(fd); return error("ERR_DIRECTORY", -1);
        }
        if (!slash) break;
        part = slash + 1;
    }
    return fd;
}

static int state_ok(struct listener *s) {
    struct stat d, st;
    if (directory_ok(s->directory, &d, 1) || !same_inode(&d, &s->dir_identity) ||
        secure_stat(-1, socket_name, &st) || !same_inode(&st, &s->socket_identity) ||
        !S_ISSOCK(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 07777) != 0600)
        return error("ERR_STATE", 71);
    return 0;
}

void listener_close(struct listener *s) {
    if (s->fd >= 0) { close(s->fd); s->fd = -1; }
    if (s->directory >= 0) {
        struct stat st;
        /* Never delete a stale or replaced socket owned by another listener. */
        if (s->owns_socket && !fstatat(s->directory, socket_name, &st, AT_SYMLINK_NOFOLLOW) &&
            same_inode(&st, &s->socket_identity)) unlinkat(s->directory, socket_name, 0);
        close(s->directory); s->directory = -1;
    }
}

int listener_open(struct listener *s, const char *directory) {
    memset(s, 0, sizeof(*s)); s->fd = -1; s->directory = -1;
    umask(0077);
    s->directory = open_directory(directory, &s->dir_identity);
    if (s->directory < 0) return -1;
    if (flock(s->directory, LOCK_EX | LOCK_NB)) {
        error("ERR_LOCK", 71); goto fail;
    }
    int duplicate = dup(s->directory);
    if (duplicate < 0) { error("ERR_DIRECTORY", 71); goto fail; }
    DIR *stream = fdopendir(duplicate);
    if (!stream) { close(duplicate); error("ERR_DIRECTORY", 71); goto fail; }
    struct dirent *entry; int empty = 1;
    errno = 0;
    while ((entry = readdir(stream))) {
        if (strcmp(entry->d_name, ".") && strcmp(entry->d_name, "..")) { empty = 0; break; }
    }
    int read_error = errno; closedir(stream);
    if (!empty || read_error) { error("ERR_NOT_EMPTY", 71); goto fail; }
    /* Bind relative to the pinned private directory, never a re-resolved path. */
    if (fchdir(s->directory)) { error("ERR_DIRECTORY", 71); goto fail; }
    s->fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (s->fd < 0 || fcntl(s->fd, F_SETFD, FD_CLOEXEC) || fcntl(s->fd, F_SETFL, O_NONBLOCK)) {
        error("ERR_SOCKET", 71); goto fail;
    }
    struct sockaddr_un address = {0}; address.sun_family = AF_UNIX;
    memcpy(address.sun_path, socket_name, sizeof(socket_name));
    address.sun_len = sizeof(address);
    if (bind(s->fd, (struct sockaddr *)&address, sizeof(address))) {
        fprintf(stderr, "ERR_BIND errno=%d\n", errno); goto fail;
    }
    if (lstat(socket_name, &s->socket_identity)) { error("ERR_SOCKET_STATE", 71); goto fail; }
    s->owns_socket = 1;
    /* umask creates 0700 on Darwin; reduce to 0600 before listen. */
    if (chmod(socket_name, 0600) || state_ok(s) || listen(s->fd, 4)) {
        error("ERR_SOCKET_STATE", 71); goto fail;
    }
    return 0;
fail:
    listener_close(s); return -1;
}

static int64_t milliseconds(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now)) return -1;
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}
static int wait_fd(int fd, short events, int64_t deadline) {
    for (;;) {
        int64_t now = milliseconds();
        if (now < 0 || stopped || now >= deadline) return -1;
        struct pollfd p = { .fd = fd, .events = events };
        int r = poll(&p, 1, (int)(deadline - now));
        if (r > 0) return (p.revents & (events | POLLHUP)) && !(p.revents & (POLLERR | POLLNVAL)) ? 0 : -1;
        if (r < 0 && errno == EINTR) continue;
        return -1;
    }
}

int listener_ping(struct listener *s, uid_t expected) {
    if (wait_fd(s->fd, POLLIN, milliseconds() + 3000)) return error("ERR_TIMEOUT", 74);
    int fd = accept(s->fd, NULL, NULL);
    if (fd < 0) return error("ERR_ACCEPT", 71);
    int result = 71;
    uid_t uid = (uid_t)-1; gid_t gid = (gid_t)-1;
    if (fcntl(fd, F_SETFD, FD_CLOEXEC) || fcntl(fd, F_SETFL, O_NONBLOCK)) goto done;
    if (getpeereid(fd, &uid, &gid) || uid == (uid_t)-1 || gid == (gid_t)-1) {
        error("ERR_PEERCRED", 71); goto done;
    }
    fprintf(stderr, "PEER uid=%u gid=%u\n", (unsigned)uid, (unsigned)gid);
    if (uid != expected) { result = error("ERR_DENIED", 72); goto done; }
    if (state_ok(s)) goto done;
    /* EOF is part of the frame. Read at most one fixed 38-byte ping plus one
     * overflow byte; a single absolute deadline defeats slow drip clients.
     */
    char frame[39]; size_t length = 0;
    int64_t deadline = milliseconds() + 1000;
    for (;;) {
        if (length == sizeof(frame)) { result = error("ERR_FRAME", 73); goto done; }
        if (wait_fd(fd, POLLIN, deadline)) { result = error("ERR_TIMEOUT", 74); goto done; }
        ssize_t n = read(fd, frame + length, sizeof(frame) - length);
        if (n == 0) break;
        if (n < 0) {
            if (errno == EINTR || errno == EAGAIN) continue;
            result = error("ERR_FRAME", 73); goto done;
        }
        length += (size_t)n;
    }
    if (length != 38 || memcmp(frame, "PING ", 5) || frame[37] != '\n') {
        result = error("ERR_FRAME", 73); goto done;
    }
    for (unsigned i = 5; i < 37; i++) {
        if (!((frame[i] >= '0' && frame[i] <= '9') || (frame[i] >= 'a' && frame[i] <= 'f'))) {
            result = error("ERR_FRAME", 73); goto done;
        }
    }
    if (state_ok(s)) goto done;
    char reply[128];
    int size = snprintf(reply, sizeof(reply), "PONG %.*s UID %u GID %u\n", 32, frame + 5,
                        (unsigned)uid, (unsigned)gid);
    if (size < 0 || (size_t)size >= sizeof(reply)) goto done;
    size_t sent = 0;
    while (sent < (size_t)size) {
        if (wait_fd(fd, POLLOUT, deadline)) { result = error("ERR_TIMEOUT", 74); goto done; }
        ssize_t n = write(fd, reply + sent, (size_t)size - sent);
        if (n < 0 && (errno == EINTR || errno == EAGAIN)) continue;
        if (n <= 0) goto done;
        sent += (size_t)n;
    }
    result = 0;
done:
    close(fd); return result;
}
#endif
