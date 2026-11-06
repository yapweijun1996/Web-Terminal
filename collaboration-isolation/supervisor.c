#include <stdio.h>
#include "socket.h"
#if defined(__APPLE__)
#include <unistd.h>
int main(int argc, char **argv) {
    uid_t client;
    struct listener s;
    if (argc != 3) { fputs("ERR_ARGS\n", stderr); return 64; }
    if (parse_uid(argv[2], &client)) return 64;
    /* No flag, environment variable, or diagnostic policy can bypass this. */
    if (client == geteuid()) { fputs("ERR_SAME_UID\n", stderr); return 70; }
    if (getuid() != geteuid() || geteuid() == 0) {
        fputs("ERR_START_IDENTITY\n", stderr); return 70;
    }
    if (candidate_signals()) return 71;
    if (listener_open(&s, argv[1])) return 71;
    puts("READY ENFORCEMENT MOCK_ONLY"); fflush(stdout);
    int result = 0;
    for (unsigned i = 0; i < 16; i++) {
        int r = listener_ping(&s, client);
        if (r == 71 || r == 74) { result = r; break; }
    }
    listener_close(&s);
    return result;
}
#else
int main(void) { fputs("ERR_UNSUPPORTED\n", stderr); return 77; }
#endif
