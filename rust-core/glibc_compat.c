/**
 * GLIBC compatibility stubs for Ubuntu 22.04 (GLIBC 2.35).
 *
 * The ONNX Runtime pre-built library references GLIBC 2.38/2.39 symbols.
 * These stubs redirect to older equivalents so the binary works on
 * systems with GLIBC >= 2.17.
 *
 * Symbols:
 *   __isoc23_strtol   (GLIBC 2.38) → strtol
 *   __isoc23_strtoll  (GLIBC 2.38) → strtoll
 *   __isoc23_strtoull (GLIBC 2.38) → strtoull
 *   pidfd_getpid      (GLIBC 2.39) → stub returning -ENOSYS
 *   pidfd_spawnp      (GLIBC 2.39) → stub returning -ENOSYS
 */

#include <stdlib.h>
#include <errno.h>

/* C23 strtol variants — identical behavior for valid inputs */
long __isoc23_strtol(const char *nptr, char **endptr, int base) {
    return strtol(nptr, endptr, base);
}

long long __isoc23_strtoll(const char *nptr, char **endptr, int base) {
    return strtoll(nptr, endptr, base);
}

unsigned long long __isoc23_strtoull(const char *nptr, char **endptr, int base) {
    return strtoull(nptr, endptr, base);
}

/* pidfd syscall wrappers — not available on older kernels, return ENOSYS */
int pidfd_getpid(int pidfd) {
    (void)pidfd;
    errno = ENOSYS;
    return -1;
}

int pidfd_spawnp(int *pidfd, const char *path,
                 const void *file_actions,
                 const void *attrp,
                 char *const argv[],
                 char *const envp[]) {
    (void)pidfd; (void)path; (void)file_actions;
    (void)attrp; (void)argv; (void)envp;
    errno = ENOSYS;
    return -1;
}
