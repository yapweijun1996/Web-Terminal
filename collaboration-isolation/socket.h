#ifndef COLLABORATION_ISOLATION_SOCKET_H
#define COLLABORATION_ISOLATION_SOCKET_H
#if defined(__APPLE__)
#include <sys/types.h>
#include <sys/stat.h>
struct listener {
    int fd;
    int directory;
    struct stat dir_identity;
    struct stat socket_identity;
    int owns_socket;
};
int parse_uid(const char *text, uid_t *uid);
int listener_open(struct listener *s, const char *directory);
int listener_ping(struct listener *s, uid_t expected);
void listener_close(struct listener *s);
int candidate_signals(void);
#endif
#endif
