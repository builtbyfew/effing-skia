//! A process-wide pool of native threads for async encoding.
//!
//! `AsyncTask` runs on libuv's threadpool, which every JS thread in the
//! process shares with fs, dns.lookup, zlib and crypto, and which has 4
//! threads unless `UV_THREADPOOL_SIZE` (read once, at process start) says
//! otherwise. Encoding is CPU-heavy, so on that pool it both caps how many
//! frames encode at once and makes unrelated I/O queue behind it. This pool
//! has one thread per core by default (`EFFING_SKIA_THREADS` overrides it),
//! and settles each promise on the JS thread that asked for the encode, which
//! may be a worker thread.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

use napi::bindgen_prelude::*;

type Job = Box<dyn FnOnce() + Send + 'static>;

const THREADS_ENV: &str = "EFFING_SKIA_THREADS";

struct Pool {
  sender: Mutex<Sender<Job>>,
  threads: usize,
}

static POOL: OnceLock<Pool> = OnceLock::new();

fn configured_threads() -> usize {
  std::env::var(THREADS_ENV)
    .ok()
    .and_then(|v| v.trim().parse::<usize>().ok())
    .filter(|n| *n > 0)
    .unwrap_or_else(|| thread::available_parallelism().map_or(4, |n| n.get()))
}

fn pool() -> &'static Pool {
  POOL.get_or_init(|| {
    let threads = configured_threads();
    let (sender, receiver) = channel::<Job>();
    let receiver = Arc::new(Mutex::new(receiver));
    for i in 0..threads {
      let receiver = receiver.clone();
      thread::Builder::new()
        .name(format!("skia-encode-{i}"))
        .spawn(move || {
          loop {
            // Hold the lock only while taking a job, not while running it.
            let job = match receiver.lock() {
              Ok(r) => r.recv(),
              Err(_) => return,
            };
            match job {
              Ok(job) => job(),
              Err(_) => return, // sender dropped: the process is exiting
            }
          }
        })
        .expect("failed to spawn skia encode thread");
    }
    Pool {
      sender: Mutex::new(sender),
      threads,
    }
  })
}

/// Number of threads that run async encodes (`encode()`, `toDataURLAsync()`,
/// `toBlob()`, `convertToBlob()`), starting them if needed: one per core
/// unless `EFFING_SKIA_THREADS` sets it. `UV_THREADPOOL_SIZE` doesn't affect it.
#[napi]
pub fn get_encode_threads() -> u32 {
  pool().threads as u32
}

/// Run `compute` on the encode pool, then settle the returned promise on the
/// calling JS thread: resolved with `resolve(env, output)`, or rejected with
/// `compute`'s error. A panic in `compute` rejects the promise instead of
/// taking down the pool thread.
pub(crate) fn spawn<'env, Output, Data, Compute, Resolve>(
  env: &'env Env,
  compute: Compute,
  resolve: Resolve,
) -> Result<Object<'env>>
where
  Output: Send + 'static,
  Data: ToNapiValue + 'static,
  Compute: FnOnce() -> Result<Output> + Send + 'static,
  Resolve: FnOnce(Env, Output) -> Result<Data> + Send + 'static,
{
  type Resolver<Data> = Box<dyn FnOnce(Env) -> Result<Data> + Send>;
  let (deferred, promise) = env.create_deferred::<Data, Resolver<Data>>()?;
  let job: Job = Box::new(move || match catch_unwind(AssertUnwindSafe(compute)) {
    Ok(Ok(output)) => deferred.resolve(Box::new(move |env| resolve(env, output))),
    Ok(Err(err)) => deferred.reject(err),
    Err(panic) => {
      let reason = panic
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_owned());
      deferred.reject(Error::new(
        Status::GenericFailure,
        format!("encode panicked: {reason}"),
      ));
    }
  });
  pool()
    .sender
    .lock()
    .map_err(|_| Error::new(Status::GenericFailure, "encode pool poisoned"))?
    .send(job)
    .map_err(|_| Error::new(Status::GenericFailure, "encode pool stopped"))?;
  Ok(promise)
}
