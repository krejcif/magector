use std::env;

fn main() {
    // Compile GLIBC compatibility stubs for older Linux distributions.
    // Only needed on Linux — skipped on macOS/Windows.
    if env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() == "linux" {
        cc::Build::new()
            .file("glibc_compat.c")
            .compile("glibc_compat");
    }
}
