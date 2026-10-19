//! Small synchronization helpers shared by the watcher and the serve loop.

use std::sync::{Mutex, MutexGuard};

/// Lock a mutex, recovering from poisoning instead of propagating the panic.
///
/// A poisoned mutex means another thread panicked while holding the lock.
/// Both the watcher thread and the serve loop (which catches handler panics
/// with `catch_unwind`) must keep working after a single transient panic,
/// otherwise every later request or re-index fails until a restart.
pub fn lock_recover<'a, T>(mutex: &'a Mutex<T>, label: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            tracing::warn!(
                "{} mutex was poisoned by a prior panic — recovering and continuing",
                label
            );
            poisoned.into_inner()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_recover_returns_guard_after_poison() {
        let m = std::sync::Arc::new(std::sync::Mutex::new(1));
        let m2 = m.clone();
        let _ = std::thread::spawn(move || {
            let _g = m2.lock().unwrap();
            panic!("poison");
        })
        .join();
        assert!(m.lock().is_err());
        assert_eq!(*lock_recover(&m, "test"), 1);
    }
}
