# Native filesystem metadata FFI

Small safe wrapper around macOS descriptor-based ACL inspection. It compares
the public serialized ACL representation with an empty ACL, including ACL-level
flags. Failures remain errors; they never mean the file has no ACL.

The platform writer uses this check before staging and publication to reject
metadata it cannot preserve. `macos.rs` owns the entire unsafe boundary: a
borrowed file descriptor, bounded allocation, and single-owner ACL cleanup.
There are no desktop frameworks, TCC calls, network operations, or dependencies.

Apple's [ACL getter](https://github.com/apple-oss-distributions/Libc/blob/main/posix1e/acl_file.c)
uses [filesec_get_property](https://github.com/apple-oss-distributions/Libc/blob/main/gen/filesec.c),
which reports ENOENT for a missing ACL property. This is distinguished from
other retrieval failures and checked against the still-open file descriptor.

Verification lives in the platform's APFS transactional-write tests:
`cargo test -p opengeni-agent-platform transactional_write` on macOS.
