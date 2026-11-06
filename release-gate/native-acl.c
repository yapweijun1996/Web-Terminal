/* Read-only Darwin metadata probe. Never an authorization or ACL editor. */
#include <stdio.h>
#if defined(__APPLE__)
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <fcntl.h>
#include <membership.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <inttypes.h>

#define DEPTH 64
struct snapshot { struct stat st; int present; acl_t acl; char *text; };
struct pin { int fd; char *name; struct snapshot state; };
static struct pin chain[DEPTH];
static int count;

static void release(struct snapshot *s) {
    if (s->text) acl_free(s->text);
    if (s->acl) acl_free(s->acl);
}
static int snapshot(int fd, const char *name, struct snapshot *s) {
    memset(s, 0, sizeof(*s));
    filesec_t sec = filesec_init();
    if (!sec) return -1;
    int r = name ? lstatx_np(name, &s->st, sec) : fstatx_np(fd, &s->st, sec);
    if (!r) r = filesec_query_property(sec, FILESEC_ACL, &s->present);
    if (!r && s->present) {
        r = filesec_get_property(sec, FILESEC_ACL, &s->acl);
        if (!r && !s->acl) r = -1;
        if (!r) {
            ssize_t length = 0;
            s->text = acl_to_text(s->acl, &length);
            if (!s->text || length < 0 || length > 65536) r = -1;
        }
    }
    filesec_free(sec);
    return r;
}
static int same(const struct snapshot *a, const struct snapshot *b) {
    return a->st.st_dev == b->st.st_dev && a->st.st_ino == b->st.st_ino &&
        a->st.st_uid == b->st.st_uid && a->st.st_gid == b->st.st_gid &&
        a->st.st_mode == b->st.st_mode && a->st.st_flags == b->st.st_flags &&
        a->st.st_ctimespec.tv_sec == b->st.st_ctimespec.tv_sec &&
        a->st.st_ctimespec.tv_nsec == b->st.st_ctimespec.tv_nsec &&
        a->present == b->present && (!a->present || !strcmp(a->text, b->text));
}
static int number(const char *s, uint64_t *value) {
    if (!s || !*s || strlen(s) > 10) return -1;
    *value = 0;
    for (; *s; s++) { if (*s < '0' || *s > '9') return -1; *value = *value * 10 + (unsigned)(*s - '0'); }
    return !*value || *value >= UINT32_MAX ? -1 : 0;
}
static const char *ancestor(const struct snapshot *s, uid_t owner) {
    if (!S_ISDIR(s->st.st_mode)) return "WRONG_OBJECT";
    if (s->present) return "ANCESTOR_ACL_UNKNOWN";
    if (s->st.st_uid != 0 && s->st.st_uid != owner) return "UNSAFE_ANCESTOR";
    if ((s->st.st_mode & 0022) && !(s->st.st_uid == 0 && (s->st.st_mode & S_ISVTX))) return "UNSAFE_ANCESTOR";
    return NULL;
}
static const char *acl_reason(const struct snapshot *s, uid_t client, int backend) {
    if (!s->present) return backend ? "BACKEND_PRIVATE_METADATA" : "MISSING_ACL";
    if (backend) return "BACKEND_ACL_PRESENT";
    acl_entry_t entry;
    int n = 0, r = acl_get_entry(s->acl, ACL_FIRST_ENTRY, &entry);
    while (r == 0) {
        if (++n > 1) return "REPEATED_OR_EXTRA_ACE";
        acl_tag_t tag; acl_flagset_t flags; acl_permset_mask_t rights;
        if (acl_get_tag_type(entry, &tag) || acl_get_flagset_np(entry, &flags) ||
            acl_get_permset_mask_np(entry, &rights)) return "ACL_UNAVAILABLE";
        if (tag != ACL_EXTENDED_ALLOW) return "ACE_TYPE";
        const acl_flag_t forbidden[] = { ACL_ENTRY_INHERITED, ACL_ENTRY_FILE_INHERIT,
            ACL_ENTRY_DIRECTORY_INHERIT, ACL_ENTRY_LIMIT_INHERIT, ACL_ENTRY_ONLY_INHERIT };
        for (size_t i = 0; i < sizeof(forbidden)/sizeof(forbidden[0]); i++)
            if (acl_get_flag_np(flags, forbidden[i]) != 0) return "INHERITED_OR_FLAGGED_ACE";
        if (rights & (ACL_WRITE_SECURITY | ACL_CHANGE_OWNER)) return "ACL_OWNERSHIP_WRITE";
        void *uuid = acl_get_qualifier(entry);
        if (!uuid) return "PRINCIPAL_UNKNOWN";
        id_t id = 0; int type = -1;
        int mapped = mbr_uuid_to_id(uuid, &id, &type); acl_free(uuid);
        if (mapped || type != ID_TYPE_UID) return "GROUP_OR_UNKNOWN_PRINCIPAL";
        if (id != client) return "OTHER_UID";
        /* SDK sys/acl.h maps directory SEARCH to EXECUTE. It does not define
         * a socket CONNECT right. Do not translate model 'connect' to WRITE_DATA.
         * No positive native ACL fixture has been authorized for this candidate.
         */
        if (rights != ACL_SEARCH) return "AMBIGUOUS_RIGHTS";
        r = acl_get_entry(s->acl, ACL_NEXT_ENTRY, &entry);
    }
    /* Darwin acl_get_entry returns -1 at end as well as error. No end-of-list
     * assumption can authorize access here; all present ACLs remain untrusted. */
    return "UNKNOWN_NOT_AUTHORIZED";
}
int main(int argc, char **argv) {
    const char *reason = "ARGS"; struct snapshot *target = NULL;
    char copy[4096], pin[160] = ""; uint64_t owner = 0, client = 0;
    if (argc != 5 && argc != 6) goto done;
    if (number(argv[1], &owner) || number(argv[2], &client)) { reason = "UID"; goto done; }
    if (owner == client) { reason = "SAME_UID"; goto done; }
    int backend = !strcmp(argv[3], "backend"), socket_role = !strcmp(argv[3], "socket");
    if (!backend && !socket_role && strcmp(argv[3], "ingress-dir")) { reason = "ROLE"; goto done; }
    size_t len = strlen(argv[4]); reason = "PATH";
    if (len < 2 || len >= sizeof(copy) || argv[4][0] != '/' || argv[4][len-1] == '/') goto done;
    memcpy(copy, argv[4], len + 1);
    /* Validate all components before accessing any object. */
    for (char *p = copy + 1; *p;) {
        char *end = strchr(p, '/'); size_t size = end ? (size_t)(end-p) : strlen(p);
        if (!size || (size == 1 && p[0] == '.') || (size == 2 && !memcmp(p, "..", 2))) goto done;
        if (!end) break;
        p = end + 1;
    }
    for (size_t i = 0; i < len; i++) if ((unsigned char)copy[i] < 32 || (unsigned char)copy[i] == 127) goto done;
    chain[0].fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC); count = 1;
    reason = "STAT_UNAVAILABLE";
    if (chain[0].fd < 0 || snapshot(chain[0].fd, NULL, &chain[0].state)) goto done;
    reason = ancestor(&chain[0].state, (uid_t)owner); if (reason) goto done;
    char *part = copy + 1;
    for (;;) {
        char *slash = strchr(part, '/'); if (slash) *slash = '\0';
        if (count == DEPTH) { reason = "PATH_DEPTH"; goto done; }
        int parent = chain[count-1].fd;
        struct stat before;
        if (fstatat(parent, part, &before, AT_SYMLINK_NOFOLLOW)) { reason = "STAT_UNAVAILABLE"; goto done; }
        if (S_ISLNK(before.st_mode)) { reason = "SYMLINK"; goto done; }
        if ((!slash && socket_role) ? !S_ISSOCK(before.st_mode) : !S_ISDIR(before.st_mode)) { reason = "WRONG_OBJECT"; goto done; }
        struct pin *p = &chain[count]; p->name = part; p->fd = -1; count++;
        if (!slash && socket_role) {
            /* Unix sockets cannot be opened as regular files. Pin the parent,
             * inspect the relative link itself, then recheck; always deny socket
             * authorization until a descriptor-bound supervisor proof exists. */
            if (fchdir(parent) || snapshot(-1, part, &p->state)) { reason = "STAT_UNAVAILABLE"; goto done; }
        } else {
            p->fd = openat(parent, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
            if (p->fd < 0 || snapshot(p->fd, NULL, &p->state)) { reason = "STAT_UNAVAILABLE"; goto done; }
        }
        if (before.st_dev != p->state.st.st_dev || before.st_ino != p->state.st.st_ino) { reason = "PATH_RACE"; goto done; }
        if (!slash) { target = &p->state; break; }
        reason = ancestor(&p->state, (uid_t)owner); if (reason) goto done;
        part = slash + 1;
    }
    snprintf(pin, sizeof(pin), "%ju:%ju:%jd:%ld", (uintmax_t)target->st.st_dev,
        (uintmax_t)target->st.st_ino, (intmax_t)target->st.st_ctimespec.tv_sec, target->st.st_ctimespec.tv_nsec);
    if (argc == 6 && strcmp(pin, argv[5])) { reason = "PATH_RACE"; goto done; }
    if (target->st.st_uid != owner || (target->st.st_mode & 07777) != (socket_role ? 0600 : 0700)) { reason = "UNSAFE_OWNER_MODE"; goto done; }
    reason = acl_reason(target, (uid_t)client, backend);
    /* Recheck descriptor metadata/ACL and every directory binding, including
     * ancestors. A previous path pin is an observation, never a capability. */
    for (int i = 0; i < count; i++) {
        struct snapshot now;
        int failed = snapshot(chain[i].fd, chain[i].fd < 0 ? chain[i].name : NULL, &now);
        if (!failed) failed = !same(&now, &chain[i].state);
        release(&now);
        if (i > 0) {
            struct stat bound;
            if (fstatat(chain[i-1].fd, chain[i].name, &bound, AT_SYMLINK_NOFOLLOW) ||
                bound.st_dev != chain[i].state.st.st_dev || bound.st_ino != chain[i].state.st.st_ino) failed = 1;
        }
        if (failed) { reason = "PATH_RACE"; break; }
    }
done:;
    int acceptable = reason && !strcmp(reason, "BACKEND_PRIVATE_METADATA");
    printf("{\"classification\":\"%s\",\"reason\":\"%s\",\"productionAuthorization\":false",
        acceptable ? "METADATA_ONLY" : "DENIED", reason ? reason : "UNKNOWN_NOT_AUTHORIZED");
    if (target) printf(",\"uid\":%u,\"gid\":%u,\"mode\":%u,\"aclPresent\":%s,\"pin\":\"%s\"",
        target->st.st_uid, target->st.st_gid, target->st.st_mode & 07777, target->present ? "true" : "false", pin);
    puts("}");
    for (int i = 0; i < count; i++) { release(&chain[i].state); if (chain[i].fd >= 0) close(chain[i].fd); }
    return acceptable ? 0 : 1;
}
#else
int main(void) { puts("{\"classification\":\"DENIED\",\"reason\":\"UNSUPPORTED_PLATFORM\",\"productionAuthorization\":false}"); return 1; }
#endif
