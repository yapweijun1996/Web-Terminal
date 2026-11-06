#include <sys/types.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <stddef.h>

/* One-shot test fixture. Never expose this as a service. */
int main(int argc, char **argv) {
#ifndef __APPLE__
  (void)argc; (void)argv; fprintf(stderr, "ERR_UNSUPPORTED\n"); return 77;
#else
  if (argc != 3) return 64;
  char *end; errno = 0; unsigned long allowed = strtoul(argv[2], &end, 10);
  if (errno || *argv[2] == '\0' || *end || allowed > 0xffffffffUL) return 64;
  struct stat st; char path[sizeof(((struct sockaddr_un *)0)->sun_path)];
  if (strlen(argv[1]) >= sizeof(path)) return 64;
  strcpy(path, argv[1]); char *slash = strrchr(path, '/');
  if (!slash || slash == path) return 64; *slash = '\0';
  if (lstat(path, &st) || !S_ISDIR(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 07777) != 0700) { fprintf(stderr,"ERR_DIRECTORY\n"); return 65; }
  struct sockaddr_un addr = {0}; addr.sun_family = AF_UNIX; strcpy(addr.sun_path, argv[1]);
  int s = socket(AF_UNIX, SOCK_STREAM, 0); if (s < 0) { perror("ERR_SOCKET"); return 70; }
  umask(0177);
  if (bind(s, (struct sockaddr *)&addr, sizeof(addr)) || chmod(argv[1], 0600) || lstat(argv[1], &st) || !S_ISSOCK(st.st_mode) || st.st_uid != geteuid() || (st.st_mode & 07777) != 0600 || listen(s, 1)) { perror("ERR_LISTEN"); close(s); return 70; }
  puts("READY"); fflush(stdout);
  int c = accept(s, NULL, NULL); if (c < 0) { perror("ERR_ACCEPT"); close(s); return 70; }
  uid_t uid; gid_t gid;
  if (getpeereid(c, &uid, &gid)) { fprintf(stderr,"ERR_PEERCRED\n"); close(c); close(s); return 71; }
  fprintf(stderr, "PEER uid=%lu gid=%lu\n", (unsigned long)uid, (unsigned long)gid);
  if ((unsigned long)uid != allowed) { fprintf(stderr,"ERR_DENIED\n"); (void)write(c,"ERR_DENIED\n",11); close(c); close(s); return 72; }
  char buf[64]; size_t n = 0; char ch;
  while (n < sizeof(buf) && read(c, &ch, 1) == 1) { buf[n++] = ch; if (ch == '\n') break; }
  if (n != 5 || memcmp(buf, "echo\n", 5)) { (void)write(c,"ERR_FRAME\n",10); close(c); close(s); return 73; }
  (void)write(c,"OK echo\n",8); close(c); close(s); return 0;
#endif
}
