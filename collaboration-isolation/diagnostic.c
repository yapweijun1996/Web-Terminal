#include <stdio.h>
#include "socket.h"
#if defined(__APPLE__)
#include <unistd.h>
int main(int argc, char **argv) {
    uid_t expected;
    struct listener s;
    if (argc != 3) { fputs("ERR_ARGS\n", stderr); return 64; }
    if (parse_uid(argv[2], &expected)) return 64;
    if (getuid() != geteuid() || geteuid() == 0) {
        fputs("ERR_START_IDENTITY\n", stderr); return 70;
    }
    if (candidate_signals()) return 71;
    if (listener_open(&s, argv[1])) return 71;
    puts("READY DIAGNOSTIC ONE_SHOT MOCK_ONLY"); fflush(stdout);
    int result = listener_ping(&s, expected);
    listener_close(&s);
    return result;
}
#else
int main(void) { fputs("ERR_UNSUPPORTED\n", stderr); return 77; }
#endif
