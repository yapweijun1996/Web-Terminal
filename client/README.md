# Browser client source

This is a reconstruction of the current Mac browser client for isolated development. The upstream ttyd 1.7.7 `html` source and Yarn lockfile were taken from commit `40e79c706be14029b391f369bee6613c31667abb`; see [UPSTREAM-LICENSE](UPSTREAM-LICENSE). The local custom toolbar, image upload interface, viewport setting, and reconnect behavior have been recovered into editable files. The generated HTML is not checked in.

See the [source inventory](../docs/source-inventory.md) for the provenance, exclusions, and verification limits.

An isolated build of the unmodified upstream source produced the same SHA-256 as the page served by the installed stock ttyd 1.7.7. This establishes its upstream baseline; it does not by itself establish complete parity between the reconstructed custom page and the live custom page.

## Build

The recorded development environment used Node.js 23.10.0 and Corepack with Yarn 3.6.3. From this directory:

```sh
corepack yarn install --immutable --mode=skip-build
corepack yarn inline
```

The output is `dist/inline.html`. The lockfile fixes the dependency graph; verify a clean install and compare output when changing toolchain versions. Upstream's legacy dependencies emit warnings and require a separate upgrade assessment. From the repository root, run `node --test tests/*.test.js` for the local runtime and macOS upload fixture tests.

## Runtime boundary

The scripts in `../runtime` are an isolated development candidate and require explicit per-host environment values. `serve.sh` requires an owned, private runtime directory and refuses an existing socket instead of removing it. The observed ttyd creates a `0660` socket; the `0700` parent directory prevents other users from traversing to it, and same-user processes remain trusted. Recheck permissions and ACLs on the target host. The scripts are not installed into, or automatically synchronized with, the existing Mac service. Do not expose the writable ttyd socket to untrusted clients: establish and independently verify Cloudflare Access, origin-side token validation, socket permissions, and session preservation before any authorized deployment. Never put live hostnames, identities, credentials, uploads, or logs into this repository.
